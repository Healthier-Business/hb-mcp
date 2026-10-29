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
| `tools/tasks.ts` and `tools/tasks-*.ts`, `tools/task-support.ts`, `tools/task-kit.ts` | The 28 curated task tools, the helper that runs operations through the executor (`TaskRun`), and the write-tool kit (`writeTask`: validate, gate, scope check, plan, confirm). `tasks-read*.ts` read tools, `tasks-write.ts`, `tasks-bookings.ts`, `tasks-people.ts`, `tasks-monitoring.ts`, `tasks-webhooks.ts` write tools. |
| `guides.ts` | Load the bundled guides (`content/guides`, then `content/guides/portal`, served as `hb://guides/portal-<name>`) and keyword-search them for `hb_search_guides`. |
| `resources.ts`, `prompts.ts`, `instructions.ts` | MCP resources, prompts, server instructions. |
| `server.ts` | Wire a low-level MCP `Server` to the registry. |
| `http-transport.ts`, `cli.ts`, `doctor.ts` | Streamable HTTP, CLI flags, `--doctor`. |

## Tool surface

Compact (default, 8 tools plus the task tools): `hb_status`, `hb_search_operations`, `hb_describe_operation`, `hb_call_operation`, `hb_list_events`, `hb_describe_event`, `hb_verify_webhook_signature`, `hb_search_guides`. Full: one tool per operation (`hub_candidates_list`, ...) plus the knowledge tools, filtered by `HB_TOOLSETS`, and by `HB_READ_ONLY` (write tools are hidden while read-only).

Task tools (28, offered in compact and full mode, added by `buildTools`; `HB_TASK_TOOLS` = all, core (10) or none): small jobs built on the generic pipeline. Each call goes through `Executor.call` (so validation, gates, idempotency, redaction, size cap and error mapping are the same), is checked against the key's scopes first (`auth.me.show`; wildcards `*` and `portal:*` count), skips what is not allowed and says so, and reports the operation ids it called. Thirteen only read (`hb_find_candidate`, `hb_candidate_overview`, `hb_training_progress`, `hb_list_bookings`, `hb_credits`, `hb_account_summary`, `hb_needs_attention`, `hb_monitoring_alerts`, `hb_worker_status`, `hb_billing_summary`, `hb_get_report`, `hb_webhook_health`, `hb_go_live_check`). Fifteen write and are hidden while the server is read-only (like write tools in full mode) and when their toolset is disabled. Tools return a readable text block and a second block of structured data.

Write task tools are built with `writeTask` and share one shape, in every environment: (1) validate the arguments, (2) refuse before any request if read-only, live writes are not allowed or the key lacks a scope (the message names it), (3) `plan()` reads only (candidate, options, credits, duplicates, current state) and returns the plan, the people who will be emailed and `problems`, (4) without `confirm: true` the plan is returned with the idempotency key and nothing is sent, (5) with `confirm: true` and no problems `execute()` sends, with keys derived from the base key (`<key>-hold`, `<key>-book`, ...). The tool-level confirm is the user's approval for the live gate of the operations it sends. Exceptions that read through a POST: `imports.preview` (uploads for validation, imports nothing). `hb_setup_sandbox_webhook` (the first task write tool) runs in one call and refuses on live.

- Privacy: `hb_candidate_overview` and `hb_monitoring_alerts` keep health data out by field allowlist: occupational health is request type, status label, dates, alert type and severity; clearance, form, documents, answers, names and contact details are never copied. `hb_needs_attention` reads occupational health only as counts. `hb_worker_status` returns the masked certificate number the API gives, never date of birth, contact details, registration numbers or evidence files. `hb_get_report` returns metadata and download instructions, never file bytes (with `check_download` the server fetches the file once to report type and size and discards it).
- Safety by construction: `hb_assign_training` sends existing + added - removed, because the Hub sets the exact course list. `hb_save_candidate` searches first and refuses a duplicate without `allow_duplicate`. `hb_acknowledge_alerts` refuses an unscoped bulk call (the Hub would acknowledge everything) unless `all_open` is set. `hb_bulk_import_workers` previews first and never shows sample rows. `hb_book_*` release their own hold if the booking is rejected (not when the outcome is unknown).
- Secrets: share codes and certificate numbers given to `hb_verify_worker` are registered with the redactor (so an error that echoes them is scrubbed) and shown only masked. The Hub shows a webhook signing secret once, in the create or rotate answer. The executor offers an in-process `onResponse` hook (never a tool argument) so `hb_setup_sandbox_webhook` and `hb_rotate_webhook_secret` can capture it, register it with the redactor and optionally write it to a new owner-only file (`save_secret_to`, never overwriting); it is never in the tool answer or a log. The redactor also scrubs `whsec_` strings by pattern, so the generic tools no longer echo a secret the Hub creates.
- `hb_go_live_check` cannot see the IP allowlist (the API does not expose it) and says so. The API gives no error text for failed deliveries, so `hb_webhook_health` summarises response codes.

The three credential operations (`auth.token.create`, `auth.refresh.create`, `auth.revoke.create`) are never exposed as tools: the server does the exchange itself, so a key or token never passes through a tool call. `auth.me.show` is available.

## Safety pipeline for a call

validate against the spec -> operation allowed (read-only, toolset)? -> live write needs confirm (return plan with credits and health-data notes) -> add `Idempotency-Key` to writes that declare it -> send -> 401: refresh once and retry (safe, the call was not processed) -> never auto-retry a write that may have been sent (network error returns the idempotency key to reuse) -> map errors -> paginate if asked -> select fields -> cap size -> redact -> mark health data.

## Sandbox vs live

Live is `https://hub.hbcompliance.co.uk` (the default). A sandbox base URL looks like `https://<portal host>/sandbox/<uuid>`; sandbox keys start `hbk_test_`. `HB_ENV=sandbox|live` overrides detection. With stdio the HTTP calls leave from the developer's own machine, so the key's IP allowlist sees that machine's address.

## Decisions made while building

- The server uses the SDK's low-level `Server` so tool input schemas are plain JSON Schema generated from the spec (the high-level `McpServer` wants zod shapes). `zod` is used for config and argument parsing.
- Path and query values are coerced when unambiguous (`"55"` to 55, `"true"` to true) because models often send strings.
- The generated catalogue stores each operation with its dereferenced schemas; full-mode tool schemas are slimmed (no examples, short descriptions) to keep the tool list small. `hb_describe_operation` returns the complete schema.
- Binary responses (PDF, images, CSV) come back as base64 or text within the size cap; files are never written to disk. Uploads use `{filename, content_base64 | content_text, content_type}` for file fields.
- Superseded tokens stay in the redactor for the life of the process, so a token the Hub echoes back later is still scrubbed.
- `--http` binds to loopback by default with DNS-rebinding protection; any other host requires `HB_MCP_HTTP_TOKEN`.
- Developer portal usage guides (21) are converted from the portal's own pages to plain Markdown (no images, steps as numbered lists, callouts as blockquotes) and bundled beside the API guides, so the assistant can guide a human through the console. `hb_search_guides` exists because the other tools only search operations and events; clients that do not browse resources could not otherwise reach the guides. With no key configured, the instructions, `hb_status` and the missing-key error point at the sign-up, sandbox and key guides, and the `get-started-in-sandbox` prompt walks the whole path.
