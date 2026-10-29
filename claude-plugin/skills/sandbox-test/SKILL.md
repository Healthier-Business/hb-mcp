---
name: sandbox-test
description: Try a Hub workflow safely in a sandbox before going live
argument-hint: "<what you want to do, e.g. book a practical training for a candidate>"
disable-model-invocation: true
---

The user wants to try this in a sandbox first: $ARGUMENTS

1. Call `hb_status`. If the environment is LIVE, stop and ask the user to change the plugin settings to a sandbox URL and an `hbk_test_` key with `/plugin configure hb-hub@healthier-business`, then restart Claude Code; do not continue on LIVE.
2. If writes are disabled and the task needs them, explain that the owner must set `HB_READ_ONLY=false` for the sandbox session.
3. Work out the operations with `hb_search_operations` and `hb_describe_operation`, run the workflow with `hb_call_operation`, and report each step with its `request_id`.
4. Finish with what worked, which errors were handled (402, 403, 404, 409, 422, 429) and what remains before going live (see the `go-live-checklist` prompt).
