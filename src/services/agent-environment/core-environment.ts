import { SQUID_PORT } from '../../constants';
import { getRealUserHome } from '../../host-identity';
import { AWF_SOURCE_CREDENTIAL_VARS } from '../../constants/source-credentials';
import { AgentEnvironmentParams } from './types';

/**
 * GitHub authentication tokens that receive one-shot protection alongside
 * source credentials. These are forwarded directly to the agent container and
 * must be removed from /proc/self/environ after first access.
 */
const GITHUB_TOKEN_VARS = [
  'COPILOT_GITHUB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_API_TOKEN',
  'GITHUB_PAT',
  'GH_ACCESS_TOKEN',
] as const;

/**
 * OTEL exporter header variables that may carry bearer tokens and therefore
 * also receive one-shot protection.
 */
const OTEL_HEADER_VARS = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
] as const;

/**
 * Combined one-shot-token list (§9.4 of the AWF config spec):
 * - AWF source credentials (§9.1) — the canonical set derived from the spec
 * - GitHub authentication tokens — forwarded directly and protected at rest
 * - OTEL exporter header variables — may carry bearer tokens
 *
 * Note: COPILOT_GITHUB_TOKEN appears in both AWF_SOURCE_CREDENTIAL_VARS and
 * GITHUB_TOKEN_VARS; deduplication is applied at build time via Set.
 */
const AWF_ONE_SHOT_TOKEN_LIST = [
  ...new Set([...GITHUB_TOKEN_VARS, ...AWF_SOURCE_CREDENTIAL_VARS, ...OTEL_HEADER_VARS]),
].join(',');

export function buildCoreEnvironment(params: AgentEnvironmentParams): Record<string, string> {
  const { config, networkConfig } = params;
  const homeDir = getRealUserHome();

  return {
    HTTP_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    HTTPS_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    https_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    SQUID_PROXY_HOST: 'squid-proxy',
    SQUID_PROXY_PORT: SQUID_PORT.toString(),
    HOME: homeDir,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(config.tty ? {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      COLUMNS: '120',
    } : {
      NO_COLOR: '1',
    }),
    AWF_ONE_SHOT_TOKENS: AWF_ONE_SHOT_TOKEN_LIST,
  };
}
