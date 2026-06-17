#!/bin/bash
# Unit test for chroot fallback PATH ordering (containers/agent/entrypoint.sh)
#
# Validates that when AWF_HOST_PATH is unset (fallback branch):
#   1. hostedtoolcache bins are appended (not prepended), so standard paths
#      retain priority.
#   2. self-hosted runner toolcache bins are scanned as fallbacks.

set -e

PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Extract the heredoc PATH-building logic from entrypoint.sh and run it in a
# temporary sub-shell with a synthetic hostedtoolcache.
# ---------------------------------------------------------------------------

# Locate the lines of the heredoc content (between the AWFEOF markers in the
# else branch).  We pull only the lines between "Constructing default PATH"
# comment and the closing AWFEOF.
ENTRYPOINT="$(dirname "$0")/../containers/agent/entrypoint.sh"

if [ ! -f "${ENTRYPOINT}" ]; then
  echo "❌ Cannot find entrypoint.sh at ${ENTRYPOINT}"
  exit 1
fi

# Create a temporary directory for the test fixtures
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

# Build a fake hostedtoolcache with two Ruby versions
TOOLCACHE="${TMPDIR_TEST}/opt/hostedtoolcache"
mkdir -p "${TOOLCACHE}/Ruby/3.1.0/x64/bin"
mkdir -p "${TOOLCACHE}/Ruby/3.3.0/x64/bin"
# Create stub "ruby" binaries that print their version
printf '#!/bin/sh\necho "ruby 3.1.0"\n' > "${TOOLCACHE}/Ruby/3.1.0/x64/bin/ruby"
printf '#!/bin/sh\necho "ruby 3.3.0"\n' > "${TOOLCACHE}/Ruby/3.3.0/x64/bin/ruby"
chmod +x "${TOOLCACHE}/Ruby/3.1.0/x64/bin/ruby"
chmod +x "${TOOLCACHE}/Ruby/3.3.0/x64/bin/ruby"

# Build a fake self-hosted runner toolcache with a Node.js version
RUNNER_TOOLCACHE="${TMPDIR_TEST}/home/runner/work/_tool"
mkdir -p "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin"
printf '#!/bin/sh\necho "node 20.19.0"\n' > "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node"
chmod +x "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node"

# ---------------------------------------------------------------------------
# Helper: run the extracted PATH logic in a clean environment, then evaluate
# the resulting PATH with a provided test expression.
# ---------------------------------------------------------------------------
run_path_test() {
  local base_path="$1"           # starting PATH value
  local check_expr="$2"          # bash expression to evaluate after PATH is set

  # Build the inline script from the relevant heredoc section of entrypoint.sh.
  # We replace the toolcache roots with fake test fixtures so the test is
  # self-contained and doesn't depend on the host runner layout.
  local script
  script="$(
    sed -n '/^# Dynamically scan toolcache roots/,/^AWFEOF$/{ /^AWFEOF$/d; p; }' \
      "${ENTRYPOINT}" |
    sed \
      -e "s|/opt/hostedtoolcache|${TOOLCACHE}|g" \
      -e "s|\${HOME}/work/_tool|${RUNNER_TOOLCACHE}|g"
  )"

  # Run the script in a sub-shell with a clean environment
  (
    local isolated_home
    isolated_home="$(mktemp -d "${TMPDIR_TEST}/home-XXXXXX")"
    trap '/bin/rm -rf "${isolated_home}"' EXIT
    export HOME="${isolated_home}"
    export PATH="${base_path}"
    eval "${script}"
    eval "${check_expr}"
  )
}

BASE_PATH="/usr/local/bin:/usr/bin:/bin"

# ---------------------------------------------------------------------------
# Test 1: Toolcache bins are appended (not prepended)
# ---------------------------------------------------------------------------
if run_path_test "${BASE_PATH}" "
  case \"\${PATH}\" in
    \"${TOOLCACHE}/Ruby\"*) exit 1;;   # toolcache prepended — wrong
    *) exit 0;;                         # toolcache appended or absent — ok
  esac
"; then
  pass "toolcache bins are not prepended to PATH"
else
  fail "toolcache bins were incorrectly prepended to PATH"
fi

# ---------------------------------------------------------------------------
# Test 2: Self-hosted runner toolcache is scanned for fallback binaries
# ---------------------------------------------------------------------------
FALLBACK_BASE_PATH="/tmp/awf-empty-path"

if run_path_test "${FALLBACK_BASE_PATH}" "
  case \"\${PATH}\" in
    *\"${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin\"*) exit 0;;
    *) exit 1;;
  esac
"; then
  pass "self-hosted runner toolcache bins are appended to PATH"
else
  fail "self-hosted runner toolcache bins were not added to PATH"
fi

if run_path_test "${FALLBACK_BASE_PATH}" \
  '[ "$(command -v node 2>/dev/null)" = "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node" ]'; then
  pass "node resolves from self-hosted runner toolcache fallback"
else
  fail "node does not resolve from self-hosted runner toolcache fallback"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
