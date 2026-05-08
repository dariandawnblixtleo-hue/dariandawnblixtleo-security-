# AWF Configuration Specification (W3C-style)

## Status of This Document

This document defines the canonical configuration model for AWF (`awf`) and is intended for:

- `awf` CLI runtime loading (`--config`)
- tooling that compiles workflows to AWF invocations (including `gh-aw`)
- IDE/static validation via JSON Schema

The machine-readable schema is published at:

- `docs/awf-config.schema.json` — live schema (always reflects latest `main`)
- GitHub release asset `awf-config.schema.json` — versioned, stable URL per release
  (e.g. `https://github.com/github/gh-aw-firewall/releases/download/v0.23.1/awf-config.schema.json`)

## 1. Conformance

The normative keywords in this document are to be interpreted as described in RFC 2119.

An AWF config document is conforming when:

1. It is valid JSON or YAML.
2. Its data model satisfies `docs/awf-config.schema.json`.
3. Unknown properties are not present (closed-world schema).

## 2. Processing Model

1. The user invokes `awf --config <path|-> -- <command>`.
2. If `<path>` is `-`, AWF reads configuration bytes from stdin.
3. If `<path>` ends with `.json`, AWF parses as JSON.
4. If `<path>` ends with `.yaml` or `.yml`, AWF parses as YAML.
5. Otherwise, AWF attempts JSON parse first, then YAML parse.
6. AWF validates the parsed document and fails fast on validation errors.
7. AWF maps config fields to CLI option semantics.
8. **CLI options MUST take precedence over config file values**.

## 3. Precedence Rules

The effective configuration order is:

1. AWF internal defaults
2. Config file (`--config`)
3. Explicit CLI flags

This precedence model allows reusable checked-in configs with environment-specific CLI overrides.

## 4. Data Model

The root object MAY contain:

- `$schema`
- `network`
- `apiProxy`
- `security`
- `container`
- `environment`
- `logging`
- `rateLimiting`

Section semantics and constraints are defined by `docs/awf-config.schema.json`.

## 5. CLI Mapping (Normative)

Tools generating AWF invocations (such as `gh-aw`) SHOULD use this mapping:

- `network.allowDomains[]` → `--allow-domains <csv>`
- `network.blockDomains[]` → `--block-domains <csv>`
- `network.dnsServers[]` → `--dns-servers <csv>`
- `network.upstreamProxy` → `--upstream-proxy`
- `apiProxy.enabled` → `--enable-api-proxy`
- `apiProxy.enableOpenCode` → `--enable-opencode`
- `apiProxy.maxEffectiveTokens` → config-only (maps to API proxy effective-token guard)
- `apiProxy.modelMultipliers` → config-only (maps to API proxy effective-token multipliers)
- `apiProxy.targets.<provider>.host` → `--<provider>-api-target`
- `apiProxy.targets.openai.basePath` → `--openai-api-base-path`
- `apiProxy.targets.anthropic.basePath` → `--anthropic-api-base-path`
- `apiProxy.targets.gemini.basePath` → `--gemini-api-base-path`
- `security.sslBump` → `--ssl-bump`
- `security.enableDlp` → `--enable-dlp`
- `security.enableHostAccess` → `--enable-host-access`
- `security.allowHostPorts` → `--allow-host-ports`
- `security.allowHostServicePorts` → `--allow-host-service-ports`
- `security.difcProxy.host` → `--difc-proxy-host`
- `security.difcProxy.caCert` → `--difc-proxy-ca-cert`
- `container.memoryLimit` → `--memory-limit`
- `container.agentTimeout` → `--agent-timeout`
- `container.enableDind` → `--enable-dind`
- `container.workDir` → `--work-dir`
- `container.containerWorkDir` → `--container-workdir`
- `container.imageRegistry` → `--image-registry`
- `container.imageTag` → `--image-tag`
- `container.skipPull` → `--skip-pull`
- `container.buildLocal` → `--build-local`
- `container.agentImage` → `--agent-image`
- `container.tty` → `--tty`
- `container.dockerHost` → `--docker-host`
- `environment.envFile` → `--env-file`
- `environment.envAll` → `--env-all`
- `environment.excludeEnv[]` → repeated `--exclude-env`
- *(CLI-only)* `-e, --env <KEY=VALUE>` — no config-file equivalent by design
- `logging.logLevel` → `--log-level`
- `logging.diagnosticLogs` → `--diagnostic-logs`
- `logging.auditDir` → `--audit-dir`
- `logging.proxyLogsDir` → `--proxy-logs-dir`
- `logging.sessionStateDir` → `--session-state-dir`
- `rateLimiting.enabled: false` → `--no-rate-limit`
- `rateLimiting.requestsPerMinute` → `--rate-limit-rpm`
- `rateLimiting.requestsPerHour` → `--rate-limit-rph`
- `rateLimiting.bytesPerMinute` → `--rate-limit-bytes-pm`

## 6. Stdin Mode

AWF MUST support `--config -` for programmatic/pipeline scenarios.

## 7. Error Reporting

On parse or validation failure, AWF MUST:

1. exit non-zero
2. print an error describing location and reason
3. avoid partial execution

## 8. Environment Merge Semantics

The agent container's environment is constructed by merging variables from multiple
sources. This section defines the normative merge order and exclusion rules.

For usage guidance and examples, see [docs/environment.md](environment.md).

### 8.1 Merge Precedence (lowest → highest)

1. **AWF-reserved variables** — proxy routing, DNS, container paths (always set)
2. **`--env-all`** — inherited host environment (when enabled)
3. **`--env-file`** — variables read from a file
4. **`-e / --env`** — explicit CLI key-value pairs

A value set at a higher level MUST override any value from a lower level.

### 8.2 AWF-Reserved Variables

AWF MUST set the following variables in the agent container regardless of user
configuration. These MUST NOT be overridden by `--env-all` or `--env-file`:

| Variable | Value | Purpose |
|----------|-------|---------|
| `HTTP_PROXY` | `http://<squid-ip>:3128` | Squid forward proxy for HTTP |
| `HTTPS_PROXY` | `http://<squid-ip>:3128` | Squid forward proxy for HTTPS |
| `https_proxy` | `http://<squid-ip>:3128` | Lowercase alias for tools that only check lowercase (Yarn 4, undici) |
| `NO_PROXY` | `localhost,127.0.0.1,::1,...` | Loopback and container IPs bypassing Squid |
| `SQUID_PROXY_HOST` | `squid-proxy` | Proxy hostname for tools needing host separately |
| `SQUID_PROXY_PORT` | `3128` | Proxy port |
| `PATH` | Container default | MUST use the container's PATH, not the host's |
| `HOME` | Host user's home | Derived from `sudo`-aware detection |

**Note:** Lowercase `http_proxy` is intentionally NOT set. Some curl builds on
Ubuntu 22.04 ignore uppercase `HTTP_PROXY` for HTTP URLs (httpoxy mitigation),
causing HTTP traffic to fall through to iptables DNAT — the intended behavior.

### 8.3 Excluded Variables

The following variables MUST be excluded from `--env-all` and `--env-file`
passthrough. They are never inherited from the host:

- **System variables:** `PATH`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `SUDO_COMMAND`, `SUDO_USER`, `SUDO_UID`, `SUDO_GID`
- **Proxy variables:** `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY`, `all_proxy`, `FTP_PROXY`, `ftp_proxy`
- **Actions artifact tokens:** `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`
- **AWF internal controls:** `AWF_PREFLIGHT_BINARY`, `AWF_GEMINI_ENABLED`

Host proxy variables are **read** for upstream proxy auto-detection but are
excluded from the agent's environment. AWF sets its own proxy variables
pointing to Squid.

### 8.4 Selectively Forwarded Variables

When `--env-all` is NOT active, AWF SHOULD forward a selective set of
commonly needed host variables:

- **GitHub auth:** `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`
- **GitHub enterprise:** `GITHUB_SERVER_URL`, `GITHUB_API_URL`
- **Actions OIDC:** `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
- **Docker client:** `DOCKER_HOST`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM`
- **User environment:** `USER`, `XDG_CONFIG_HOME`

When `--env-all` IS active, all host variables not in the excluded set
(§8.3) are forwarded, subject to credential isolation rules (§9).

### 8.5 Explicit Overrides (`-e / --env`)

Variables passed via `-e` / `--env` MUST override all other sources, including
AWF-reserved variables. This is the **only** mechanism that can override proxy
routing variables.

There is no config-file equivalent for `-e / --env` by design. Individual
environment variable injection is a runtime concern, not a static configuration
concern.

## 9. Credential Isolation Semantics

AWF implements defense-in-depth credential isolation for LLM API keys. The
behavior depends on whether the API proxy sidecar is enabled (`apiProxy.enabled`).

For architectural details and diagrams, see
[docs/authentication-architecture.md](authentication-architecture.md).

### 9.1 Source Credentials

The following environment variables are recognized as **source credentials**
(real API keys read from the host environment):

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot |
| `COPILOT_API_KEY` | GitHub Copilot (BYOK) |
| `GEMINI_API_KEY` | Google Gemini |

Secondary aliases recognized: `OPENAI_KEY`, `CODEX_API_KEY`, `CLAUDE_API_KEY`,
`COPILOT_PROVIDER_API_KEY`.

### 9.2 Behavior When API Proxy Is Enabled

When `apiProxy.enabled` is `true`:

1. Source credentials MUST NOT be exposed to the agent container's environment.
   They are passed exclusively to the API proxy sidecar.
2. `--env-all` MUST NOT reintroduce excluded credentials into the agent
   environment when API proxy isolation is active.
3. AWF MAY inject **placeholder values** into the agent container for tool
   compatibility (e.g., `OPENAI_API_KEY=sk-placeholder-for-api-proxy`).
   These are not secrets.
4. AWF MUST inject **proxy-routing variables** so agent tools reach the
   sidecar instead of upstream APIs:

   | Agent variable | Value | Purpose |
   |----------------|-------|---------|
   | `OPENAI_BASE_URL` | `http://172.30.0.30:10000` | Routes OpenAI calls to sidecar |
   | `ANTHROPIC_BASE_URL` | `http://172.30.0.30:10001` | Routes Anthropic calls to sidecar |
   | `COPILOT_API_URL` | `http://172.30.0.30:10002` | Routes Copilot calls to sidecar |
   | `GOOGLE_GEMINI_BASE_URL` | `http://172.30.0.30:10003` | Routes Gemini calls to sidecar |
   | `GEMINI_API_BASE_URL` | `http://172.30.0.30:10003` | Gemini alias for compatibility |

5. The API proxy sidecar injects the real credentials into upstream requests.
   Sidecar ports: 10000 (OpenAI), 10001 (Anthropic), 10002 (Copilot),
   10003 (Gemini), 10004 (OpenCode).

### 9.3 Behavior When API Proxy Is Disabled

When `apiProxy.enabled` is `false` (default):

1. Source credentials present in the host environment SHOULD be forwarded
   directly to the agent container.
2. No proxy-routing variables or placeholders are injected.

### 9.4 One-Shot Token Protection

Real credentials forwarded to the agent (whether source credentials in
non-proxy mode or `GITHUB_TOKEN` / `GH_TOKEN`) MUST be protected by the
one-shot-token mechanism. Protected tokens are cached on first access and
unset from `/proc/self/environ` to prevent environment variable inspection.

The default protected token list is:

```
COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, GITHUB_API_TOKEN,
GITHUB_PAT, GH_ACCESS_TOKEN, OPENAI_API_KEY, OPENAI_KEY,
ANTHROPIC_API_KEY, CLAUDE_API_KEY, CODEX_API_KEY, COPILOT_API_KEY,
COPILOT_PROVIDER_API_KEY
```

Placeholder compatibility values (§9.2 item 3) are NOT secrets and are not
subject to one-shot protection.

### 9.5 DIFC Proxy Credential Isolation

When `security.difcProxy.host` is set, `GITHUB_TOKEN` and `GH_TOKEN` MUST be
excluded from the agent environment. Tokens are held by the external DIFC proxy.
