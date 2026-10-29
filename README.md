# Hub MCP server

`@healthier-business/hub-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for the **Healthier Business Hub API v2**. It lets an AI assistant (Claude Code, Claude Desktop, Cursor, Codex, any MCP client) use every Hub endpoint: 189 operations across the Hub core and ten portals, plus the 59 webhook events as knowledge.

It is built to be safe by default:

- **Read-only** until the owner turns writes on.
- **Sandbox first.** Live is real people and real credits; the server always says which one you are on.
- **Live writes are a two-step**: the first call returns a plan and sends nothing; the second needs `confirm: true`.
- **Keys never reach the model or a log.** The API key comes only from the environment.

Package: `@healthier-business/hub-mcp`. Command: `hb-hub-mcp`. Needs Node 20 or newer.

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

Then ask Claude to check the connection: "Run hb_status". It tells you whether you are on the sandbox or live, which key it is using and what the key may do.

Or install it as a Claude Code plugin. The plugin adds the server, a safe-workflow skill and the commands `/hub-status` and `/hub-sandbox-test`. Set your key and your sandbox URL in the shell before you start Claude Code, then run:

```sh
export HB_API_KEY=hbk_test_...
export HB_BASE_URL=https://YOUR-SANDBOX-URL
```

```text
/plugin marketplace add Healthier-Business/hb-mcp
/plugin install hb-hub@healthier-business
```

The plugin reads `HB_API_KEY`, `HB_BASE_URL`, `HB_READ_ONLY` and the other variables from your shell. It has no default URL, so it never points at the live Hub by accident.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and add this block. Desktop has no variable interpolation, so the key sits in that file: use a **sandbox key** here. Restart Claude Desktop.

```json
{
  "mcpServers": {
    "hb-hub": {
      "command": "npx",
      "args": ["-y", "@healthier-business/hub-mcp"],
      "env": {
        "HB_API_KEY": "hbk_test_PASTE_YOUR_SANDBOX_KEY_HERE",
        "HB_BASE_URL": "https://YOUR-SANDBOX-URL",
        "HB_READ_ONLY": "true"
      }
    }
  }
}
```

### Cursor

Project: save this as `.cursor/mcp.json` (it reads `HB_API_KEY` and `HB_BASE_URL` from your environment with `${env:...}`). Global: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "hb-hub": {
      "command": "npx",
      "args": ["-y", "@healthier-business/hub-mcp"],
      "env": {
        "HB_API_KEY": "${env:HB_API_KEY}",
        "HB_BASE_URL": "${env:HB_BASE_URL}",
        "HB_READ_ONLY": "true"
      }
    }
  }
}
```

One-click install link (fills in placeholders you must replace afterwards in Settings, MCP):

`cursor://anysphere.cursor-deeplink/mcp/install?name=hb-hub&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZWFsdGhpZXItYnVzaW5lc3MvaHViLW1jcCJdLCJlbnYiOnsiSEJfQVBJX0tFWSI6IllPVVJfU0FOREJPWF9LRVkiLCJIQl9CQVNFX1VSTCI6Imh0dHBzOi8vWU9VUi1TQU5EQk9YLVVSTCJ9fQ%3D%3D`

### Codex

Add this to `~/.codex/config.toml`:

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

### Compact mode (default, `HB_TOOL_MODE=compact`): 8 tools

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
| `hb_search_guides` | Local, no network, no key needed: keyword search over the 36 bundled guides (15 API, 21 developer portal); returns the best matches with a snippet and the `hb://guides/<name>` to read. Useful for clients that do not browse resources. |

### Full mode (`HB_TOOL_MODE=full`)

One tool per operation, generated from the bundled spec, named from the operation id (`hub.candidates.list` becomes `hub_candidates_list`), plus `hb_status`, `hb_list_events`, `hb_describe_event`, `hb_verify_webhook_signature` and `hb_search_guides`. Path and query parameters are top-level arguments, `body` is the JSON body. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) come from the method and the spec's flags. While `HB_READ_ONLY=true`, write tools are hidden.

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

Tool counts in full mode: all toolsets with writes on is 186 operation tools + 5 helpers = 191; read-only (default) is 122 read tools + 5 = 127 (`auth.me` is the only authentication tool). Use `HB_TOOLSETS` to stay under your client's limit, for example `HB_TOOLSETS=hub,occupational-health`.

The three credential operations (`auth.token.create`, `auth.refresh.create`, `auth.revoke.create`) are never exposed: the server exchanges the key and refreshes tokens itself, so a key or token never passes through a tool call.

### Resources and prompts

Resources: `hb://guides/<name>` (the 15 API developer guides and 21 developer portal guides, 36 in all; API guides: `authentication`, `errors`, `scopes-and-permissions`, `idempotency`, `webhooks`, `going-live`, ...), `hb://portals/<toolset>`, `hb://spec/overview`, and templates `hb://spec/operations/{id}`, `hb://spec/events/{type}`.

Prompts: `get-started-in-sandbox` (sign up, sandbox, key, `--doctor`, first read), `book-practical-training`, `check-candidate-compliance`, `webhook-sandbox-setup`, `go-live-checklist`, `onboard-candidate`.

### Developer portal guides

The developer portal is where a developer signs up, makes sandboxes, test keys and webhooks, and uses the API Playground. Its 21 usage guides are bundled as resources `hb://guides/portal-<name>` (source files in `content/guides/portal/`), listed after the 15 API guides, so an assistant can explain the portal as well as the API. When no key is configured the server instructions, `hb_status` and the missing-key error point to the first three.

| Resource | What it covers |
| --- | --- |
| `hb://guides/portal-overview` | What the Healthier Business developer portal is, what is in it and the shortest path from a new account to a working integration. |
| `hb://guides/portal-create-your-account` | Sign up for the developer console with your work email address, every field of the form, the rules for passwords and email addresses, and what each error message means. |
| `hb://guides/portal-verify-your-email` | What the Check your inbox page does, how long the confirmation link lasts, how to get another email and what to do when it does not arrive. |
| `hb://guides/portal-sign-in-and-security` | Signing in, resetting a forgotten password, turning on two-step sign-in with an authenticator app, recovery codes, and how sessions and lockouts behave. |
| `hb://guides/portal-the-console-tour` | A walk through the console: the sidebar, the getting started checklist, the account menu, the theme switch, and how it looks on a phone. |
| `hb://guides/portal-sandboxes` | Create, rename, reset and delete sandboxes, read their addresses and numbers, and understand what a sandbox contains and what it never does. |
| `hb://guides/portal-api-keys-and-tokens` | Create test keys with the access you need, see a key once, roll and delete it, then exchange it for an access token and refresh it. |
| `hb://guides/portal-calling-the-api-from-curl-and-postman` | Make your first calls to a sandbox with curl, import the OpenAPI document or Postman collection, and use variables so the same requests work against production later. |
| `hb://guides/portal-webhooks` | Register an https endpoint in a sandbox, choose events, keep the signing secret, verify every signature, test and simulate events, read the delivery log, and understand retries and automatic switch-off. |
| `hb://guides/portal-data-page-and-json-viewer` | Look at every table of a sandbox, search and sort it, and open a record as an expandable JSON tree. |
| `hb://guides/portal-simulate` | Make the things only a person or a clock can do happen inside a sandbox, such as a candidate paying or an interview ending, and see the webhook events, emails and data changes they cause. |
| `hb://guides/portal-api-playground` | Build and send requests to a sandbox from the console, exchange a key for a token, save requests in collections, use variables, read responses, copy code in four languages and switch to live calls. |
| `hb://guides/portal-request-log-and-debugging` | Read every call your sandbox answered, filter by method and result, open a call to see both bodies, and work out why a call failed using the error code and request id. |
| `hb://guides/portal-inbox-and-notifications` | See the emails and texts a sandbox would have sent to candidates, search and filter them, and turn on notifications on your own device. |
| `hb://guides/portal-support-and-booking-a-call` | Ask the API team a question from the console, read their answers, choose what you need (including a paid technical support call paid with HB Pay), and what to put in a message so it is answered quickly. |
| `hb://guides/portal-go-to-production` | The checklist for moving an integration from a sandbox to the live HB Hub, doing it by hand or connecting your HB Hub account to manage production keys and webhooks from the console. |
| `hb://guides/portal-profile-and-security` | Your name, time zone and password, the account security page, downloading your data and deleting your account. |
| `hb://guides/portal-moving-from-legacy-apis-to-v2` | A step by step migration from the per-service legacy APIs to the single Hub API v2: what changes, how to try it in a sandbox now, and how to switch to live when the Compliance Hub is released. |
| `hb://guides/portal-reading-the-api-reference` | How the developer site is laid out, how to search it, what is on an endpoint page, how Try it works, and the tools around the reference (Ask AI, Copy for LLM, llms.txt, OpenAPI). |
| `hb://guides/portal-rate-limits-errors-and-idempotency` | The limits that apply to keys and tokens, every error code and what to do about it, retry rules and how idempotency keys make repeated creates safe. |
| `hb://guides/portal-faq-and-troubleshooting` | Short answers to the questions developers ask most, grouped by the part of the portal, with where to look when something does not work. |

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HB_API_KEY` | none | The `hbk_` API key. Environment only; never a tool argument. |
| `HB_BASE_URL` | `https://hub.hbcompliance.co.uk` | **Live** by default. A sandbox looks like `https://<portal host>/sandbox/<uuid>`. `http` is allowed only for localhost. |
| `HB_ENV` | detected | `live` or `sandbox`: overrides detection. An unrecognised host is treated as **live**. |
| `HB_TOOL_MODE` | `compact` | `compact` (8 tools) or `full` (one per operation). |
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
