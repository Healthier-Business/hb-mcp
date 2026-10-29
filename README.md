# Hub MCP server

`@healthier-business/hub-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for the **Healthier Business Hub API v2**. It lets an AI assistant (Claude Code, Claude Desktop, Cursor, Codex, any MCP client) use every Hub endpoint: 189 operations across the Hub core and ten portals, plus the 59 webhook events as knowledge.

It is built to be safe by default:

- **Read-only** until the owner turns writes on.
- **Sandbox first.** Live is real people and real credits; the server always says which one you are on.
- **Live writes are a two-step**: the first call returns a plan and sends nothing; the second needs `confirm: true`.
- **Keys never reach the model or a log.** The API key comes only from the environment.

Package name, bin and version: `@healthier-business/hub-mcp`, `hb-hub-mcp`, `0.1.0`. Not published yet (see "Publishing" below).

## Quickstart (sandbox first)

You need Node 20+, a **sandbox** base URL and a sandbox API key (`hbk_test_...`) from the developer portal. Sandboxes are separate from the Hub and hold synthetic data; see `hb://guides/testing-and-sandbox`. A live key is `hbk_...` from the Hub's Developer page.

Check your setup first (prints the mode and scopes, never the key):

```sh
HB_API_KEY=hbk_test_... HB_BASE_URL=https://YOUR-SANDBOX-URL npx -y @healthier-business/hub-mcp --doctor
```

### Claude Code

```sh
export HB_API_KEY=hbk_test_...        # in your shell, not in chat
claude mcp add hb-hub --scope project \
  --env HB_API_KEY="$HB_API_KEY" --env HB_BASE_URL="https://YOUR-SANDBOX-URL" --env HB_READ_ONLY=true \
  -- npx -y @healthier-business/hub-mcp
```

Or install the plugin (adds the server, a safe-workflow skill and `/hub-status`, `/hub-sandbox-test`) from a clone of this repo:

```sh
claude plugin marketplace add /path/to/hb-mcp
claude plugin install hb-hub@healthier-business
```

The plugin reads `HB_API_KEY`, `HB_BASE_URL`, `HB_READ_ONLY` and the other variables from your shell (`claude-plugin/.mcp.json`). Then ask Claude to run `/hub-status`.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and add the block from [`examples/claude-desktop-config.json`](examples/claude-desktop-config.json). Desktop has no variable interpolation, so the key sits in that file: use a **sandbox key** here. Restart Claude Desktop.

### Cursor

Project: copy [`.cursor/mcp.json`](.cursor/mcp.json) (it reads `HB_API_KEY` and `HB_BASE_URL` from your environment with `${env:...}`). Global: `~/.cursor/mcp.json`. One-click install link (fills in placeholders you must replace afterwards in Settings, MCP):

`cursor://anysphere.cursor-deeplink/mcp/install?name=hb-hub&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZWFsdGhpZXItYnVzaW5lc3MvaHViLW1jcCJdLCJlbnYiOnsiSEJfQVBJX0tFWSI6IllPVVJfU0FOREJPWF9LRVkiLCJIQl9CQVNFX1VSTCI6Imh0dHBzOi8vWU9VUi1TQU5EQk9YLVVSTCJ9fQ%3D%3D`

### Codex

Add [`examples/codex-config.toml`](examples/codex-config.toml) to `~/.codex/config.toml`:

```toml
[mcp_servers.hb-hub]
command = "npx"
args = ["-y", "@healthier-business/hub-mcp"]
env_vars = ["HB_API_KEY"]          # forwarded from your shell

[mcp_servers.hb-hub.env]
HB_BASE_URL = "https://YOUR-SANDBOX-URL"
HB_READ_ONLY = "true"
```

### Any other client

stdio: command `npx`, args `-y @healthier-business/hub-mcp`, environment as in the table below. HTTP: `hb-hub-mcp --http --port 3333` serves Streamable HTTP at `http://127.0.0.1:3333/mcp`.

### Then go live

When it works in the sandbox, follow the `go-live-checklist` prompt (or `hb://guides/going-live`): create a **live key with least-privilege scopes**, point `HB_BASE_URL` at `https://hub.hbcompliance.co.uk` (or remove it), run `--doctor`, and keep `HB_READ_ONLY=true` until the owner is ready for live writes.

## Tools

### Compact mode (default, `HB_TOOL_MODE=compact`): 7 tools

MCP clients degrade or cap beyond about 40 tools, so the default is a handful of meta tools that reach all 189 operations.

| Tool | What it does |
| --- | --- |
| `hb_status` | Who am I: environment (live/sandbox), base URL, key name and prefix, scopes, whether writes are enabled, last rate limit. |
| `hb_search_operations` | Search the operations by text, toolset (portal), method or scope. Says which are callable now and which the key's scopes allow. |
| `hb_describe_operation` | Full detail: parameters, body schema with required fields and example, scope, credits, health data, errors, idempotency, a ready example call. |
| `hb_call_operation` | Call any operation by id with `path_params`, `query`, `body`, `headers`. Validates against the spec first, adds `Idempotency-Key`, `all_pages` (capped), `fields` select, `confirm` for live writes. |
| `hb_list_events` | The 59 webhook events (filter by portal or text). |
| `hb_describe_event` | One event: payload schema, sample, delivery headers, verification rule. |
| `hb_verify_webhook_signature` | Local, no network: verify or compute `sha256=` HMAC of `{timestamp}.{body}` with the 300 second window. |

### Full mode (`HB_TOOL_MODE=full`)

One tool per operation, generated from the bundled spec, named from the operation id (`hub.candidates.list` becomes `hub_candidates_list`), plus `hb_status`, `hb_list_events`, `hb_describe_event` and `hb_verify_webhook_signature`. Path and query parameters are top-level arguments, `body` is the JSON body. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) come from the method and the spec's flags. While `HB_READ_ONLY=true`, write tools are hidden.

| Toolset (`HB_TOOLSETS`) | Operations | Reads | Writes |
| --- | --- | --- | --- |
| `hub` | 4 | 2 | 2 |
| `account` (webhooks) | 10 | 4 | 6 |
| `authentication` | 4 (1 exposed) | 1 | 3 |
| `online-training` | 14 | 12 | 2 |
| `occupational-health` | 30 | 24 | 6 |
| `references` | 11 | 5 | 6 |
| `practical-training` | 20 | 14 | 6 |
| `virtual-bls-training` | 14 | 9 | 5 |
| `clinical-interviews` | 13 | 8 | 5 |
| `registration-monitoring` | 29 | 17 | 12 |
| `dbs-rtw` | 32 | 19 | 13 |
| `clinical-appraisals` | 8 | 7 | 1 |
| **Total** | **189** | **122** | **67** |

Tool counts in full mode: all toolsets with writes on is 186 operation tools + 4 helpers = 190; read-only (default) is 122 read tools + 4 = 126 (`auth.me` is the only authentication tool). Use `HB_TOOLSETS` to stay under your client's limit, for example `HB_TOOLSETS=hub,occupational-health`.

The three credential operations (`auth.token.create`, `auth.refresh.create`, `auth.revoke.create`) are never exposed: the server exchanges the key and refreshes tokens itself, so a key or token never passes through a tool call.

### Resources and prompts

Resources: `hb://guides/<name>` (the 15 developer guides: `authentication`, `errors`, `scopes-and-permissions`, `idempotency`, `webhooks`, `going-live`, ...), `hb://portals/<toolset>`, `hb://spec/overview`, and templates `hb://spec/operations/{id}`, `hb://spec/events/{type}`.

Prompts: `book-practical-training`, `check-candidate-compliance`, `webhook-sandbox-setup`, `go-live-checklist`, `onboard-candidate`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HB_API_KEY` | none | The `hbk_` API key. Environment only; never a tool argument. |
| `HB_BASE_URL` | `https://hub.hbcompliance.co.uk` | **Live** by default. A sandbox looks like `https://<portal host>/sandbox/<uuid>` or `https://<name>.sandbox.<domain>`. `http` is allowed only for localhost. |
| `HB_ENV` | detected | `live` or `sandbox`: overrides detection. An unrecognised host is treated as **live**. |
| `HB_TOOL_MODE` | `compact` | `compact` (7 tools) or `full` (one per operation). |
| `HB_TOOLSETS` | all | Comma list of portals (full mode, and a limit on `hb_call_operation` too). |
| `HB_READ_ONLY` | `true` | `false` enables writes. |
| `HB_ALLOW_LIVE_WRITES` | `false` | Must be `true` (with `HB_READ_ONLY=false`) to write to the live Hub. |
| `HB_LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info`, `debug`. Logs go to stderr and hold metadata only. |
| `HB_MAX_RESPONSE_CHARS` | `60000` | Cap on one tool answer. Larger answers are cut with a notice (lists lose items first). |
| `HB_REQUEST_TIMEOUT_MS` | `30000` | Per request timeout. |
| `HB_WEBHOOK_SECRET` | none | Default secret for `hb_verify_webhook_signature`. |
| `HB_MCP_HTTP_TOKEN` | none | Bearer token required by `--http` when not bound to loopback. |
| `HB_MCP_HTTP_PORT`, `HB_MCP_HTTP_HOST` | `3333`, `127.0.0.1` | Defaults for `--http`. |

CLI: `hb-hub-mcp [--http [--port N] [--host H]] [--doctor] [--version] [--help]`.

## Safety model

| Rule | How |
| --- | --- |
| Read-only by default | Every non-GET operation is refused with an explanation, and hidden in full mode. |
| Writes need intent | `HB_READ_ONLY=false`. In a sandbox they then run directly. |
| Live writes need two more things | `HB_ALLOW_LIVE_WRITES=true`, and each write is a plan first (what happens, credits, health data, destructive) and runs only when called again with `confirm: true`. |
| Nothing blind-retried | A write is never retried automatically. A dropped connection returns the `idempotency_key` to reuse; a 401 is refreshed once (safe: not processed); 429 and 5xx on a write are returned to you. Reads retry on 429/502/503/504/network errors. |
| Idempotency | Writes that support it get an `Idempotency-Key` (a uuid, shown in the result). Same key and body within 24 hours replays the first answer. |
| Validation before sending | Path, query, headers and body are checked against the spec; a bad call sends nothing. |
| Secrets | Key, tokens and webhook secrets are registered with a redactor that scrubs every tool answer and log line, even if the Hub echoes one. Response bodies are never logged. |
| Health data | Operations flagged `x-health-data` return a `health_data` marker; the instructions tell the model to use only what the task needs. |
| Size | Answers over `HB_MAX_RESPONSE_CHARS` are truncated with a notice; use `fields` (dotted paths) and filters. |
| Scope of tokens | One refresher per process (single-flight), the single-use refresh token is replaced the moment a new pair arrives, and the 10 a minute auth throttle and `Retry-After` are respected. |
| Credentials | Credential endpoints are not tools. |

Money is integer pence with a currency; credits are units. The tool descriptions say which operations use credits.

## Egress and the key's IP allowlist

With the default **stdio** transport the server runs on the developer's own machine, so every Hub call leaves from **that machine's public IP**. If the key has an IP allowlist, the developer's own address must be on it (or the call fails with `403 ip_not_allowed`, and the error says what to do). With `--http` on a server, the server's address is what the Hub sees. Sandboxes do not enforce an allowlist unless switched on.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server not listed, or exits at once | Run `npx -y @healthier-business/hub-mcp --doctor` in the same environment the client uses. Node 20+ is required. Client logs show stderr. |
| `HB_API_KEY is not set` | Put the key in the client's server `env` (or export it before starting the client). Never paste it in chat. |
| `401 invalid_credentials` | Wrong, regenerated or deleted key, or a sandbox key against the live URL (or the other way round). `hb_status` and `--doctor` show the mode. |
| `403 insufficient_scope` | Add the named scope to the key on the Developer page (`:write` also grants `:read`). `hb_status` lists the key's scopes. |
| `403 ip_not_allowed` | The machine running the server is not on the key's allowlist (see the egress note). |
| `403 portal_unavailable` | The account does not use that portal. |
| `404` on a candidate | Use a real `candidate_ref` uuid from `hub.candidates.list`; sandbox refs mean nothing in live. |
| `422 validation_failed` | Fix the fields listed under `details`; nothing was changed. |
| `429 rate_limited` | Wait `retry_after_seconds`. The limit is per key (1,000 an hour by default). Use filters and `per_page` up to 100. Token calls are limited to 10 a minute. |
| "read-only" refusals | By design. Enable in a sandbox with `HB_READ_ONLY=false`; live also needs `HB_ALLOW_LIVE_WRITES=true`. |
| Too many tools in the client | Use compact mode (default) or `HB_TOOLSETS`. |
| Answer cut off | Use `fields`, narrower filters or a smaller `per_page`; or raise `HB_MAX_RESPONSE_CHARS`. |

## Development

```sh
npm install
npm run generate                      # spec/hub-v2.json -> generated/ (catalogue + events)
npm run build                         # generate + tsc to dist/
npm test                              # vitest; mock Hub built from the spec, no real network
npm run typecheck && npm run lint
npx tsx scripts/demo-transcript.ts    # built server over stdio with a real MCP client against the mock Hub
npm run spec:refresh -- /path/to/hub-v2.json [guides-dir portals-dir]
```

The tool catalogue is built from the bundled spec at build time and a test fails if `generated/` and `spec/hub-v2.json` disagree. To take a new Hub spec: `npm run spec:refresh -- <path>`, `npm test`, commit.

Layout: `src/` (config, catalogue, http, tokens, safety, errors, execute, output, tools, resources, prompts, server, cli), `spec/`, `generated/`, `content/` (bundled guides and portal docs), `claude-plugin/`, `examples/`, `test/`, `docs/design.md`.

## Publishing

Not published. Before publishing: confirm the npm scope (`@healthier-business` must be an npm org the team controls, otherwise rename in `package.json`, the configs and this README), run `npm run build && npm test`, then `npm publish --access public`. `npm pack --dry-run` shows what ships (`dist`, `generated`, `content`, the plugin).
