#!/usr/bin/env node
import { loadConfig, ConfigError, DEFAULT_BASE_URL } from './config.js';
import { SERVER_VERSION } from './context.js';
import { runDoctor } from './doctor.js';
import { startHttpServer } from './http-transport.js';
import { log, setLogLevel } from './log.js';
import { redactor } from './redact.js';
import { createContext, createMcpServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const HELP = `hb-hub-mcp ${SERVER_VERSION}: MCP server for the Healthier Business Hub API v2

Usage: hb-hub-mcp [--http [--port 3333] [--host 127.0.0.1]] [--doctor] [--version] [--help]

Transports
  (default)      stdio, for Claude Code, Claude Desktop, Cursor, Codex (npx -y @healthier-business/hub-mcp)
  --http         Streamable HTTP at http://HOST:PORT/mcp (loopback by default)

Environment
  HB_API_KEY              hbk_ API key (required for Hub calls; env only, never a tool argument)
  HB_BASE_URL             default ${DEFAULT_BASE_URL} (LIVE); use your sandbox URL while building
  HB_ENV                  live | sandbox   (override mode detection)
  HB_TOOL_MODE            compact (default, 7 tools) | full (one tool per operation)
  HB_TOOLSETS             comma list of portals for full mode (default all)
  HB_READ_ONLY            default true; false enables writes
  HB_ALLOW_LIVE_WRITES    default false; must be true (with HB_READ_ONLY=false) to write to the LIVE Hub
  HB_LOG_LEVEL            silent | error | warn (default) | info | debug   (stderr)
  HB_MAX_RESPONSE_CHARS   cap on a tool answer, default 60000
  HB_REQUEST_TIMEOUT_MS   default 30000
  HB_WEBHOOK_SECRET       default secret for hb_verify_webhook_signature
  HB_UPLOAD_DIRS          comma list of absolute directories hb_verify_certificate may read certificate files from (default: the working directory only)
  HB_MCP_HTTP_TOKEN       bearer token required by --http when not on loopback
  HB_MCP_HTTP_PORT, HB_MCP_HTTP_HOST   defaults for --http

--doctor checks the environment, reaches the base URL, tries the token exchange and prints scopes and mode (never secrets).
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`Configuration error: ${e instanceof ConfigError ? e.message : String(e)}\n`);
    process.exit(2);
  }
  setLogLevel(config.logLevel);
  redactor.add(config.apiKey);
  redactor.add(config.webhookSecret);

  if (args.includes('--doctor')) {
    const lines = await runDoctor(config);
    const sym = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', info: '    ' } as const;
    for (const l of lines) process.stdout.write(`${sym[l.level]} ${l.text}\n`);
    process.exit(lines.some((l) => l.level === 'fail') ? 1 : 0);
  }

  const ctx = createContext(config);
  log.info('starting', { mode: config.mode, tool_mode: config.toolMode, read_only: config.readOnly });
  if (config.mode === 'live') log.warn('pointing at the LIVE Hub');
  if (!config.apiKey) log.warn('HB_API_KEY is not set; Hub calls will fail until it is');

  const shutdown = (close: () => Promise<void>) => {
    let done = false;
    const handler = (signal: string) => {
      if (done) return;
      done = true;
      log.info('shutting down', { signal });
      close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  };

  if (args.includes('--http')) {
    const port = Number(flag(args, '--port') ?? process.env.HB_MCP_HTTP_PORT ?? 3333);
    const host = flag(args, '--host') ?? process.env.HB_MCP_HTTP_HOST ?? '127.0.0.1';
    const http = await startHttpServer(ctx, { host, port, authToken: process.env.HB_MCP_HTTP_TOKEN || undefined });
    process.stderr.write(`hb-hub-mcp listening on http://${host}:${http.port}/mcp (${config.mode})\n`);
    shutdown(http.close);
    return;
  }

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  shutdown(() => server.close());
  process.stdin.on('end', () => void server.close().finally(() => process.exit(0)));
}

main().catch((e) => {
  process.stderr.write(redactor.redact(`Fatal: ${e instanceof Error ? e.message : String(e)}`) + '\n');
  process.exit(1);
});
