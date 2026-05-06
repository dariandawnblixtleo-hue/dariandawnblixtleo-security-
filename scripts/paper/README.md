# Token Efficiency Paper — Scripts, Data & Figures

This directory contains the data collection, analysis, and figure generation pipeline for the token efficiency paper. The paper measures the impact of prompt optimizations on Effective Token (ET) consumption across agentic workflows in two repositories: `github/gh-aw` and `github/gh-aw-firewall`.

## Effective Tokens Formula

All analysis uses the blog-post ET formula:

```
ET = m × (1.0 × I + 0.1 × C + 4.0 × O)
```

- `m` = model multiplier (Haiku/gpt-5-mini = 0.25, Sonnet = 1.0, Opus = 5.0)
- `I` = fresh input tokens (non-cached)
- `C` = cache-read tokens
- `O` = output tokens

**Important**: The `effective_tokens` field pre-computed in the JSONL datasets uses a *different*, simpler formula (`input - cacheRead + output + cacheWrite`). Always recompute ET from raw token fields + model multipliers for accurate results.

### Dataset Semantics Difference

| Field | `gh-aw-token-dataset.jsonl` | `token-dataset.jsonl` (firewall) |
|-------|----------------------------|----------------------------------|
| `input_tokens` | **Includes** cache reads → compute `fresh_input = input_tokens - cache_read_tokens` | **Is already** fresh input (excludes cache) → use directly |

## Data Files (`paper-data/`)

| File | Description |
|------|-------------|
| `token-dataset.jsonl` | gh-aw-firewall token usage data (3,309 runs). One JSON object per workflow run. |
| `gh-aw-token-dataset.jsonl` | gh-aw token usage data (1,506 runs). One JSON object per workflow run. |
| `run-index.json` | Firewall run index with `milestones` (epoch definitions) and `runs` (summary per run). |
| `gh-aw-run-index.json` | gh-aw run index with milestones and runs. |
| `workload-augment.jsonl` | Supplemental workload metrics (gh CLI calls, MCP tool calls) per run_id. |
| `.skip-cache.json` | Already-processed run IDs for firewall (avoids re-downloading artifacts). |
| `.gh-aw-skip-cache.json` | Already-processed run IDs for gh-aw. |
| `figures/` | Generated analysis figures (fig1–fig6). |

### Dataset Record Schema

Each JSONL record contains:

```jsonc
{
  "run_id": 25407099334,          // GitHub Actions run ID
  "workflow": "Security Guard",    // Workflow display name
  "created_at": "2026-05-05T23:04:15Z",
  "date": "2026-05-05",
  "branch": "copilot/oidc-auth",
  "artifact": "agent",            // Artifact name downloaded
  "epoch": 6,                     // Optimization epoch (see milestones)
  "label": "sg-relevance-gate",   // Epoch label
  "description": "...",           // Epoch description
  "models": ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
  "providers": ["anthropic"],
  "api_calls": 9,                 // Number of LLM API calls
  "input_tokens": 3528,           // See semantics table above
  "output_tokens": 8551,
  "cache_read_tokens": 0,
  "cache_write_tokens": 12500,
  "total_tokens": 24579,
  "effective_tokens": 12079,      // Pre-computed (WRONG formula, do not use)
  "cache_hit_rate": 0.0,
  "cost_usd": 0.05
}
```

## Scripts

### `collect-token-data.ts` — Collect firewall data

Downloads token-usage artifacts from gh-aw-firewall workflow runs and writes `paper-data/token-dataset.jsonl`.

```bash
npx tsx scripts/paper/collect-token-data.ts [--output ./paper-data] [--dry-run]
```

- Queries GitHub Actions API per workflow × epoch date window
- Downloads and parses `agent` artifacts (token-usage JSON files)
- Skips already-processed runs via `.skip-cache.json`
- Writes/appends to `token-dataset.jsonl` and updates `run-index.json`
- Requires: `gh` CLI authenticated with repo access

### `collect-gh-aw-data.ts` — Collect gh-aw data

Same as above but targets the `github/gh-aw` repository.

```bash
npx tsx scripts/paper/collect-gh-aw-data.ts [--output ./paper-data] [--dry-run]
```

- Writes to `gh-aw-token-dataset.jsonl` and `gh-aw-run-index.json`
- Uses `.gh-aw-skip-cache.json` for deduplication
- Contains optimization milestones (epochs) specific to gh-aw workflows

### `analyze-token-data.ts` — Statistical analysis

Reads the JSONL datasets and computes per-epoch statistics.

```bash
npx tsx scripts/paper/analyze-token-data.ts [--input ./paper-data] [--format table|json|csv] [--workflow "Security Guard"]
```

- Per-epoch stats: median, mean, p25/p75 of ET
- Token reduction percentages relative to epoch 0 baseline
- Cache hit rate trends
- Cost savings estimates
- Model distribution over time

### `augment-workload.ts` — Workload metrics augmentation

Re-downloads artifacts to extract workload metrics not in the token dataset.

```bash
npx tsx scripts/paper/augment-workload.ts [--output ./paper-data] [--limit N]
```

- Extracts: `gh_cli_calls`, `gh_cli_by_cmd`, `gh_cli_success`, `mcp_tool_calls`, `squid_gh_calls`
- Output: `paper-data/workload-augment.jsonl` (joined on `run_id`)

### `generate-figures.py` — Generate analysis figures

Generates all paper figures from the datasets.

```bash
python3 scripts/paper/generate-figures.py
```

- Reads: `paper-data/token-dataset.jsonl`, `paper-data/workload-augment.jsonl`
- Outputs to `paper-data/figures/`:
  - `fig1-overall-epoch-trend.png` — Overall median ET by epoch
  - `fig2-per-workflow-epochs.png` — Per-workflow median ET by epoch
  - `fig3-mcp-vs-cli-migration.png` — MCP tool calls vs gh-CLI calls over epochs
  - `fig4-cache-hit-rate.png` — Cache hit rate by epoch
  - `fig5-workload-normalized.png` — ET-per-LLM-call (workload normalization)
  - `fig6-cost-per-run.png` — Cost per run distribution by epoch
- Requires: `matplotlib`, `pandas`, `numpy`

## Figures (`scripts/paper/`)

| Figure | Description |
|--------|-------------|
| `token-savings-combined.png` | Pre/post comparison across 5 workflows (Auto-Triage, Compiler, Attribution, Security Guard, Smoke Claude) using blog ET formula. Includes run counts as orange dots. |
| `token-savings-chart-v2.png` | Pre/post for gh-aw workflows only (3 workflows). |
| `token-savings-chart-v3.png` | Alternate version of v2. |
| `token-savings-firewall.png` | Pre/post for firewall workflows (Security Guard, Smoke Claude). |
| `token-savings-bubble.png` | Bubble chart variant. |
| `token-savings-total.png` | Total ET savings visualization. |

## Documents

| File | Description |
|------|-------------|
| `blog-post-draft.md` | Blog post draft referencing the figures and data. |
| `paper-draft.md` | Full academic paper draft. |
| `token-efficiency-results.xlsx` | Summary spreadsheet with key results. |

## Typical Workflow

### Update datasets with latest runs

```bash
# Collect new gh-aw-firewall data
npx tsx scripts/paper/collect-token-data.ts

# Collect new gh-aw data
npx tsx scripts/paper/collect-gh-aw-data.ts

# Augment with workload metrics
npx tsx scripts/paper/augment-workload.ts
```

### Regenerate all figures

```bash
# Generate the epoch-based figures (fig1–fig6)
python3 scripts/paper/generate-figures.py

# Run analysis to see updated stats
npx tsx scripts/paper/analyze-token-data.ts --format table
```

### Recreate the combined pre/post chart

The `token-savings-combined.png` chart is generated via inline Python (not a standalone script). To recreate it:

```python
# Key parameters:
# - Workflows: Auto-Triage Issues, Daily Compiler Quality Check,
#   Daily Community Attribution Updater, Security Guard, Smoke Claude
# - Optimization dates: 2026-04-14, 2026-04-17, 2026-04-15, 2026-04-03, 2026-04-14
# - Use blog ET formula with model multipliers
# - gh-aw data: subtract cache from input_tokens for fresh input
# - Firewall data: input_tokens IS fresh input (use directly)
# - Model multipliers: Haiku=0.25, Sonnet=1.0, Opus=5.0, gpt-5-mini=0.25
```

## Model Name Mappings

Models appear in different formats across datasets:

| gh-aw format | Firewall format | Multiplier |
|--------------|-----------------|------------|
| `claude-haiku-4.5` | `claude-haiku-4-5-20251001` | 0.25 |
| `claude-sonnet-4.6` | `claude-sonnet-4-6` | 1.0 |
| `claude-opus-4.5` | — | 5.0 |
| `gpt-5-mini` | `gpt-5-mini` | 0.25 |
| `gpt-4.1` | `gpt-4.1` | 0.5 |

## Optimization Dates (Pre/Post Split Points)

| Workflow | Repository | Date |
|----------|-----------|------|
| Auto-Triage Issues | gh-aw | 2026-04-14 |
| Daily Compiler Quality Check | gh-aw | 2026-04-17 |
| Daily Community Attribution Updater | gh-aw | 2026-04-15 |
| Contribution Check | gh-aw | 2026-04-14 |
| Security Guard | gh-aw-firewall | 2026-04-03 |
| Smoke Claude | gh-aw-firewall | 2026-04-14 |
| Smoke Copilot | gh-aw-firewall | 2026-04-03 (no pre-opt data in April) |

## Prerequisites

```bash
# Node.js (for TypeScript scripts)
npm install -g tsx

# Python (for figure generation)
pip install matplotlib pandas numpy

# GitHub CLI (for data collection)
gh auth login
```
