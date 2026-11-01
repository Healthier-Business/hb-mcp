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
  /** Parsed multipart/form-data: text fields, and for each file its name, type, size and SHA-256 (the bytes are not kept). */
  form?: { fields: Record<string, string>; files: Record<string, { filename: string; contentType: string; size: number; sha256: string }> };
  opId?: string;
}

/** The Training Verification account the mock models (change it in a test to model other accounts). */
export interface TvModel {
  clientType: 'regular' | 'verification_only';
  moneyPence: number;
  autoCredits: number;
  manualCredits: number;
  legacyBalancePence: number;
  maxCertificateKb: number;
  certificateTypes: string[];
  defaultNotifyEmail: string | null;
}

interface TvVerification {
  id: number;
  request_type: string;
  status: string;
  candidate_name: string;
  candidate_email: string;
  agency_name_on_cert: string;
  notify_email: string | null;
  candidate_ref: string | null;
  client_reference: string | null;
  charge: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reason: { code: string; message: string } | null;
  events: { id: number; event: string; occurred_at: string; reason_code: string | null; amount_pence: number | null }[];
  certificate: { filename: string; contentType: string; size: number; sha256: string };
}

const TV_PRICES = { auto: { net: 500, vat: 100 }, manual: { net: 1000, vat: 200 } } as const;

function parseMultipart(buf: Buffer, contentType: string): NonNullable<RecordedRequest['form']> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const form: NonNullable<RecordedRequest['form']> = { fields: {}, files: {} };
  if (!boundary) return form;
  const delimiter = '--' + (boundary[1] ?? boundary[2]);
  const text = buf.toString('latin1');
  for (const part of text.split(delimiter).slice(1)) {
    if (part.startsWith('--')) break;
    const cut = part.indexOf('\r\n\r\n');
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    const body = part.slice(cut + 4, part.endsWith('\r\n') ? -2 : undefined);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) {
      form.fields[name] = Buffer.from(body, 'latin1').toString('utf8');
    } else {
      const bytes = Buffer.from(body, 'latin1');
      form.files[name] = { filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  return form;
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
routes.sort((a, b) => {
  const x = a.path.split('/');
  const y = b.path.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const px = x[i]!.startsWith('{');
    const py = y[i]!.startsWith('{');
    if (px !== py) return px ? 1 : -1;
    if (!px && x[i] !== y[i]) return x[i]!.localeCompare(y[i]!);
  }
  return x.length - y.length;
});

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
  tv: TvModel = { clientType: 'regular', moneyPence: 4800, autoCredits: 0, manualCredits: 0, legacyBalancePence: 0, maxCertificateKb: 5120, certificateTypes: ['pdf', 'jpg', 'jpeg', 'png'], defaultNotifyEmail: 'verifications@example.com' };
  /** Verifications created through the mock (or seeded by a test). While empty, the list answers with the spec example. */
  tvVerifications: TvVerification[] = [];
  private tvNextId = 5001;

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

  /** Portal key to the `api_access_*` code that portal's calls are refused with (a live client without approval). */
  approvalRefusals = new Map<string, string>();

  /** What `GET /account/api-access` answers. The default is a sandbox: everything open. */
  apiAccessRows: { area: string; label: string; sensitive: boolean; status: string; decided_at: string | null }[] = [
    { area: 'occupational-health', label: 'Occupational Health', sensitive: true, status: 'not_required', decided_at: null },
    { area: 'dbs-rtw', label: 'DBS & Right To Work', sensitive: true, status: 'not_required', decided_at: null },
    { area: 'online-training', label: 'Online Training', sensitive: false, status: 'not_required', decided_at: null },
  ];

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

  /** Add a verification to the mock account (for tests that need a particular state). */
  seedVerification(over: Partial<TvVerification> = {}): TvVerification {
    const now = '2026-10-28T19:53:24Z';
    const v: TvVerification = {
      id: this.tvNextId++, request_type: 'auto', status: 'pending', candidate_name: 'Jo Smith', candidate_email: 'jo.smith@example.com', agency_name_on_cert: 'Healthy Staffing Ltd',
      notify_email: 'hr@example.com', candidate_ref: null, client_reference: null, charge: { free: true, funding: 'free', amount_pence: 0, credits_used: 0, currency: 'GBP', refunded: false },
      created_at: now, updated_at: now, completed_at: null, reason: null, events: [{ id: 1, event: 'submitted', occurred_at: now, reason_code: null, amount_pence: null }],
      certificate: { filename: 'cert.pdf', contentType: 'application/pdf', size: 40, sha256: '0'.repeat(64) }, ...over,
    };
    this.tvVerifications.push(v);
    return v;
  }

  private tvPrice(type: 'auto' | 'manual') {
    const free = type === 'auto' && this.tv.clientType === 'regular';
    const p = TV_PRICES[type];
    return {
      request_type: type, free, net_pence: free ? 0 : p.net, vat_pence: free ? 0 : p.vat, gross_pence: free ? 0 : p.net + p.vat, currency: 'GBP',
      reason: free ? { code: 'included_with_other_services', message: 'Automated verification is included with your other Hub services.' } : { code: this.tv.clientType === 'verification_only' ? 'verification_only_account' : 'manual_verification_charged', message: 'This verification is charged.' },
    };
  }

  private tvPublic(v: TvVerification, full: boolean): Record<string, unknown> {
    const final = ['verified', 'not_found', 'rejected', 'failed'].includes(v.status);
    return {
      id: v.id, client_reference: v.client_reference, request_type: v.request_type, status: v.status, candidate_name: v.candidate_name, candidate_email: v.candidate_email, agency_name_on_cert: v.agency_name_on_cert,
      notify_email: v.notify_email, candidate_ref: v.candidate_ref,
      result: final ? { matched: v.status === 'verified', provider: v.status === 'verified' ? v.agency_name_on_cert : null, records: v.status === 'verified' && full ? [{ title: 'Fire Safety', completed_on: '2026-02-01', expires_on: '2027-02-01', type: 'e-learning' }] : null, reason: v.reason } : null,
      charge: v.charge, created_at: v.created_at, updated_at: v.updated_at, completed_at: v.completed_at, certificate_available: true,
    };
  }

  /** Models the Training Verification operations that the spec examples cannot (profile, pricing, balance, create, state changes). Returns true when it answered. */
  private tvHandle(opId: string, rec: RecordedRequest, params: string[], reply: { send: (s: number, b: unknown, h?: Record<string, string>, c?: string) => void; err: (s: number, c: string, m: string, d?: unknown, h?: Record<string, string>) => void; rl: Record<string, string>; json: J; remember: (status: number, body: string) => void }): boolean {
    const { send, err, rl, remember } = reply;
    const m = this.tv;
    const verification = params[0] !== undefined ? this.tvVerifications.find((x) => String(x.id) === params[0]) : undefined;
    if (params[0] !== undefined && this.tvVerifications.length > 0 && !verification) {
      err(404, 'not_found', 'No such verification.', undefined, rl);
      return true;
    }
    switch (opId) {
      case 'training-verification.profile.show':
        send(200, { data: { id: 1001, name: 'Acme Agency', client_type: m.clientType, verify_only: m.clientType === 'verification_only', request_types: [this.tvPrice('auto'), this.tvPrice('manual')], limits: { max_certificate_kb: m.maxCertificateKb, certificate_types: m.certificateTypes, max_client_reference_length: 100 }, default_notify_email: m.defaultNotifyEmail, payment: { methods: ['credit', 'legacy_balance', 'balance'], card: false } } }, rl);
        return true;
      case 'training-verification.pricing.show':
        send(200, { data: { client_type: m.clientType, currency: 'GBP', vat_rate_percent: 20, prices: [this.tvPrice('auto'), this.tvPrice('manual')], funding_order: ['credit', 'legacy_balance', 'balance'] } }, rl);
        return true;
      case 'training-verification.credits.show':
        send(200, { data: { money_pence: m.moneyPence, auto_credits: m.clientType === 'verification_only' ? m.autoCredits : null, manual_credits: m.manualCredits, legacy_balance_pence: m.legacyBalancePence, currency: 'GBP' } }, rl);
        return true;
      case 'training-verification.verifications.list': {
        if (this.tvVerifications.length === 0) return false;
        const q = rec.query;
        const status = q.getAll('status[]').concat(q.getAll('status'));
        const items = this.tvVerifications
          .filter((v) => (status.length ? status.includes(v.status) : true) && (!q.get('request_type') || v.request_type === q.get('request_type')) && (!q.get('candidate_ref') || v.candidate_ref === q.get('candidate_ref')) && (!q.get('client_reference') || v.client_reference === q.get('client_reference')))
          .sort((a, b) => b.id - a.id);
        send(200, { data: items.map((v) => this.tvPublic(v, false)), meta: { page: 1, per_page: Number(q.get('per_page') ?? 25), total: items.length, last_page: 1 }, links: {} }, rl);
        return true;
      }
      case 'training-verification.verifications.create': {
        const fields: Record<string, unknown> = rec.form ? { ...rec.form.fields } : { ...(reply.json as J) };
        const file = rec.form?.files.certificate;
        const bad: Record<string, string[]> = {};
        for (const k of ['request_type', 'candidate_name', 'candidate_email', 'agency_name_on_cert']) if (!fields[k]) bad[k] = [`The ${k} field is required.`];
        if (fields.request_type && !['auto', 'manual'].includes(String(fields.request_type))) bad.request_type = ['The request type must be auto or manual.'];
        let cert: TvVerification['certificate'] | undefined;
        if (file) {
          const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
          if (!m.certificateTypes.includes(ext)) bad.certificate = ['The certificate must be a file of type: ' + m.certificateTypes.join(', ') + '.'];
          else if (file.size > m.maxCertificateKb * 1024) bad.certificate = [`The certificate must not be greater than ${m.maxCertificateKb} kilobytes.`];
          else cert = file;
        } else if (typeof fields.certificate_base64 === 'string' && typeof fields.certificate_filename === 'string') {
          const bytes = Buffer.from(fields.certificate_base64.replace(/^data:[^,]*,/, ''), 'base64');
          cert = { filename: fields.certificate_filename, contentType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        } else bad.certificate = ['The certificate field is required.'];
        if (!fields.notify_email && !m.defaultNotifyEmail) bad.notify_email = ['The notify email field is required.'];
        if (Object.keys(bad).length) { err(422, 'validation_failed', 'The given data was invalid.', bad, rl); return true; }
        const type = String(fields.request_type) as 'auto' | 'manual';
        const price = this.tvPrice(type);
        let charge: Record<string, unknown> = { free: true, funding: 'free', amount_pence: 0, credits_used: 0, currency: 'GBP', refunded: false };
        if (!price.free) {
          const credits = type === 'auto' ? (m.clientType === 'verification_only' ? m.autoCredits : 0) : m.manualCredits;
          if (credits >= 1) {
            if (type === 'auto') m.autoCredits -= 1; else m.manualCredits -= 1;
            charge = { free: false, funding: 'credit', amount_pence: 0, credits_used: 1, currency: 'GBP', refunded: false };
          } else if (m.legacyBalancePence >= price.net_pence) {
            m.legacyBalancePence -= price.net_pence;
            charge = { free: false, funding: 'legacy_balance', amount_pence: price.net_pence, credits_used: 0, currency: 'GBP', refunded: false };
          } else if (m.moneyPence >= price.gross_pence) {
            m.moneyPence -= price.gross_pence;
            charge = { free: false, funding: 'balance', amount_pence: price.gross_pence, credits_used: 0, currency: 'GBP', refunded: false };
          } else {
            err(402, 'insufficient_credits', 'The account does not hold enough credits or balance for this verification.', { required: { gross_pence: price.gross_pence, net_pence: price.net_pence, credits: 0 }, available: { money_pence: m.moneyPence, legacy_balance_pence: m.legacyBalancePence, credits: credits } }, rl);
            return true;
          }
        }
        const v = this.seedVerification({ request_type: type, candidate_name: String(fields.candidate_name), candidate_email: String(fields.candidate_email), agency_name_on_cert: String(fields.agency_name_on_cert), notify_email: String(fields.notify_email ?? m.defaultNotifyEmail), candidate_ref: (fields.candidate_ref as string) ?? null, client_reference: (fields.client_reference as string) ?? null, charge, certificate: cert as TvVerification['certificate'] });
        const answer = JSON.stringify({ data: this.tvPublic(v, false) });
        remember(202, answer);
        send(202, answer, { ...rl, Location: `/api/v2/training-verification/verifications/${v.id}` });
        return true;
      }
      case 'training-verification.verifications.show':
        if (!verification) return false;
        send(200, { data: this.tvPublic(verification, true) }, rl);
        return true;
      case 'training-verification.verifications.events':
        if (!verification) return false;
        send(200, { data: verification.events, meta: { page: 1, per_page: 100, total: verification.events.length, last_page: 1 }, links: {} }, rl);
        return true;
      case 'training-verification.verifications.cancel': {
        if (!verification) return false;
        if (verification.status !== 'pending') { err(409, 'not_cancellable', 'Only a pending verification can be cancelled.', undefined, rl); return true; }
        const charged = verification.charge.free === false;
        verification.status = 'rejected';
        verification.reason = { code: 'cancelled_by_client', message: 'You cancelled this verification before it was processed.' };
        verification.completed_at = verification.updated_at = '2026-10-28T19:55:10Z';
        verification.charge = { ...verification.charge, refunded: charged };
        if (charged) {
          const c = verification.charge;
          if (c.funding === 'credit') { if (verification.request_type === 'auto') m.autoCredits += 1; else m.manualCredits += 1; }
          else if (c.funding === 'legacy_balance') m.legacyBalancePence += Number(c.amount_pence);
          else m.moneyPence += Number(c.amount_pence);
        }
        verification.events.push({ id: verification.events.length + 1, event: 'rejected', occurred_at: verification.updated_at, reason_code: 'cancelled_by_client', amount_pence: null });
        send(200, { data: this.tvPublic(verification, false) }, rl);
        return true;
      }
      case 'training-verification.verifications.report':
        if (verification && verification.status !== 'verified') { err(409, 'report_not_available', 'The report is available once the verification is verified.', undefined, rl); return true; }
        return false;
      default:
        return false;
    }
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buffer = Buffer.concat(chunks);
    const raw = buffer.toString('utf8');
    const url = new URL(req.url ?? '/', this.url);
    let json: unknown;
    try { json = raw && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : undefined; } catch { /* ignore */ }
    const form = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data') ? parseMultipart(buffer, String(req.headers['content-type'])) : undefined;
    const rec: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: raw, json, form };
    const route = routes.find((r) => r.method === rec.method && r.re.test(rec.path));
    rec.opId = route?.op.operationId;
    this.requests.push(rec);

    const send = (status: number, body: unknown, headers: Record<string, string> = {}, ctype = 'application/json') => {
      res.writeHead(status, { 'Content-Type': ctype, 'X-Request-Id': 'req_' + this.requests.length, ...headers });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const err = (status: number, code: string, message: string, details?: unknown, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
      send(status, { error: code, message, ...(details ? { details } : {}), ...extra, request_id: 'req_' + this.requests.length }, headers);

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

    const portalOfPath = /^\/api\/v2\/([a-z-]+)\//.exec(rec.path)?.[1];
    const refusedWith = portalOfPath ? this.approvalRefusals.get(portalOfPath) : undefined;
    if (refusedWith) {
      return err(403, refusedWith, `Access to ${portalOfPath} is not open.`, undefined, rl, { areas: [portalOfPath], docs_url: 'https://dev.hbcompliance.co.uk/docs/api-access-approval' });
    }
    if (rec.path === '/api/v2/account/api-access' && rec.method === 'GET') {
      return send(200, { data: this.apiAccessRows }, rl);
    }
    if (rec.path === '/api/v2/auth/me') {
      return send(200, { client_id: 1001, key: { name: 'Mock key', prefix: MOCK_KEY.slice(0, 8), scopes: this.scopes, expires_at: null } }, rl);
    }

    const idemKey = String(req.headers['idempotency-key'] ?? '');
    if (idemKey && rec.method !== 'GET') {
      const hash = createHash('sha256').update(form ? JSON.stringify(form) : raw).digest('hex');
      const prev = this.idem.get(idemKey);
      if (prev) {
        if (prev.hash !== hash) return err(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different body.', undefined, rl);
        return send(prev.status, prev.body, { ...prev.headers, ...rl, 'Idempotent-Replayed': 'true' });
      }
    }

    // Validate required body fields against the spec so 422s are realistic.
    if (route.op.operationId?.startsWith('training-verification.') && this.tvHandle(route.op.operationId, rec, route.re.exec(rec.path)!.slice(1), { send, err, rl, json, remember: (status, body) => { if (idemKey) this.idem.set(idemKey, { hash: createHash('sha256').update(form ? JSON.stringify(form) : raw).digest('hex'), status, body, headers: {} }); } })) return;
    const bodySchema = route.op.requestBody?.content?.['application/json']?.schema;
    if (bodySchema && rec.method !== 'GET') {
      const s = deref(bodySchema);
      const missing = (s.required ?? []).filter((f: string) => ((json ?? form?.fields) as J)?.[f] === undefined);
      if (missing.length) return err(422, 'validation_failed', 'The given data was invalid.', Object.fromEntries(missing.map((m: string) => [m, [`The ${m} field is required.`]])), rl);
    }

    const successKeys = Object.keys(route.op.responses).filter((k) => k.startsWith('2'));
    const successKey = successKeys.find((k) => k === '201') ?? successKeys[0] ?? '200';
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
      this.idem.set(idemKey, { hash: createHash('sha256').update(form ? JSON.stringify(form) : raw).digest('hex'), status, body: payload.toString(), headers: {} });
    }
    return send(status, payload, headers, outType);
  }
}
