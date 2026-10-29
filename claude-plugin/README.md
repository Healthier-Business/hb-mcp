# Healthier Business Hub for Claude Code

This plugin lets Claude use the Healthier Business Hub API v2: look up candidates and their training, occupational health, references, DBS and right to work, practical training, clinical interviews and appraisals, and manage webhooks. It starts in read-only mode and is meant to be used against a sandbox first.

## What it contains

- **An MCP server**, `hb-hub`, started with `npx` from the public npm package [`@healthier-business/hub-mcp`](https://www.npmjs.com/package/@healthier-business/hub-mcp). It runs the latest published version (`npx -y`). The source is public at [github.com/Healthier-Business/hb-mcp](https://github.com/Healthier-Business/hb-mcp).
- **Skills**: `hub-safe-workflow` (how Claude should use the Hub tools safely, preferring the task tools such as `hb_find_candidate` and `hb_candidate_overview` for common jobs), `/hb-hub:status` (which environment, key and scopes are in use) and `/hb-hub:sandbox-test` (try a workflow in a sandbox before going live).

## What it does with your data

- It sends requests only to the Hub base URL you enter when you install the plugin. It makes no other network calls and has no analytics or telemetry.
- Your API key is kept in your system's secure storage. It is never shown to Claude and never written to a log.
- Answers from the Hub, which can contain personal data about candidates, are returned to Claude in your session. The plugin stores nothing on its own, except that if you ask the sandbox webhook tool to save a new webhook signing secret to a file, it writes that one file to the path you give.
- Writes are off by default. Writing to the live Hub needs two explicit settings and a confirmation for every write.

## Install

In Claude Code:

```text
/plugin marketplace add Healthier-Business/hb-mcp
/plugin install hb-hub@healthier-business
```

Claude Code asks for your sandbox API key (it starts with `hbk_test_`) and your sandbox base URL. Both come from your sandbox in the Healthier Business developer portal. Change them later with `/plugin configure hb-hub@healthier-business`. Then run `/hb-hub:status`.

## Settings

`HB_READ_ONLY` (default `true`), `HB_ALLOW_LIVE_WRITES` (default `false`), `HB_TOOL_MODE` (default `compact`), `HB_TASK_TOOLS` (default `all`; `core` or `none` to offer fewer task tools) and `HB_LOG_LEVEL` (default `warn`) are read from your shell environment if you set them. Everything else is in the [server documentation](https://github.com/Healthier-Business/hb-mcp#readme).

## Licence

MIT. See `LICENSE`.
