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

/**
 * Creates a Docker sbx sandbox with workspace mounts.
 * Sets `DOCKER_SANDBOXES_PROXY` to chain all egress through AWF's Squid.
 */
export async function createSandbox(config: SbxConfig): Promise<string> {
  const name = config.name || SBX_DEFAULT_NAME;
  const squidPort = config.squidPort || 3128;
  const proxyUrl = `http://${config.squidIp}:${squidPort}`;

  logger.info(`Creating sbx sandbox "${name}" with proxy → ${proxyUrl}`);

  const args = [
    'create',
    '--name', name,
    'bash',  // minimal template — we exec our own command
    config.workspaceDir,
  ];

  // Add extra read-only mounts
  if (config.extraMounts) {
    for (const mount of config.extraMounts) {
      args.push(`${mount}:ro`);
    }
  }

  await execa('sbx', args, {
    env: {
      ...process.env,
      DOCKER_SANDBOXES_PROXY: proxyUrl,
    },
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
  timeoutMinutes?: number,
): Promise<{ exitCode: number }> {
  logger.info(`Executing in sandbox "${name}": ${command}`);

  const args = ['exec', name, '--', 'bash', '-c', command];

  try {
    const result = await execa('sbx', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      reject: false,
      timeout: timeoutMinutes ? timeoutMinutes * 60 * 1000 : undefined,
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
      logger.error(`Sandbox command timed out after ${timeoutMinutes} minutes`);
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
    await execa('sbx', ['stop', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
  } catch {
    // stop may fail if already stopped — that's fine
  }

  try {
    await execa('sbx', ['rm', '--force', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    logger.info(`Sandbox "${name}" removed`);
  } catch (error: any) {
    logger.warn(`Failed to remove sandbox "${name}": ${error.message}`);
  }
}

/**
 * Checks if the sbx CLI is available on the system.
 */
export async function isSbxAvailable(): Promise<boolean> {
  try {
    await execa('sbx', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
