# Hub MCP server: design

Package `@healthier-business/hub-mcp`, binary `hb-hub-mcp`. A Model Context Protocol server that lets an AI assistant use the Healthier Business Hub API v2 (189 operations, 59 webhook events) safely. The contract is `spec/hub-v2.json`, a bundled copy of the Hub OpenAPI document.

## Principles

1. Read-only by default. Writes need `HB_READ_ONLY=false`; in live mode also `HB_ALLOW_LIVE_WRITES=true`, and every live write is a two-step: the first call returns the plan, the second (with `confirm: true`) executes it.
2. Sandbox first. Mode (`live` or `sandbox`) is derived from the base URL (or `HB_ENV`), and stated by `hb_status` and in the description of every write tool. An unrecognised host is treated as live.
3. Secrets never reach the model or a log. The API key comes only from `HB_API_KEY`. Keys, access tokens, refresh tokens and webhook secrets are registered with a redactor that scrubs every tool output and every log line. Response bodies are never logged.
4. Nothing drifts. Tool definitions are generated from the spec by `npm run generate` into `generated/`. A test fails if the committed catalogue and the spec disagree.
5. Few dependencies: `@modelcontextprotocol/sdk` and `zod` at runtime; Node's `fetch` for HTTP; our own small JSON-schema validator.

## Modules (`src/`)

| Module | Job |
| --- | --- |
| `config.ts` | Parse and validate env, derive mode, resolve toolsets. |
| `catalogue.ts` | Load `generated/catalogue.json` and `events.json`, search, lookup, toolset filter. |
| `generator/build.ts` | Pure function spec -> catalogue (used by `scripts/generate.ts` and the drift test). |
| `schema.ts` | Small JSON-schema validator and slimmer for tool input schemas. |
| `redact.ts`, `log.ts` | Secret registry and stderr logger (`HB_LOG_LEVEL`). |
| `tokens.ts` | Token manager: key -> token, single-flight refresh, rotation, auth throttle. |
| `http.ts` | Hub HTTP client: auth, 401 refresh-once, safe read retries, rate limit headers, multipart. |
| `safety.ts` | Read-only gate, live-write gate, confirmation plan. |
| `errors.ts` | Hub error body -> clear tool error with next steps. |
| `execute.ts` | The one execution pipeline shared by compact and full tools (validate, gate, call, paginate, select, cap, mark). |
| `output.ts` | `fields` selection, size cap with truncation notice. |
| `tools/compact.ts`, `tools/full.ts`, `tools/knowledge.ts` | Tool definitions per mode. |
| `resources.ts`, `prompts.ts`, `instructions.ts` | MCP resources, prompts, server instructions. |
| `server.ts` | Wire a low-level MCP `Server` to the registry. |
| `http-transport.ts`, `cli.ts`, `doctor.ts` | Streamable HTTP, CLI flags, `--doctor`. |

## Tool surface

Compact (default, 8 tools): `hb_status`, `hb_search_operations`, `hb_describe_operation`, `hb_call_operation`, `hb_list_events`, `hb_describe_event`, `hb_verify_webhook_signature`. Full: one tool per operation (`hub_candidates_list`, ...) plus the knowledge tools, filtered by `HB_TOOLSETS`, and by `HB_READ_ONLY` (write tools are hidden while read-only).

The three credential operations (`auth.token.create`, `auth.refresh.create`, `auth.revoke.create`) are never exposed as tools: the server does the exchange itself, so a key or token never passes through a tool call. `auth.me.show` is available.

## Safety pipeline for a call

validate against the spec -> operation allowed (read-only, toolset)? -> live write needs confirm (return plan with credits and health-data notes) -> add `Idempotency-Key` to writes that declare it -> send -> 401: refresh once and retry (safe, the call was not processed) -> never auto-retry a write that may have been sent (network error returns the idempotency key to reuse) -> map errors -> paginate if asked -> select fields -> cap size -> redact -> mark health data.

## Sandbox vs live

Live is `https://hub.hbcompliance.co.uk` (the default). A sandbox base URL looks like `https://<portal host>/sandbox/<uuid>` or `https://<name>.sandbox.<domain>`; sandbox keys start `hbk_test_`. `HB_ENV=sandbox|live` overrides detection. With stdio the HTTP calls leave from the developer's own machine, so the key's IP allowlist sees that machine's address.
