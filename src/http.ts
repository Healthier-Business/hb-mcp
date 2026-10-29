import { HubApiError, HubNetworkError, type RateLimitInfo } from './errors.js';
import { log } from './log.js';
import { isFileValue } from './schema.js';
import type { TokenManager } from './tokens.js';

export interface HubRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path with parameters already substituted, e.g. /api/v2/hub/candidates/abc. */
  path: string;
  /** Path template for logs, e.g. /api/v2/hub/candidates/{candidate_ref}. */
  pathTemplate: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  json?: unknown;
  multipart?: Record<string, unknown>;
  /** True when sending it twice is harmless (reads) so network errors and 429/5xx may be retried. */
  retryable: boolean;
}

export interface HubResponse {
  status: number;
  requestId: string | undefined;
  rateLimit: RateLimitInfo;
  replayed: boolean;
  contentType: string;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export interface HubClientOptions {
  baseUrl: string;
  timeoutMs: number;
  tokens: TokenManager;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 20;

export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  const add = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'boolean' ? String(v) : String(v))}`);
  };
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      v.forEach((item) => add(`${k}[]`, item));
    } else if (v && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) add(`${k}[${sk}]`, sv);
    } else {
      add(k, v);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function appendForm(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (isFileValue(value)) {
    const f = value as { filename: string; content_base64?: string; content_text?: string; content_type?: string };
    const data = f.content_base64 !== undefined ? Buffer.from(f.content_base64, 'base64') : Buffer.from(f.content_text ?? '', 'utf8');
    form.append(key, new Blob([data], { type: f.content_type ?? 'application/octet-stream' }), f.filename);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => appendForm(form, `${key}[${typeof v === 'object' ? i : ''}]`, v));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) appendForm(form, `${key}[${k}]`, v);
  } else if (typeof value === 'boolean') {
    form.append(key, value ? '1' : '0');
  } else {
    form.append(key, String(value));
  }
}

export class HubClient {
  lastRateLimit: RateLimitInfo = {};
  requestCount = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HubClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async send(req: HubRequest): Promise<HubResponse> {
    let token = await this.opts.tokens.getAccessToken();
    let refreshed = false;
    let rateRetries = 0;
    let transientRetries = 0;

    for (;;) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.once(req, token);
      } catch (e) {
        const err = new HubNetworkError(e instanceof Error ? e.message : 'network error', e instanceof Error && e.name === 'TimeoutError');
        if (req.retryable && transientRetries < 2) {
          transientRetries += 1;
          await this.sleep(300 * transientRetries ** 2);
          continue;
        }
        throw err;
      }
      const meta = this.readMeta(res);
      log.debug(`${req.method} ${req.pathTemplate}`, { status: res.status, ms: Date.now() - started, request_id: meta.requestId });

      if (res.ok) {
        return await this.parse(res, meta);
      }

      const errorBody = await this.readErrorBody(res);
      const code = typeof errorBody.error === 'string' ? errorBody.error : `http_${res.status}`;

      if (res.status === 401 && !refreshed && (code === 'invalid_token' || code === 'unauthenticated')) {
        refreshed = true;
        token = await this.opts.tokens.recoverFrom(token);
        continue;
      }
      if (res.status === 429 && req.retryable && rateRetries < 1 && (meta.retryAfter ?? 0) <= MAX_RETRY_AFTER_SECONDS) {
        rateRetries += 1;
        await this.sleep(Math.max(1, meta.retryAfter ?? 1) * 1000);
        continue;
      }
      if ([502, 503, 504].includes(res.status) && req.retryable && transientRetries < 2) {
        transientRetries += 1;
        await this.sleep(300 * transientRetries ** 2);
        continue;
      }
      throw new HubApiError(
        res.status,
        code,
        typeof errorBody.message === 'string' ? errorBody.message : `The Hub answered HTTP ${res.status}.`,
        errorBody.details,
        typeof errorBody.request_id === 'string' ? errorBody.request_id : meta.requestId,
        meta.retryAfter,
        meta.rateLimit,
      );
    }
  }

  private async once(req: HubRequest, token: string): Promise<Response> {
    this.requestCount += 1;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'hb-hub-mcp',
      ...req.headers,
      Authorization: `Bearer ${token}`,
    };
    let body: BodyInit | undefined;
    if (req.multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.multipart)) appendForm(form, k, v);
      body = form;
    } else if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    return await this.fetchImpl(this.opts.baseUrl + req.path + buildQuery(req.query), {
      method: req.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
  }

  private readMeta(res: Response) {
    const num = (n: string) => {
      const v = res.headers.get(n);
      return v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
    };
    const rateLimit: RateLimitInfo = {
      limit: num('x-ratelimit-limit'),
      remaining: num('x-ratelimit-remaining'),
      reset: num('x-ratelimit-reset'),
    };
    if (rateLimit.limit !== undefined || rateLimit.remaining !== undefined) {
      this.lastRateLimit = rateLimit;
    }
    return {
      rateLimit,
      requestId: res.headers.get('x-request-id') ?? undefined,
      retryAfter: num('retry-after'),
      replayed: res.headers.get('idempotent-replayed') === 'true',
    };
  }

  private async readErrorBody(res: Response): Promise<Record<string, unknown>> {
    try {
      const text = await res.text();
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async parse(res: Response, meta: ReturnType<HubClient['readMeta']>): Promise<HubResponse> {
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const base = { status: res.status, requestId: meta.requestId, rateLimit: meta.rateLimit, replayed: meta.replayed, contentType };
    if (res.status === 204) {
      return base;
    }
    if (contentType.includes('json')) {
      const text = await res.text();
      try {
        return { ...base, json: text ? (JSON.parse(text) as unknown) : null };
      } catch {
        return { ...base, text };
      }
    }
    if (contentType.startsWith('text/')) {
      return { ...base, text: await res.text() };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BINARY_BYTES) {
      throw new HubApiError(502, 'response_too_large', 'The file is larger than this server will hold in memory.', undefined, meta.requestId, undefined);
    }
    return { ...base, bytes: buf };
  }
}
