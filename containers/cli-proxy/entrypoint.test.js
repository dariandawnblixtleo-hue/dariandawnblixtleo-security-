'use strict';
/**
 * Tests for cli-proxy entrypoint.sh DIFC proxy liveness probe.
 *
 * Regression coverage for the case where the external DIFC proxy is reachable
 * but answers the probe (`gh api rate_limit`) with an HTTP error such as 403.
 * An HTTP response proves the proxy is up, so the probe must treat it as a
 * successful liveness check instead of failing startup. Only connection-level
 * failures (e.g. connection refused) should fail fast.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENTRYPOINT = path.join(__dirname, 'entrypoint.sh');

/**
 * Extracts the self-contained liveness-probe `while` loop from entrypoint.sh so
 * the real shell logic (not a copy) is exercised against stubbed `gh` outputs.
 */
function extractProbeLoop() {
  const script = fs.readFileSync(ENTRYPOINT, 'utf8');
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.includes('while [ "$ATTEMPT" -le "$MAX_LIVENESS_ATTEMPTS" ]; do'));
  expect(start).toBeGreaterThanOrEqual(0);
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === 'done') {
      end = i;
      break;
    }
  }
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Runs the extracted probe loop with a stubbed `gh` whose behavior is described
 * by `ghStub` (a bash snippet). Returns { status, stdout }.
 */
function runProbe(ghStub) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-proxy-probe-'));
  try {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/bash\n${ghStub}\n`, { mode: 0o755 });

    const harness = [
      'set -e',
      'GH_HOST="localhost:18443"',
      'MAX_LIVENESS_ATTEMPTS=2',
      'LIVENESS_SLEEP_SECONDS=0',
      'LIVENESS_TIMEOUT_SECONDS=5',
      'ATTEMPT=1',
      extractProbeLoop(),
      'echo "PROBE_DONE"',
    ].join('\n');

    const stdout = execFileSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: (err.stdout || '').toString() };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('cli-proxy liveness probe', () => {
  it('treats an HTTP 403 response as a reachable DIFC proxy and does not fail startup', () => {
    const { status, stdout } = runProbe('echo "gh: HTTP 403" >&2\nexit 1');
    expect(status).toBe(0);
    expect(stdout).toContain('DIFC proxy reachable');
    expect(stdout).toContain('PROBE_DONE');
  });

  it('treats a successful probe as reachable', () => {
    const { status, stdout } = runProbe('echo "{}"\nexit 0');
    expect(status).toBe(0);
    expect(stdout).toContain('DIFC proxy liveness probe succeeded');
  });

  it('fails fast on a connection-level failure (connection refused)', () => {
    const { status, stdout } = runProbe(
      'echo "error connecting to localhost:18443: dial tcp 127.0.0.1:18443: connect: connection refused" >&2\nexit 1'
    );
    expect(status).toBe(1);
    expect(stdout).toContain('DIFC proxy liveness probe failed');
    expect(stdout).not.toContain('PROBE_DONE');
  });
});
