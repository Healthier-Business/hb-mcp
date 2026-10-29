#!/usr/bin/env sh
# Claude Code: add the server for this project (key from your shell, sandbox URL, read-only).
claude mcp add hb-hub --scope project \
  --env HB_API_KEY="$HB_API_KEY" \
  --env HB_BASE_URL="https://YOUR-SANDBOX-URL" \
  --env HB_READ_ONLY=true \
  -- npx -y @healthier-business/hub-mcp

# Or install the plugin (skill, slash commands and the server) from a clone of this repo:
#   claude plugin marketplace add /path/to/hb-mcp
#   claude plugin install hb-hub@healthier-business
