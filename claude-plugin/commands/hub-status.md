---
description: Show which Hub environment, key and scopes the Hub MCP server is using
---

Call `hb_status` from the `hb-hub` MCP server and report, briefly: the environment (SANDBOX or LIVE), the base URL, whether writes are enabled, the key's name and prefix, and the scopes grouped by portal. Warn plainly if the environment is LIVE. If no key is configured, tell the user to set `HB_API_KEY` in their shell before starting Claude Code (never to paste it into chat).
