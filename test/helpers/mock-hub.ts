import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assetPath } from '../../src/paths.js';

type J = any; // test helper only: the spec is walked dynamically

export const MOCK_KEY = 'hbk_test_mockkey0123456789abcdef';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
  json: unknown;
  opId?: string;
}

interface Queued {
  when: (r: RecordedRequest) => boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  drop?: boolean;
}

const spec: J = JSON.parse(readFileSync(assetPath('spec/hub-v2.json'), 'utf8'));

function deref(node: J, depth = 0): J {
  if (Array.isArray(node)) return node.map((n) => deref(n, depth));
  if (node && typeof node === 'object') {
    if (node.$ref) {
      if (depth > 12) return {};
      const target = node.$ref.replace(/^#\//, '').split('/').reduce((a: J, k: string) => a[k], spec);
      return deref(target, depth + 1);
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, depth)]));
  }
  return node;
}

export function sampleFromSchema(schema: J): unknown {
  if (!schema) return {};
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.enum) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: J) => sampleFromSchema(s)));
  if (schema.oneOf) return sampleFromSchema(schema.oneOf[0]);
  if (schema.anyOf) return sampleFromSchema(schema.anyOf[0]);
  const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
  switch (t) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v)]));
    case 'array': return [sampleFromSchema(schema.items)];
    case 'integer': return schema.minimum ?? 1;
    case 'number': return 1.5;
    case 'boolean': return true;
    case 'string':
      if (schema.format === 'uuid') return '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
      if (schema.format === 'date-time') return '2026-10-28T19:53:24Z';
      if (schema.format === 'date') return '2026-10-28';
      return 'text';
    default: return {};
  }
}

interface Route {
  re: RegExp;
  method: string;
  op: J;
  path: string;
}

const routes: Route[] = [];
for (const [path, item] of Object.entries<J>(spec.paths)) {
  const re = new RegExp('^' + path.replace(/\{[^}]+\}/g, '([^/]+)') + '$');
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    if (item[m]) routes.push({ re, method: m.toUpperCase(), op: item[m], path });
  }
}
// Literal paths first so /bookings/no-shows beats /bookings/{booking}.
routes.sort((a, b) => a.path.replace(/\{[^}]+\}/g, '~').localeCompare(b.path.replace(/\{[^}]+\}/g, '~')));

export class MockHub {
  server!: Server;
  url = '';
  requests: RecordedRequest[] = [];
  scopes: string[];
  exchanges = 0;
  refreshes = 0;
  issued: string[] = [];
  private access = new Map<string, { refresh: string; expires: number }>();
  private refresh = new Map<string, string>();
  private queue: Queued[] = [];
  private idem = new Map<string, { hash: string; status: number; body: string; headers: Record<string, string> }>();
  private remaining = 1000;
  accessTtlSeconds = 3600;
  authDelayMs = 0;

  constructor(scopes?: string[]) {
    this.scopes = scopes ?? [...new Set(Object.values<J>(spec.paths).flatMap((i) => Object.values<J>(i).map((o) => o['x-required-scope']).filter(Boolean)))] as string[];
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Make the next request matching `when` fail with this answer. */
  failNext(status: number, body: unknown, headers: Record<string, string> = {}, when: Queued['when'] = () => true): void {
    this.queue.push({ when, status, body, headers });
  }

  dropNext(when: Queued['when'] = () => true): void {
    this.queue.push({ when, drop: true });
  }

  expireAccessTokens(): void {
    for (const v of this.access.values()) v.expires = 0;
  }

  revokeAllAccessTokens(): void {
    this.access.clear();
    this.refresh.clear();
  }

  apiRequests(): RecordedRequest[] {
    return this.requests.filter((r) => !r.path.startsWith('/api/v2/auth/'));
  }

  private token(): { access: string; refresh: string } {
    const access = randomBytes(40).toString('hex');
    const refresh = randomBytes(40).toString('hex');
    this.access.set(access, { refresh, expires: Date.now() + this.accessTtlSeconds * 1000 });
    this.refresh.set(refresh, access);
    this.issued.push(access, refresh);
    return { access, refresh };
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', this.url);
    let json: unknown;
    try { json = raw && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : undefined; } catch { /* ignore */ }
    const rec: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: raw, json };
    const route = routes.find((r) => r.method === rec.method && r.re.test(rec.path));
    rec.opId = route?.op.operationId;
    this.requests.push(rec);

    const send = (status: number, body: unknown, headers: Record<string, string> = {}, ctype = 'application/json') => {
      res.writeHead(status, { 'Content-Type': ctype, 'X-Request-Id': 'req_' + this.requests.length, ...headers });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const err = (status: number, code: string, message: string, details?: unknown, headers: Record<string, string> = {}) =>
      send(status, { error: code, message, ...(details ? { details } : {}), request_id: 'req_' + this.requests.length }, headers);

    const qi = this.queue.findIndex((q) => q.when(rec));
    if (qi >= 0) {
      const q = this.queue.splice(qi, 1)[0] as Queued;
      if (q.drop) { req.socket.destroy(); return; }
      return send(q.status ?? 500, q.body, q.headers);
    }

    if (this.authDelayMs && rec.path.startsWith('/api/v2/auth/')) await new Promise((r) => setTimeout(r, this.authDelayMs));

    if (rec.path === '/api/v2/auth/token' && rec.method === 'POST') {
      const k = (json as J)?.api_key;
      if (!k) return err(422, 'validation_failed', 'The api key field is required.', { api_key: ['required'] });
      if (k !== MOCK_KEY) return err(401, 'invalid_credentials', 'The API key is not valid.');
      this.exchanges += 1;
      const t = this.token();
      return send(200, { token_type: 'Bearer', access_token: t.access, refresh_token: t.refresh, expires_in: this.accessTtlSeconds, refresh_expires_in: 604800 });
    }
    if (rec.path === '/api/v2/auth/refresh' && rec.method === 'POST') {
      const r = (json as J)?.refresh_token;
      const acc = this.refresh.get(r);
      if (!acc) return err(401, 'invalid_token', 'The refresh token is not valid.');
      this.refresh.delete(r);
      this.access.delete(acc);
      this.refreshes += 1;
      const t = this.token();
      return send(200, { token_type: 'Bearer', access_token: t.access, refresh_token: t.refresh, expires_in: this.accessTtlSeconds, refresh_expires_in: 604800 });
    }

    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) return err(401, 'unauthenticated', 'No bearer token was sent.');
    const entry = this.access.get(auth.slice(7));
    if (!entry || entry.expires <= Date.now()) return err(401, 'invalid_token', 'The token is not valid.');
    if (!route) return err(404, 'not_found', 'No such endpoint.');

    this.remaining = Math.max(0, this.remaining - 1);
    const rl = { 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': String(this.remaining), 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3000) };

    const needed: string | undefined = route.op['x-required-scope'];
    if (needed) {
      const ok = this.scopes.includes(needed) || (needed.endsWith(':read') && this.scopes.includes(needed.replace(/:read$/, ':write')));
      if (!ok) return err(403, 'insufficient_scope', `The key needs the scope ${needed}.`, undefined, rl);
    }

    if (rec.path === '/api/v2/auth/me') {
      return send(200, { client_id: 1001, key: { name: 'Mock key', prefix: MOCK_KEY.slice(0, 8), scopes: this.scopes, expires_at: null } }, rl);
    }

    const idemKey = String(req.headers['idempotency-key'] ?? '');
    if (idemKey && rec.method !== 'GET') {
      const hash = createHash('sha256').update(raw).digest('hex');
      const prev = this.idem.get(idemKey);
      if (prev) {
        if (prev.hash !== hash) return err(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different body.', undefined, rl);
        return send(prev.status, prev.body, { ...prev.headers, ...rl, 'Idempotent-Replayed': 'true' });
      }
    }

    // Validate required body fields against the spec so 422s are realistic.
    const bodySchema = route.op.requestBody?.content?.['application/json']?.schema;
    if (bodySchema && rec.method !== 'GET') {
      const s = deref(bodySchema);
      const missing = (s.required ?? []).filter((f: string) => (json as J)?.[f] === undefined);
      if (missing.length) return err(422, 'validation_failed', 'The given data was invalid.', Object.fromEntries(missing.map((m: string) => [m, [`The ${m} field is required.`]])), rl);
    }

    const successKey = Object.keys(route.op.responses).find((k) => k.startsWith('2')) ?? '200';
    const content = deref(route.op.responses[successKey])?.content ?? {};
    const ctype = Object.keys(content)[0];
    let status = Number(successKey);
    let payload: string | Buffer;
    let outType = 'application/json';
    if (!ctype) {
      payload = '';
    } else if (ctype.includes('json')) {
      const media = content[ctype];
      const sample: J = media.example !== undefined ? structuredClone(media.example) : sampleFromSchema(media.schema);
      if (sample?.meta && Array.isArray(sample.data)) {
        const page = Number(rec.query.get('page') ?? 1);
        sample.meta.page = page;
        sample.meta.last_page = 3;
        if (sample.meta.total !== undefined) sample.meta.total = 3 * sample.data.length;
        sample.data = sample.data.map((d: J) => (d && typeof d === 'object' ? { ...d, _page: page } : d));
      }
      if (rec.path.endsWith('/leak')) sample.data = this.issued[0];
      payload = JSON.stringify(sample);
    } else {
      outType = ctype;
      payload = ctype.startsWith('text/') ? 'a,b\n1,2\n' : Buffer.from('%PDF-1.4 mock');
    }
    const headers = { ...rl };
    if (idemKey && rec.method !== 'GET') {
      this.idem.set(idemKey, { hash: createHash('sha256').update(raw).digest('hex'), status, body: payload.toString(), headers: {} });
    }
    return send(status, payload, headers, outType);
  }
}
