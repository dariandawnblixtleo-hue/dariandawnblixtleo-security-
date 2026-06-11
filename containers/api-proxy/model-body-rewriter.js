'use strict';

/**
 * HTTP body rewriting for AWF API proxy model resolution.
 *
 * Rewrites the "model" field in a JSON request body using the alias map.
 * This is an HTTP transformation concern, kept separate from the core
 * alias resolution algorithm in model-resolver.js.
 */

const { parseBodyAsObject } = require('./body-utils');
const { resolveModel, normalizeModelPolicy, checkModelPolicy } = require('./model-resolver');

/**
 * Attempt to rewrite the "model" field in a JSON request body using the alias map.
 *
 * Returns the rewritten body buffer and the resolution log when a rewrite occurs.
 * Returns null when no rewrite is needed or possible.
 * Returns a `{ blocked: true, ... }` object when the requested model is rejected
 * by the configured allow/deny model policy.
 *
 * @param {Buffer} body - Raw request body bytes
 * @param {string} provider - Current provider (e.g. "copilot")
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>|null} aliases - Parsed alias map
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider
 * @param {{ enabled?: boolean, strategy?: string }} [modelFallbackConfig]
 * @param {{ allowed?: string[], disallowed?: string[] } | null} [modelPolicy]
 * @returns {{ body: Buffer, originalModel: string, resolvedModel: string, log: string[], fallback?: object } | { blocked: true, originalModel: string, reason: string, pattern?: string, log: string[] } | null}
 */
function rewriteModelInBody(body, provider, aliases, availableModels, modelFallbackConfig, modelPolicy = null) {
  // Only attempt rewrite for non-empty bodies
  if (!body || body.length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null; // Non-JSON body — skip

  // Determine the requested model. If absent, try the default alias ("").
  const originalModel = typeof parsed.model === 'string' ? parsed.model : '';
  const policy = normalizeModelPolicy(modelPolicy);
  const policyEnabled = policy.hasAllowList || policy.hasDenyList;

  const aliasMap = aliases && typeof aliases === 'object' ? aliases : {};
  const resolution = resolveModel(originalModel, aliasMap, availableModels, provider, [], modelFallbackConfig, policy);

  // If alias resolution failed but policy is enabled and a concrete model was
  // requested, surface a "blocked" result so the proxy can reject the request
  // with a clear diagnostic rather than passing it upstream.
  if (!resolution) {
    if (policyEnabled && originalModel) {
      const check = checkModelPolicy(provider, originalModel, policy);
      if (!check.allowed) {
        return {
          blocked: true,
          originalModel,
          reason: check.reason,
          pattern: check.pattern,
          log: [`[model-resolver] request blocked by model policy: "${originalModel}" (${check.reason})`],
        };
      }
    }
    return null;
  }

  const { resolvedModel, log } = resolution;

  // Defence-in-depth: even if `resolveModel` returned a candidate, double-check
  // it against the policy before rewriting the request body.
  if (policyEnabled) {
    const check = checkModelPolicy(provider, resolvedModel, policy);
    if (!check.allowed) {
      return {
        blocked: true,
        originalModel: originalModel || resolvedModel,
        reason: check.reason,
        pattern: check.pattern,
        log: [...log, `[model-resolver] resolved model blocked by policy: "${resolvedModel}" (${check.reason})`],
      };
    }
  }

  // No rewrite needed if the model is already the resolved value
  if (resolvedModel === parsed.model) return null;

  // Patch the body
  parsed.model = resolvedModel;
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');

  return { body: newBody, originalModel, resolvedModel, log, fallback: resolution.fallback };
}

module.exports = {
  rewriteModelInBody,
};
