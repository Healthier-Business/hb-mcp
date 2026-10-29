import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from './context.js';
import { log } from './log.js';
import { createMcpServer } from './server.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Required when binding to a non-loopback host. Clients send `Authorization: Bearer <token>`. */
  authToken?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

async function readJson(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** Streamable HTTP transport: one MCP session per client, all sharing the one token manager. */
export async function startHttpServer(ctx: AppContext, opts: HttpOptions): Promise<{ server: HttpServer; port: number; close: () => Promise<void> }> {
  if (!LOOPBACK.has(opts.host) && !opts.authToken) {
    throw new Error('Refusing to listen on a non-loopback address without HB_MCP_HTTP_TOKEN: anyone who could connect would act with your Hub key.');
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let boundPort = opts.port;
  const loopbackHosts = () => ['127.0.0.1', 'localhost', '[::1]'].flatMap((h) => [h, `${h}:${boundPort}`]);

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        return send(200, { ok: true });
      }
      if (url.pathname !== '/mcp') {
        return send(404, { error: 'not_found', message: 'The MCP endpoint is /mcp' });
      }
      if (opts.authToken && req.headers.authorization !== `Bearer ${opts.authToken}`) {
        return send(401, { error: 'unauthorized', message: 'Missing or wrong bearer token for this MCP server.' });
      }
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (existing) {
          return await existing.handleRequest(req, res, body);
        }
        if (typeof sessionId === 'string') {
          return send(404, { jsonrpc: '2.0', error: { code: -32001, message: 'Unknown session' }, id: null });
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
          enableDnsRebindingProtection: LOOPBACK.has(opts.host),
          allowedHosts: LOOPBACK.has(opts.host) ? loopbackHosts() : undefined,
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createMcpServer(ctx).connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      if (existing && (req.method === 'GET' || req.method === 'DELETE')) {
        return await existing.handleRequest(req, res);
      }
      return send(400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid session. POST an initialize request first.' }, id: null });
    } catch (e) {
      log.error('http transport error', { message: e instanceof Error ? e.message : 'unknown' });
      if (!res.headersSent) send(500, { error: 'server_error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, resolve);
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  boundPort = port;
  log.info('streamable http listening', { host: opts.host, port });
  return {
    server: http,
    port,
    close: async () => {
      for (const t of sessions.values()) await t.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
