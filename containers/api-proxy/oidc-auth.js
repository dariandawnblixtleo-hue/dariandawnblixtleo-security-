'use strict';

/**
 * OIDC authentication token manager.
 *
 * Supports GitHub Actions OIDC → Azure AD workload identity federation.
 * Fetches a short-lived GitHub OIDC JWT, exchanges it for an Azure AD Bearer
 * token, caches it, and proactively refreshes before expiry.
 *
 * Required environment variables (when AWF_AUTH_TYPE=github-oidc):
 *   AWF_AUTH_TYPE                  - Must be 'github-oidc'
 *   AWF_AUTH_AUDIENCE              - OIDC audience (default: 'api://AzureADTokenExchange')
 *   AWF_AZURE_TENANT_ID            - Azure AD tenant ID
 *   AWF_AZURE_CLIENT_ID            - Azure AD application (client) ID
 *   AWF_AZURE_SCOPE                - OAuth2 scope
 *                                    (default: 'https://cognitiveservices.azure.com/.default')
 *   ACTIONS_ID_TOKEN_REQUEST_URL   - GitHub Actions OIDC endpoint URL
 *   ACTIONS_ID_TOKEN_REQUEST_TOKEN - Bearer token to call the OIDC endpoint
 *
 * Required domain allow-list entries (Squid must permit these):
 *   - The hostname in ACTIONS_ID_TOKEN_REQUEST_URL (e.g. pipelines.actions.githubusercontent.com)
 *   - login.microsoftonline.com
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { logRequest } = require('./logging');

/** Default OIDC audience for Azure AD federated credentials */
const DEFAULT_AUDIENCE = 'api://AzureADTokenExchange';

/** Default scope for Azure Cognitive Services (Azure OpenAI) */
const DEFAULT_AZURE_SCOPE = 'https://cognitiveservices.azure.com/.default';

/** Refresh the token this many milliseconds before it expires */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum delay between refresh attempts (prevents hot-looping on errors) */
const MIN_REFRESH_DELAY_MS = 30 * 1000; // 30 seconds

/** Retry delay (in seconds) when a proactive refresh fails */
const REFRESH_RETRY_DELAY_S = 65;

/** Timeout for OIDC / Azure AD HTTP requests */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Make an HTTP/HTTPS request, optionally routing through a proxy agent.
 * Returns the parsed JSON body or throws on non-2xx or parse failure.
 *
 * @param {string} urlStr
 * @param {'GET'|'POST'} method
 * @param {Record<string,string>} reqHeaders
 * @param {string|null} body - Form-encoded body for POST, null for GET
 * @param {object|undefined} proxyAgent - Optional HTTPS proxy agent
 * @returns {Promise<object>}
 */
function makeJsonRequest(urlStr, method, reqHeaders, body, proxyAgent) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const headers = { ...reqHeaders, 'Accept': 'application/json' };
    if (body) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${bodyStr.substring(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(bodyStr));
        } catch (err) {
          reject(new Error(`Failed to parse JSON response: ${err.message}`));
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

/**
 * OIDC token manager: fetches a GitHub Actions OIDC JWT and exchanges it for an
 * Azure AD access token via workload identity federation (federated credentials).
 *
 * Token lifecycle:
 *   1. On `start()`, the initial token is fetched synchronously (with await).
 *   2. A timer schedules a proactive refresh (REFRESH_BUFFER_MS before expiry).
 *   3. `getToken()` returns the cached token or waits for an in-flight refresh.
 *   4. `stop()` cancels any pending timers.
 */
class OidcTokenManager {
  /**
   * @param {Record<string,string|undefined>} env - Environment variables
   * @param {object} [opts]
   * @param {object} [opts.proxyAgent] - Optional HTTPS proxy agent (e.g. HttpsProxyAgent)
   */
  constructor(env, { proxyAgent } = {}) {
    this._authType = (env.AWF_AUTH_TYPE || '').trim();
    this._audience = (env.AWF_AUTH_AUDIENCE || DEFAULT_AUDIENCE).trim();
    this._tenantId = (env.AWF_AZURE_TENANT_ID || '').trim();
    this._clientId = (env.AWF_AZURE_CLIENT_ID || '').trim();
    this._scope    = (env.AWF_AZURE_SCOPE || DEFAULT_AZURE_SCOPE).trim();
    this._oidcUrl   = (env.ACTIONS_ID_TOKEN_REQUEST_URL || '').trim();
    this._oidcToken = (env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '').trim();
    this._proxyAgent = proxyAgent;

    /** @type {string|null} - Currently cached Azure AD access token */
    this._token = null;
    /** @type {number|null} - Unix ms timestamp when the cached token expires */
    this._expiresAt = null;
    /** @type {NodeJS.Timeout|null} */
    this._refreshTimer = null;
    /** @type {Promise<string>|null} - Deduplicates concurrent refresh calls */
    this._pendingFetch = null;
  }

  /**
   * Returns true when all required env vars are present and `AWF_AUTH_TYPE=github-oidc`.
   * @returns {boolean}
   */
  isEnabled() {
    return (
      this._authType === 'github-oidc' &&
      !!this._oidcUrl &&
      !!this._oidcToken &&
      !!this._tenantId &&
      !!this._clientId
    );
  }

  /**
   * Returns the cached token synchronously (may be null before `start()` completes).
   * @returns {string|null}
   */
  getCachedToken() {
    return this._token;
  }

  /**
   * Returns the current valid token.
   * If the cached token is still valid, resolves immediately.
   * Otherwise, triggers a refresh and waits for it to complete.
   *
   * @returns {Promise<string>}
   */
  async getToken() {
    if (this._token && this._expiresAt && Date.now() < this._expiresAt) {
      return this._token;
    }
    return this._doRefresh();
  }

  /**
   * Fetch the initial token and start the proactive refresh loop.
   * Logs a warning (but does not throw) if the initial fetch fails, so that
   * the rest of the server can still start up.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!this.isEnabled()) {
      logRequest('debug', 'oidc_auth', {
        message: 'OIDC auth not enabled',
        auth_type: this._authType || '(not set)',
      });
      return;
    }

    logRequest('info', 'oidc_auth', {
      message: 'Starting OIDC token manager',
      auth_type: this._authType,
      audience: this._audience,
      tenant_id: this._tenantId,
      client_id: this._clientId,
      scope: this._scope,
    });

    try {
      await this._doRefresh();
    } catch (err) {
      logRequest('warn', 'oidc_auth', {
        message: 'Initial OIDC token fetch failed; will retry on next request',
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  /**
   * Cancel any pending refresh timer (call on graceful shutdown).
   */
  stop() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Trigger a token refresh. Deduplicates concurrent callers so only one
   * in-flight HTTP exchange is in progress at a time.
   *
   * @returns {Promise<string>}
   */
  _doRefresh() {
    if (this._pendingFetch) return this._pendingFetch;

    this._pendingFetch = this._fetchAndCache()
      .then((token) => {
        this._pendingFetch = null;
        return token;
      })
      .catch((err) => {
        this._pendingFetch = null;
        throw err;
      });

    return this._pendingFetch;
  }

  /**
   * Perform the full GitHub OIDC → Azure AD exchange, update cached values,
   * and schedule the next proactive refresh.
   *
   * @returns {Promise<string>} - The new access token
   */
  async _fetchAndCache() {
    const githubToken = await this._fetchGitHubOidcToken();
    const result = await this._exchangeForAzureToken(githubToken);

    this._token    = result.token;
    this._expiresAt = result.expiresAt;

    logRequest('info', 'oidc_auth', {
      message: 'Azure AD token acquired via GitHub OIDC federation',
      expires_in_s: result.expiresIn,
      token_type: result.tokenType,
    });

    this._scheduleRefresh(result.expiresIn);
    return this._token;
  }

  /**
   * Fetch a GitHub Actions OIDC JWT from the runner-provided OIDC endpoint.
   *
   * @returns {Promise<string>} - The OIDC JWT string
   */
  async _fetchGitHubOidcToken() {
    const url = new URL(this._oidcUrl);
    url.searchParams.set('audience', this._audience);

    logRequest('debug', 'oidc_auth', {
      message: 'Fetching GitHub OIDC token',
      audience: this._audience,
    });

    const data = await makeJsonRequest(
      url.toString(),
      'GET',
      { 'Authorization': `Bearer ${this._oidcToken}` },
      null,
      this._proxyAgent
    );

    if (!data || typeof data.value !== 'string') {
      throw new Error(`Unexpected OIDC token response: missing 'value' field`);
    }

    return data.value;
  }

  /**
   * Exchange a GitHub OIDC JWT for an Azure AD access token using the
   * client_credentials + client_assertion (federated identity) flow.
   *
   * @param {string} githubToken - GitHub OIDC JWT
   * @returns {Promise<{ token: string, expiresAt: number, expiresIn: number, tokenType: string }>}
   */
  async _exchangeForAzureToken(githubToken) {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(this._tenantId)}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      grant_type:            'client_credentials',
      client_id:             this._clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion:      githubToken,
      scope:                 this._scope,
    });

    logRequest('debug', 'oidc_auth', {
      message: 'Exchanging GitHub OIDC token for Azure AD token',
      tenant_id: this._tenantId,
      client_id: this._clientId,
      scope:     this._scope,
    });

    const data = await makeJsonRequest(
      tokenUrl,
      'POST',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      params.toString(),
      this._proxyAgent
    );

    if (!data || typeof data.access_token !== 'string') {
      const errDesc = data && data.error_description
        ? data.error_description
        : (data && data.error ? data.error : 'missing access_token');
      throw new Error(`Azure AD token exchange failed: ${errDesc}`);
    }

    const expiresIn  = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    const expiresAt  = Date.now() + expiresIn * 1000;

    return {
      token:     data.access_token,
      expiresAt,
      expiresIn,
      tokenType: data.token_type || 'Bearer',
    };
  }

  /**
   * Schedule a proactive token refresh before the current token expires.
   *
   * @param {number} expiresIn - Token lifetime in seconds
   */
  _scheduleRefresh(expiresIn) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    const refreshInMs = Math.max(
      MIN_REFRESH_DELAY_MS,
      expiresIn * 1000 - REFRESH_BUFFER_MS
    );

    logRequest('debug', 'oidc_auth', {
      message: 'Scheduled proactive token refresh',
      refresh_in_s: Math.round(refreshInMs / 1000),
    });

    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._doRefresh().catch((err) => {
        logRequest('warn', 'oidc_auth', {
          message: 'Proactive token refresh failed; will retry on next request',
          error: String(err && err.message ? err.message : err),
        });
        // Back-off: retry in ~60 seconds
        this._scheduleRefresh(REFRESH_RETRY_DELAY_S);
      });
    }, refreshInMs);

    // Allow the process to exit cleanly even if the timer is still pending
    this._refreshTimer.unref();
  }
}

/**
 * Create an OidcTokenManager from environment variables.
 *
 * @param {Record<string,string|undefined>} env - Environment variables (typically process.env)
 * @param {object} [opts]
 * @param {object} [opts.proxyAgent] - Optional HTTPS proxy agent
 * @returns {OidcTokenManager}
 */
function createOidcTokenManager(env, opts = {}) {
  return new OidcTokenManager(env, opts);
}

module.exports = { createOidcTokenManager, OidcTokenManager, makeJsonRequest };
