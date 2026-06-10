#!/bin/bash
# CLI Proxy sidecar entrypoint
#
# Connects to an external DIFC proxy (mcpg) started by the gh-aw compiler
# on the host. Uses a TCP tunnel to forward localhost:${DIFC_PORT} to
# ${DIFC_HOST}:${DIFC_PORT}, so the gh CLI can connect via localhost
# (matching the DIFC proxy's TLS cert SAN for localhost/127.0.0.1).
set -e

echo "[cli-proxy] Starting CLI proxy sidecar..."

NODE_PID=""
TUNNEL_PID=""

# External DIFC proxy host and port, set by docker-manager.ts
DIFC_HOST="${AWF_DIFC_PROXY_HOST:-host.docker.internal}"
DIFC_PORT="${AWF_DIFC_PROXY_PORT:-18443}"

echo "[cli-proxy] External DIFC proxy at ${DIFC_HOST}:${DIFC_PORT}"

# Start the TCP tunnel: localhost:${DIFC_PORT} → ${DIFC_HOST}:${DIFC_PORT}
# This allows the gh CLI to connect via localhost, matching the cert's SAN.
echo "[cli-proxy] Starting TCP tunnel: localhost:${DIFC_PORT} → ${DIFC_HOST}:${DIFC_PORT}"
node /app/tcp-tunnel.js "${DIFC_PORT}" "${DIFC_HOST}" "${DIFC_PORT}" &
TUNNEL_PID=$!

# Verify CA cert is available (bind-mounted from host by docker-manager.ts).
# Unlike the old architecture where mcpg generated the cert at runtime, the
# external DIFC proxy has already created the cert before AWF starts, so the
# bind mount makes it immediately available — no polling needed.
if [ ! -f /tmp/proxy-tls/ca.crt ]; then
  echo "[cli-proxy] ERROR: DIFC proxy TLS certificate not found at /tmp/proxy-tls/ca.crt"
  echo "[cli-proxy] Ensure --difc-proxy-ca-cert points to a valid CA cert file on the host"
  exit 1
fi
echo "[cli-proxy] TLS certificate available"

# Build a combined CA bundle so the gh CLI (Go binary) trusts the DIFC proxy's
# self-signed cert.  NODE_EXTRA_CA_CERTS only helps Node.js; Go programs use
# the system store or SSL_CERT_FILE.
COMBINED_CA="/tmp/proxy-tls/combined-ca.crt"
cat /etc/ssl/certs/ca-certificates.crt /tmp/proxy-tls/ca.crt > "${COMBINED_CA}"
echo "[cli-proxy] Combined CA bundle created at ${COMBINED_CA}"

# Configure gh CLI to route through the DIFC proxy via the TCP tunnel
# Uses localhost because the tunnel makes the DIFC proxy appear on localhost,
# matching the self-signed cert's SAN.
export GH_HOST="localhost:${DIFC_PORT}"
export GH_REPO="${GH_REPO:-$GITHUB_REPOSITORY}"
# Node.js (server.js / tcp-tunnel.js) uses NODE_EXTRA_CA_CERTS;
# gh CLI (Go) uses SSL_CERT_FILE pointing to the combined bundle;
# git (called by `gh repo clone`) uses GIT_SSL_CAINFO for OpenSSL verification.
export NODE_EXTRA_CA_CERTS="/tmp/proxy-tls/ca.crt"
export SSL_CERT_FILE="${COMBINED_CA}"
export GIT_SSL_CAINFO="${COMBINED_CA}"

echo "[cli-proxy] gh CLI configured to route through DIFC proxy at ${GH_HOST}"

# Wait for the TCP tunnel to bind its port before probing the DIFC proxy.
# The tunnel is started in the background; give it time to initialize and listen.
TUNNEL_WAIT_ATTEMPTS="${AWF_CLI_PROXY_TUNNEL_WAIT_ATTEMPTS:-10}"
TUNNEL_WAIT_SLEEP_SECONDS="${AWF_CLI_PROXY_TUNNEL_WAIT_SLEEP_SECONDS:-0.5}"
TUNNEL_ATTEMPT=1
while [ "$TUNNEL_ATTEMPT" -le "$TUNNEL_WAIT_ATTEMPTS" ]; do
  if timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${DIFC_PORT}" 2>/dev/null; then
    echo "[cli-proxy] TCP tunnel ready on localhost:${DIFC_PORT} (after ${TUNNEL_ATTEMPT} attempt(s))"
    break
  fi
  if [ "$TUNNEL_ATTEMPT" -ge "$TUNNEL_WAIT_ATTEMPTS" ]; then
    echo "[cli-proxy] ERROR: TCP tunnel failed to bind on localhost:${DIFC_PORT} after ${TUNNEL_WAIT_ATTEMPTS} attempts"
    exit 1
  fi
  echo "[cli-proxy] Waiting for TCP tunnel on localhost:${DIFC_PORT} (attempt ${TUNNEL_ATTEMPT}/${TUNNEL_WAIT_ATTEMPTS})..."
  sleep "${TUNNEL_WAIT_SLEEP_SECONDS}"
  TUNNEL_ATTEMPT=$((TUNNEL_ATTEMPT + 1))
done

# Probe external DIFC proxy liveness before serving agent traffic using a TCP
# connectivity check.  Using raw TCP (not `gh api rate_limit`) is more reliable:
# it does not require a valid GH_TOKEN, is unaffected by gh CLI version changes,
# and succeeds as long as the DIFC proxy's port is open regardless of how the
# proxy routes API paths.  Fail startup early so workflows do not enter long
# in-agent retry loops on connection-refused errors.
MAX_LIVENESS_ATTEMPTS="${AWF_CLI_PROXY_LIVENESS_ATTEMPTS:-5}"
LIVENESS_SLEEP_SECONDS="${AWF_CLI_PROXY_LIVENESS_SLEEP_SECONDS:-2}"
LIVENESS_TIMEOUT_SECONDS="${AWF_CLI_PROXY_LIVENESS_TIMEOUT_SECONDS:-5}"
ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX_LIVENESS_ATTEMPTS" ]; do
  if timeout "${LIVENESS_TIMEOUT_SECONDS}" bash -c "cat < /dev/null > /dev/tcp/${DIFC_HOST}/${DIFC_PORT}" 2>/dev/null; then
    echo "[cli-proxy] DIFC proxy liveness probe succeeded on attempt ${ATTEMPT}/${MAX_LIVENESS_ATTEMPTS}"
    break
  fi
  if [ "$ATTEMPT" -ge "$MAX_LIVENESS_ATTEMPTS" ]; then
    echo "[cli-proxy] ERROR: DIFC proxy at ${DIFC_HOST}:${DIFC_PORT} is not reachable after ${MAX_LIVENESS_ATTEMPTS} attempts"
    echo "[cli-proxy] Ensure the external DIFC proxy (mcpg) is running and accessible from the container"
    echo "[cli-proxy] Failing fast to avoid repeated in-agent retries"
    exit 1
  fi
  echo "[cli-proxy] DIFC proxy probe failed (attempt ${ATTEMPT}/${MAX_LIVENESS_ATTEMPTS}), retrying in ${LIVENESS_SLEEP_SECONDS}s..."
  sleep "${LIVENESS_SLEEP_SECONDS}"
  ATTEMPT=$((ATTEMPT + 1))
done

# Cleanup handler: stop the Node HTTP server and TCP tunnel on signal
cleanup() {
  echo "[cli-proxy] Shutting down..."
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap 'cleanup; exit 0' INT TERM

# Start the Node.js HTTP server in the background so the shell keeps running
# and traps remain active for graceful shutdown.
echo "[cli-proxy] Starting HTTP server on port 11000..."
node /app/server.js &
NODE_PID=$!

# Wait for Node to exit and propagate its exit code
if wait "$NODE_PID"; then
  NODE_EXIT=0
else
  NODE_EXIT=$?
fi

cleanup
exit "$NODE_EXIT"
