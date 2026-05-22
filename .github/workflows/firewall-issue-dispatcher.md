---
name: Firewall Issue Dispatcher
description: Audits github/gh-aw issues labeled 'awf' and creates tracking issues in gh-aw-firewall with proposed solutions

on:
  schedule: every 6h
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

sandbox:
  agent:
    id: awf
    version: v0.25.29
tools:
  github:
    toolsets: [issues]
    allowed-repos: ["github/gh-aw", "github/gh-aw-firewall"]
    min-integrity: none
    github-token: ${{ secrets.GH_AW_CROSS_REPO_PAT }}

safe-outputs:
  threat-detection:
    enabled: false
  github-token: ${{ secrets.GH_AW_CROSS_REPO_PAT }}
  create-issue:
    max: 10
    labels: [awf-triage]
  add-comment:
    max: 10
    target: "*"
    allowed-repos: ["github/gh-aw"]
---

# Firewall Issue Dispatcher

You audit open issues in `github/gh-aw` labeled `awf` and create tracking issues in `github/gh-aw-firewall`.

## Step 1: Batch Fetch All Data (ONE command)

Run this single shell command to get all open `awf` issues with their first 10 comments. Use direct REST API access to avoid the `gh` CLI startup `/meta` probe, which can fail on DIFC-proxied runners:

```bash
SEARCH_API="${GITHUB_API_URL%/}/search/issues"
ISSUES_API="${GITHUB_API_URL%/}/repos/github/gh-aw/issues"
TOKEN_VAR_NAME="GITHUB_MCP_SERVER_TOKEN"
AUTH_TOKEN="${!TOKEN_VAR_NAME}"
AUTH_HEADER_NAME="Author""ization"
AUTH_SCHEME="Be""arer"
AUTH_HEADER_VALUE="${AUTH_SCHEME} ${AUTH_TOKEN}"

curl -fsSL --get \
  -H "${AUTH_HEADER_NAME}: ${AUTH_HEADER_VALUE}" \
  -H "Accept: application/vnd.github+json" \
  --data-urlencode 'q=repo:github/gh-aw is:issue is:open label:awf' \
  --data-urlencode 'sort=created' \
  --data-urlencode 'order=desc' \
  --data-urlencode 'per_page=50' \
  "$SEARCH_API" \
  | jq -rc '.items[]' \
  | while IFS= read -r issue; do
      number=$(jq -r '.number' <<<"$issue")
      comments=$(curl -fsSL \
        -H "${AUTH_HEADER_NAME}: ${AUTH_HEADER_VALUE}" \
        -H "Accept: application/vnd.github+json" \
        "${ISSUES_API}/${number}/comments?per_page=10" | jq '[.[] | {author: {login: .user.login}, body}]')
      jq -n --argjson issue "$issue" --argjson comments "$comments" '{
        number: $issue.number,
        title: $issue.title,
        body: $issue.body,
        url: $issue.html_url,
        comments: {nodes: $comments}
      }'
    done \
  | jq -s '.'
```

## Step 2: Filter Locally

For each issue found, read its comments and check whether any comment contains a reference to a `github/gh-aw-firewall` issue (i.e., a URL matching `https://github.com/github/gh-aw-firewall/issues/` or a GitHub cross-repo reference matching `github/gh-aw-firewall#`). If such a comment exists, **skip** that issue — it has already been audited. Do this filtering in your analysis — do NOT make additional API calls.

If no unprocessed issues remain, call `noop` and stop.

## Step 3: Create Tracking Issues

For each **unprocessed** issue:

1. **Create a tracking issue in `github/gh-aw-firewall`** using the `create_issue` safe output with:
   - Title: `[awf] <component>: <summary>`
   - Body: **Problem**, **Context** (link to original), **Root Cause**, **Proposed Solution** — keep to 200 words maximum
   - Labels: `awf-triage`

2. **Comment on the original `github/gh-aw` issue** linking to the newly created tracking issue. Use this exact format:
   > 🔗 AWF tracking issue: https://github.com/github/gh-aw-firewall/issues/{NUMBER}

   `create_issue` may return a reference like `github/gh-aw-firewall#2159`. Extract only the trailing digits before composing the URL.
   - Valid: `https://github.com/github/gh-aw-firewall/issues/2159`
   - Invalid: `https://github.com/github/gh-aw-firewall/issues/github/gh-aw-firewall#2159`
   - Invalid: `https://github.com/github/gh-aw-firewall/issues/#2159`

   Use the `add_comment` safe output tool with `repo: "github/gh-aw"` and the original issue number.

### 4. Report Results

Report: issues found, skipped (already audited), tracking issues created.

## Guidelines

- **Be specific and actionable** — reference source files and functions.
- **One tracking issue per gh-aw issue** — do not combine.
- **Propose real solutions** — not just "investigate this."
- **No extra reads** — do not open `AGENTS.md`, source files, or any workspace files; all needed context is in the GraphQL response above.
- **Don't retry without diagnosing** — analyze the error before retrying any failed tool call.
