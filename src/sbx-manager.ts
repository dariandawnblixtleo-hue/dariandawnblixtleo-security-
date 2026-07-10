/**
 * Docker sbx (sandbox) microVM lifecycle manager.
 *
 * Manages the agent process inside a Docker sbx microVM while AWF's
 * infrastructure containers (Squid, api-proxy) remain in Docker Compose
 * on the host.  All sbx egress is chained through AWF's Squid proxy via
 * the `DOCKER_SANDBOXES_PROXY` environment variable.
 *
 * ## Lifecycle
 *
 * 1. `createSandbox()` — `sbx create` with workspace mounts
 * 2. `execInSandbox()` — `sbx exec` to run the agent command, streams
 *    stdout/stderr and collects exit code
 * 3. `removeSandbox()` — `sbx stop` + `sbx rm` for cleanup
 *
 * ## Proxy chaining
 *
 * `DOCKER_SANDBOXES_PROXY` is a daemon-level env var that routes all
 * sandbox egress through the specified proxy.  In CI (one sandbox per
 * runner), this is safe to set globally.  AWF sets it to Squid's address
 * (`http://<squidIp>:3128`) before creating the sandbox, so all agent
 * traffic flows through AWF's domain ACL.
 */

import execa from 'execa';
import { logger } from './logger';

/** Name prefix for AWF-managed sandboxes. */
const SBX_NAME_PREFIX = 'awf-agent';

/**
 * Env vars that must NEVER reach the sbx CLI or sandbox interior.
 * Patterns are matched case-insensitively against env var names.
 */
const SECRET_ENV_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /KEY/i,
  /CREDENTIAL/i,
  /PAT$/i,
  /^DOCKER_PAT$/i,
  /^DOCKER_USERNAME$/i,
];

/** Default sandbox name (single-sandbox-per-run model). */
export const SBX_DEFAULT_NAME = `${SBX_NAME_PREFIX}-${process.pid}`;

export interface SbxConfig {
  /** Sandbox name (defaults to `awf-agent-<pid>`). */
  name?: string;
  /** Workspace directory to mount into the sandbox. */
  workspaceDir: string;
  /** Squid proxy IP for DOCKER_SANDBOXES_PROXY. */
  squidIp: string;
  /** Squid proxy port (default 3128). */
  squidPort?: number;
  /** Additional workspace mounts (read-only paths). */
  extraMounts?: string[];
}

export interface SbxExecOptions {
  timeoutMinutes?: number;
  workDir?: string;
  environment?: Record<string, string>;
  tty?: boolean;
}

/**
 * Strips secret-bearing env vars from process.env so they never reach
 * the sbx CLI or the sandbox interior.  Returns a shallow copy with
 * only non-secret entries plus any explicit overrides.
 */
export function sanitizeEnvForSbx(
  overrides: Record<string, string> = {},
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_PATTERNS.some((p) => p.test(key))) {
      clean[key] = value;
    }
  }
  return { ...clean, ...overrides };
}

/**
 * Creates a Docker sbx sandbox with workspace mounts.
 * Sets `DOCKER_SANDBOXES_PROXY` to chain all egress through AWF's Squid.
 */
export async function createSandbox(config: SbxConfig): Promise<string> {
  const name = config.name || SBX_DEFAULT_NAME;
  const squidPort = config.squidPort || 3128;
  const proxyUrl = `http://${config.squidIp}:${squidPort}`;

  logger.info(`Configuring sbx daemon proxy to ${proxyUrl}`);
  await restartSbxDaemonWithProxy(proxyUrl);

  logger.info(`Creating sbx sandbox "${name}" with proxy → ${proxyUrl}`);

  const args = [
    'create',
    '--name', name,
    'shell',  // shell agent provides a generic sandbox
    config.workspaceDir,
  ];

  // Add extra mounts passed from AWF config (preserve caller-provided mode)
  if (config.extraMounts) {
    for (const mount of config.extraMounts) {
      args.push(mount);
    }
  }

  await execa('sbx', args, {
    env: sanitizeEnvForSbx({ DOCKER_SANDBOXES_PROXY: proxyUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  logger.info(`Sandbox "${name}" created`);
  return name;
}

/**
 * Executes a command inside the sandbox, streaming stdout/stderr.
 * Returns the exit code of the command.
 */
export async function execInSandbox(
  name: string,
  command: string,
  options?: SbxExecOptions,
): Promise<{ exitCode: number }> {
  logger.info(`Executing in sandbox "${name}": ${command}`);

  const args = ['exec'];
  if (options?.workDir) {
    args.push('--workdir', options.workDir);
  }
  if (options?.tty) {
    args.push('--tty');
  }
  if (options?.environment) {
    for (const [key, value] of Object.entries(options.environment)) {
      args.push('--env', `${key}=${value}`);
    }
  }

  args.push(name, 'bash', '-lc', command);

  try {
    const result = await execa('sbx', args, {
      env: sanitizeEnvForSbx(),
      stdio: ['ignore', 'inherit', 'inherit'],
      reject: false,
      timeout: options?.timeoutMinutes ? options.timeoutMinutes * 60 * 1000 : undefined,
    });

    const exitCode = result.exitCode ?? 1;

    if (exitCode === 0) {
      logger.info(`Sandbox command completed successfully`);
    } else {
      logger.warn(`Sandbox command exited with code ${exitCode}`);
    }

    return { exitCode };
  } catch (error: any) {
    if (error.timedOut) {
      logger.error(`Sandbox command timed out after ${options?.timeoutMinutes} minutes`);
      return { exitCode: 124 }; // match timeout convention
    }
    logger.error(`Sandbox exec failed: ${error.message}`);
    return { exitCode: 1 };
  }
}

/**
 * Stops and removes the sandbox.
 */
export async function removeSandbox(name: string): Promise<void> {
  logger.info(`Removing sandbox "${name}"...`);

  try {
    const stopResult = await execa('sbx', ['stop', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if ((stopResult.exitCode ?? 1) !== 0) {
      const stderr = stopResult.stderr?.trim();
      logger.warn(
        `Failed to stop sandbox "${name}" (exit ${(stopResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
      );
    }
  } catch {
    // stop may fail if already stopped — that's fine
  }

  const rmResult = await execa('sbx', ['rm', '--force', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });
  if ((rmResult.exitCode ?? 1) !== 0) {
    const stderr = rmResult.stderr?.trim();
    logger.warn(
      `Failed to remove sandbox "${name}" (exit ${(rmResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
    );
    return;
  }

  logger.info(`Sandbox "${name}" removed`);
}

/**
 * Checks if the sbx CLI is available on the system.
 */
export async function isSbxAvailable(): Promise<boolean> {
  try {
    await execa('sbx', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function restartSbxDaemonWithProxy(proxyUrl: string): Promise<void> {
  const daemonStatus = await execa('sbx', ['daemon', 'status', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });

  const daemonRunning = daemonStatus.exitCode === 0;
  if (daemonRunning) {
    const stop = await execa('sbx', ['daemon', 'stop'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if ((stop.exitCode ?? 1) !== 0) {
      throw new Error(
        `Unable to stop running sbx daemon (exit ${(stop.exitCode ?? 1)}): ${stop.stderr || stop.stdout || 'unknown error'}`
      );
    }
  }

  const start = await execa('sbx', ['daemon', 'start'], {
    env: {
      ...process.env,
      DOCKER_SANDBOXES_PROXY: proxyUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });
  if ((start.exitCode ?? 1) !== 0) {
    throw new Error(
      `Unable to start sbx daemon with DOCKER_SANDBOXES_PROXY (exit ${(start.exitCode ?? 1)}): ${start.stderr || start.stdout || 'unknown error'}`
    );
  }

  const verify = await execa('sbx', ['daemon', 'status', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });
  if ((verify.exitCode ?? 1) !== 0) {
    throw new Error(
      `Unable to verify sbx daemon status after proxy configuration (exit ${(verify.exitCode ?? 1)}): ${verify.stderr || verify.stdout || 'unknown error'}`
    );
  }

  // Best-effort validation from status JSON/text; fail closed if status clearly
  // reports a different upstream proxy.
  const statusText = `${verify.stdout || ''}\n${verify.stderr || ''}`;
  if (statusText.includes('DOCKER_SANDBOXES_PROXY') && !statusText.includes(proxyUrl)) {
    throw new Error(
      `sbx daemon status does not reflect expected DOCKER_SANDBOXES_PROXY (${proxyUrl})`
    );
  }
}
