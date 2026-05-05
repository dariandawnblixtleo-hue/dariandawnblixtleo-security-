'use strict';

/**
 * OpenAI provider adapter.
 *
 * Port: 10000  (also serves as the management port for /health, /metrics, /reflect)
 * Auth: Bearer token via Authorization header
 * Credentials: OPENAI_API_KEY  — or OIDC federated auth when AWF_AUTH_TYPE=github-oidc
 * Target: OPENAI_API_TARGET  (default: api.openai.com)
 * Base path: OPENAI_API_BASE_PATH  (default: /v1 for the public endpoint)
 *
 * OIDC auth: When AWF_AUTH_TYPE=github-oidc is configured (see oidc-auth.js),
 * the adapter acquires a short-lived Azure AD Bearer token via GitHub Actions
 * OIDC federation instead of using a static OPENAI_API_KEY. This supports
 * Azure OpenAI deployments that use Entra ID (API key disabled) authentication.
 */

const { createBaseAdapterConfig } = require('../proxy-utils');

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null, oidcAuth?: import('../oidc-auth').OidcTokenManager|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath: explicitBasePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'OPENAI_API_KEY',
    targetEnvVar: 'OPENAI_API_TARGET',
    basePathEnvVar: 'OPENAI_API_BASE_PATH',
    defaultTarget: 'api.openai.com',
  });

  // For the default OpenAI endpoint, unversioned clients (e.g. Codex CLI sending
  // /responses) need a /v1 prefix to reach the correct versioned API surface.
  // Custom targets manage their own path layout and must not receive an implicit prefix.
  const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');

  const bodyTransform = deps.bodyTransform || null;

  /** @type {import('../oidc-auth').OidcTokenManager|null} */
  const oidcAuth = deps.oidcAuth || null;

  /** True when OIDC federated auth is configured for this adapter */
  const oidcEnabled = oidcAuth !== null && oidcAuth.isEnabled();

  return {
    name: 'openai',
    port: 10000,

    /** Port 10000 is the central management port (/health, /metrics, /reflect). */
    isManagementPort: true,

    /**
     * Port 10000 always starts — even without a key — to serve the management
     * endpoints required by the Docker healthcheck.
     */
    alwaysBind: true,

    /** Port 10000 always counts toward the startup validation latch. */
    participatesInValidation: true,

    isEnabled() { return !!apiKey || oidcEnabled; },
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },

    /**
     * Returns auth headers for the upstream request.
     *
     * When OIDC auth is configured, asynchronously acquires the current Azure AD
     * Bearer token (returned from cache when valid, refreshed transparently on expiry).
     * Falls back to the static OPENAI_API_KEY when OIDC is not configured.
     *
     * @returns {Promise<Record<string,string>>|Record<string,string>}
     */
    async getAuthHeaders() {
      if (oidcEnabled) {
        const token = await oidcAuth.getToken();
        return { 'Authorization': `Bearer ${token}` };
      }
      return { 'Authorization': `Bearer ${apiKey}` };
    },

    getBodyTransform() { return bodyTransform; },

    /**
     * Returns the validation probe config, or null to skip.
     * Custom targets are skipped — we don't know their probe endpoints.
     * OIDC-auth providers skip validation (token is validated on first real request).
     *
     * @returns {{ url: string, opts: object }|{ skip: true, reason: string }|null}
     */
    getValidationProbe() {
      if (oidcEnabled) {
        return { skip: true, reason: 'OIDC auth configured; validation skipped (token validated on first request)' };
      }
      if (!apiKey) return null;
      if (rawTarget !== 'api.openai.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }
      return {
        url: `https://${rawTarget}/v1/models`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
      };
    },

    /**
     * Returns the model-list fetch config for /reflect model population, or null.
     * Uses the configured base path so prefixed OpenAI-compatible deployments
     * (e.g. Databricks, Azure) populate /reflect and models.json correctly.
     * OIDC auth is async so model fetching is skipped at startup — the model list
     * will be populated on the first authenticated request.
     *
     * @returns {{ url: string, opts: object, cacheKey: string }|null}
     */
    getModelsFetchConfig() {
      if (oidcEnabled) return null; // token not yet available at startup
      if (!apiKey) return null;
      const modelsPath = basePath ? `${basePath}/models` : '/v1/models';
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
        cacheKey: 'openai',
      };
    },

    getReflectionInfo() {
      return {
        provider: 'openai',
        port: 10000,
        base_url: 'http://api-proxy:10000',
        configured: !!apiKey || oidcEnabled,
        models_cache_key: 'openai',
        models_url: 'http://api-proxy:10000/v1/models',
      };
    },

    /** Response returned when port 10000 receives a proxy request but no key is set. */
    getUnconfiguredResponse() {
      return {
        statusCode: 404,
        body: { error: 'OpenAI proxy not configured (no OPENAI_API_KEY or OIDC auth)' },
      };
    },

    // Exposed for introspection (logging, tests)
    _oidcEnabled: oidcEnabled,
  };
}

module.exports = { createOpenAIAdapter };
