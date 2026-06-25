import { PROXY_ENV_VARS } from '../../upstream-proxy';
import { WrapperConfig } from '../../types';
import { AWF_SOURCE_CREDENTIAL_VARS } from '../../constants/source-credentials';

export function buildExclusionSet(config: WrapperConfig): Set<string> {
  const excludedEnvVars = new Set([
    'PATH',
    'PWD',
    'OLDPWD',
    'SHLVL',
    '_',
    'SUDO_COMMAND',
    'SUDO_USER',
    'SUDO_UID',
    'SUDO_GID',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    ...PROXY_ENV_VARS,
    'AWF_PREFLIGHT_BINARY',
    'AWF_STAGED_RUNNER_BINARY_NAME',
    'AWF_GEMINI_ENABLED',
    'MCP_GATEWAY_HOST_DOMAIN',
  ]);

  if (config.enableApiProxy) {
    for (const v of AWF_SOURCE_CREDENTIAL_VARS) {
      excludedEnvVars.add(v);
    }
    // Exclude Gemini base-URL routing variables as well — these reveal the
    // upstream endpoint and must not reach the agent when the sidecar is active.
    excludedEnvVars.add('GOOGLE_GEMINI_BASE_URL');
    excludedEnvVars.add('GEMINI_API_BASE_URL');
  }

  if (config.difcProxyHost) {
    excludedEnvVars.add('GITHUB_TOKEN');
    excludedEnvVars.add('GH_TOKEN');
  }

  if (config.excludeEnv && config.excludeEnv.length > 0) {
    for (const name of config.excludeEnv) {
      excludedEnvVars.add(name);
    }
  }

  return excludedEnvVars;
}
