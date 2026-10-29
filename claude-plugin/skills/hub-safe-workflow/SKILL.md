---
name: hub-safe-workflow
description: How to use the Healthier Business Hub API v2 MCP tools safely. Use whenever the user asks to look up, create, book, cancel or change anything in the Hub (candidates, Occupational Health, Online Training, practical training, references, DBS and right to work, webhooks).
---

# Using the Hub MCP server safely

The `hb-hub` MCP server talks to the Hub API v2. It is read-only by default and tells you whether it points at a SANDBOX (synthetic data) or the LIVE Hub (real people).

## Always

1. Call `hb_status` first. State the environment (sandbox or LIVE) and whether writes are enabled.
2. For the common jobs use the task tools first: they do the job in one call with safe defaults and list the operation ids they used. Read tools: `hb_find_candidate` (find a person), `hb_candidate_overview` (one line per record across portals; health data only as statuses and dates), `hb_training_progress`, `hb_list_bookings`, `hb_credits`, `hb_account_summary`, `hb_needs_attention`, `hb_monitoring_alerts`, `hb_worker_status`, `hb_billing_summary`, `hb_get_report` (details and how to download, never file bytes), `hb_webhook_health`, `hb_go_live_check`, `hb_verification_status` (follow certificate verifications: status, result, timeline). Write tools (offered only when writes are enabled): `hb_book_practical_training`, `hb_book_slot`, `hb_change_booking`, `hb_invite_to_practical`, `hb_save_candidate`, `hb_assign_training`, `hb_request_references`, `hb_request_occupational_health`, `hb_chase_outstanding`, `hb_verify_worker`, `hb_acknowledge_alerts`, `hb_bulk_import_workers`, `hb_redeliver_webhooks`, `hb_rotate_webhook_secret`, `hb_verify_certificate` (check a training certificate file; see below) and `hb_setup_sandbox_webhook` (sandbox only). A pending certificate verification is cancelled with `hb_change_booking` (portal `training-verification`). Every write task tool is two calls: the first returns the options or plan (who is emailed, credits, diffs) and sends nothing; show it to the user and call again with `confirm: true` only after they say yes, reusing the `idempotency_key`. Webhook secrets are never returned: offer `save_secret_to` if the user wants one kept. If the server was started with `HB_TASK_TOOLS=core` or `none`, some of these are absent: use the generic tools below.
   For anything else, find operations with `hb_search_operations`, read the exact shape with `hb_describe_operation`, run with `hb_call_operation`.
3. People are addressed by `candidate_ref` (a uuid). Look the candidate up first; never invent or reuse a ref from a different environment.
4. Keep answers small: use filters, `per_page`, and the `fields` argument. Use `all_pages` only when you need everything.
5. Quote the `request_id` when you report an error. For 403 `insufficient_scope` tell the user which scope the key needs; do not try other endpoints to get around it.

## Writes

- Try writes in a sandbox first. In a sandbox they run directly.
- In LIVE, the first write call returns a plan and sends nothing. Show the plan (what changes, credits, health data) to the user and call again with `confirm: true` only after they say yes. Reuse the plan's `idempotency_key`.
- If a write's outcome is unknown (timeout, dropped connection), do not repeat it blindly: read the record, or repeat with the same `idempotency_key`.
- Credits are units; money is integer pence with a currency. Say which an operation uses before running it.

## Verifying a training certificate

- Use `hb_verify_certificate`, never `hb_call_operation`, to upload a certificate. Call 1 checks the file locally and shows file name, size, type, SHA-256, who gets the result email, the price and the balance, and sends nothing. Tell the user the price first: Automated is free for a regular account (one that also uses other Hub services) and charged for a verification-only account; Manual is always charged; only credits or the wallet pay, never a card. Call again with `confirm: true`, the `idempotency_key` and the `file_sha256` from the plan only after the user says yes.
- The file must be inside a folder of `HB_UPLOAD_DIRS` (default: the folder Claude Code was started in). If it is refused (outside the folders, a hidden file, a link that leaves them, a wrong type, too big), tell the user to move it into an allowed folder or add one in their shell environment; do not try other paths.
- A certificate is personal data. Never print, paste or summarise the file contents or its base64; show only name, size and SHA-256. Follow the result with `hb_verification_status`; the report and certificate are downloaded outside the chat (`hb_get_report` says how).

## Secrets and health data

- Never ask the user for an API key, token or webhook secret in chat, and never print one. The key lives only in the server's environment (`HB_API_KEY`).
- Results marked `health_data` are special-category data: use only what the task needs and do not copy it elsewhere.

## Going live

Use the `go-live-checklist` MCP prompt and the `hb://guides/going-live` resource. Never run a live write as part of a checklist unless the user asks.
