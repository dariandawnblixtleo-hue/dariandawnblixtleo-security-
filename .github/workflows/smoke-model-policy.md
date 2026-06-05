---
description: Smoke test that validates the api-proxy model allow/deny policy by issuing a request for a model blocked by the configured disallowedModels list and asserting the sidecar returns a 403 model_blocked_by_policy response
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'containers/api-proxy/**'
      - 'src/services/api-proxy-service-config.ts'
      - 'src/commands/validators/log-and-limits.ts'
      - 'scripts/ci/postprocess-smoke-workflows.ts'
      - '.github/workflows/smoke-model-policy.md'
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Model Policy
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
sandbox:
  agent:
    id: awf
  mcp:
    version: v0.3.1
strict: false
tools:
  bash:
    - "*"
  github:
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-model-policy]
  messages:
    footer: "> 🛡️ *Model policy enforced by [{workflow_name}]({run_url})*"
    run-started: "🛡️ [{workflow_name}]({run_url}) is verifying the api-proxy model allow/deny policy..."
    run-success: "🛡️ [{workflow_name}]({run_url}) verified: blocked models are rejected with `model_blocked_by_policy`. ✅"
    run-failure: "🛡️ [{workflow_name}]({run_url}) reports {status}. Model policy enforcement regression detected. ⚠️"
timeout-minutes: 10
post-steps:
  - name: Verify api-proxy logged a model_blocked_by_policy event
    if: always()
    run: |
      set -eo pipefail
      LOG_DIR="/tmp/gh-aw/sandbox/firewall/logs/api-proxy"
      echo "=== api-proxy log directory ==="
      ls -la "$LOG_DIR" 2>/dev/null || { echo "::error::api-proxy log directory missing: $LOG_DIR"; exit 1; }
      MATCH_COUNT=0
      if compgen -G "$LOG_DIR/*.jsonl" > /dev/null; then
        MATCH_COUNT=$(grep -l 'blocked_model' "$LOG_DIR"/*.jsonl 2>/dev/null | wc -l)
        echo "=== Sample blocked_model log entries ==="
        grep 'blocked_model' "$LOG_DIR"/*.jsonl 2>/dev/null | head -5 || true
      fi
      if [ "$MATCH_COUNT" -eq 0 ]; then
        echo "::error::No blocked_model entries found in api-proxy logs. Model policy may not be enforced."
        exit 1
      fi
      echo "✅ Found blocked_model entries in api-proxy logs"
  - name: Validate safe outputs were invoked
    if: always()
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          echo "::error::Agent did not call add_comment on a pull_request trigger."
          exit 1
        fi
        echo "add_comment verified for PR trigger"
      fi
      echo "Safe output validation passed"
---

# Smoke Test: API Proxy Model Allow/Deny Policy

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible.**

## Context

The AWF api-proxy sidecar enforces a per-provider allow/deny model policy configured
via `apiProxy.allowedModels` and `apiProxy.disallowedModels` in `awf-config.json`.
When a request resolves to a model that is blocked, the sidecar must respond with
HTTP 403 and an error envelope of type `model_blocked_by_policy`.

For this smoke run, the workflow post-processor injects this policy into the
generated `awf-config.json`:

```json
{
  "apiProxy": {
    "disallowedModels": ["*/awf-smoke-blocked-test-model*"]
  }
}
```

The agent's own model is **not** matched by that pattern, so the agent runs normally.

## Steps

### 1. Issue a blocked-model request through the api-proxy

Use bash to send a chat-completions request to the api-proxy at `$COPILOT_API_URL`
asking for the blocked model. Save the response body and the HTTP status:

```bash
RESPONSE_FILE=/tmp/gh-aw/agent/blocked-response.json
STATUS=$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$COPILOT_API_URL/chat/completions" \
  -H 'Content-Type: application/json' \
  --data '{"model":"awf-smoke-blocked-test-model-001","messages":[{"role":"user","content":"hi"}],"max_tokens":1}')
echo "HTTP status: $STATUS"
cat "$RESPONSE_FILE"
```

### 2. Verify the response

- Confirm `STATUS == 403`.
- Confirm the response body contains `"type":"model_blocked_by_policy"`.
- Confirm the response body contains the blocked model name.

If any check fails, treat the run as a failure.

## Reporting

Add a brief comment (max 5 lines) to the triggering pull request summarising:

- HTTP status returned by the api-proxy
- Whether the response body contained `model_blocked_by_policy`
- Overall result (✅ PASS or ❌ FAIL)
- The blocked model name used

If all checks pass, also add the `smoke-model-policy` label to the pull request.
