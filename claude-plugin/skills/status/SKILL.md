---
name: status
description: Show which Hub environment, key and scopes the Hub MCP server is using. Use when the user asks which environment they are on, whether the Hub connection works, or what the key may do.
---

Call `hb_status` from the `hb-hub` MCP server and report, briefly: the environment (SANDBOX or LIVE), the base URL, whether writes are enabled, the key's name and prefix, and the scopes grouped by portal. Warn plainly if the environment is LIVE. If no key is configured, tell the user to run `/plugin configure hb-hub@healthier-business` and enter their sandbox key and URL there (never to paste the key into chat).
