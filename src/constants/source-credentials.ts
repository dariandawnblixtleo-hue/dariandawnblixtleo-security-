/**
 * AWF source credentials: the environment variables that hold real API keys read from the host.
 *
 * This is the single source of truth derived from §9.1 of the AWF config spec:
 * https://github.com/github/gh-aw-firewall/blob/main/docs/awf-config-spec.md#91-source-credentials
 *
 * These are the ONLY variables allowed to hold secrets in strict mode (§9.1).
 * Tooling that compiles workflows (e.g. the gh-aw compiler) MUST derive its
 * engine.env secret-bearing allowlist from this list rather than maintaining
 * per-engine lists.
 */

/**
 * Primary source credentials (§9.1 normative list).
 * Each variable maps to a specific LLM provider API key.
 */
export const AWF_PRIMARY_SOURCE_CREDENTIALS = [
  'OPENAI_API_KEY',       // OpenAI
  'ANTHROPIC_API_KEY',    // Anthropic (Claude)
  'COPILOT_GITHUB_TOKEN', // GitHub Copilot — CAPI BYOK / offline mode
  'COPILOT_PROVIDER_API_KEY', // GitHub Copilot BYOK provider key (Azure OpenAI, OpenRouter, …)
  'GEMINI_API_KEY',       // Google Gemini
] as const;

/**
 * Secondary aliases that SHOULD also be recognised (§9.1).
 * These are alternative variable names for the same credential classes.
 */
export const AWF_SOURCE_CREDENTIAL_ALIASES = [
  'OPENAI_KEY',      // alias for OPENAI_API_KEY
  'CODEX_API_KEY',   // alias for OPENAI_API_KEY (Codex CLI)
  'CLAUDE_API_KEY',  // alias for ANTHROPIC_API_KEY
] as const;

/**
 * All AWF source credential variable names (primary + aliases).
 * Use this constant wherever a complete list of credential-bearing variables is
 * needed: exclusion sets, one-shot-token lists, compiler strict-mode allowlists.
 */
export const AWF_SOURCE_CREDENTIAL_VARS = [
  ...AWF_PRIMARY_SOURCE_CREDENTIALS,
  ...AWF_SOURCE_CREDENTIAL_ALIASES,
] as const;

/**
 * Variables allowed to hold secrets inside an `engine.env` block, regardless
 * of which agentic engine is being used.
 *
 * This list is the AWF-derived, engine-agnostic replacement for the per-engine
 * allowlists that individual compilers (e.g. gh-aw) previously maintained. It
 * extends `AWF_SOURCE_CREDENTIAL_VARS` with `COPILOT_PROVIDER_BASE_URL`:
 * although a base URL is not an API key in the §9.1 sense, it can hold a
 * secret endpoint (e.g. an internal Azure OpenAI Foundry URL) and is already
 * accepted by the gh-aw compiler's strict mode when paired with
 * `COPILOT_PROVIDER_API_KEY`.
 */
export const AWF_ENGINE_ENV_SECRET_VARS = [
  ...AWF_SOURCE_CREDENTIAL_VARS,
  'COPILOT_PROVIDER_BASE_URL', // secret endpoint companion to COPILOT_PROVIDER_API_KEY
] as const;

export type AwfPrimarySourceCredential = (typeof AWF_PRIMARY_SOURCE_CREDENTIALS)[number];
export type AwfSourceCredentialAlias = (typeof AWF_SOURCE_CREDENTIAL_ALIASES)[number];
export type AwfSourceCredentialVar = (typeof AWF_SOURCE_CREDENTIAL_VARS)[number];
export type AwfEngineEnvSecretVar = (typeof AWF_ENGINE_ENV_SECRET_VARS)[number];
