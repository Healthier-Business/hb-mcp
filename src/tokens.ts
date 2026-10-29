import { AuthThrottledError, HubApiError, HubNetworkError, MissingApiKeyError } from './errors.js';
import { log } from './log.js';
import { redactor } from './redact.js';

interface TokenPair {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface TokenManagerOptions {
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const EARLY_MS = 60_000;
const AUTH_LIMIT_PER_MINUTE = 10;

/**
 * Owns the key -> token exchange and the rotation of the single-use refresh token.
 * One renewal runs at a time (single-flight); every waiting caller shares its result. The new refresh token replaces
 * the old one in memory before anything else happens, so a crash between steps never leaves a used token behind.
 */
export class TokenManager {
  private pair: TokenPair | undefined;
  private inflight: Promise<TokenPair> | undefined;
  private authCalls: number[] = [];
  private blockedUntil = 0;
  exchanges = 0;
  refreshes = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    redactor.add(opts.apiKey);
  }

  get hasKey(): boolean {
    return Boolean(this.opts.apiKey);
  }

  /** A valid access token, renewing early when it is about to expire. */
  async getAccessToken(): Promise<string> {
    const p = this.pair;
    if (p && p.accessExpiresAt - EARLY_MS > this.now()) {
      return p.access;
    }
    return (await this.renew()).access;
  }

  /**
   * Called after the Hub refused `usedToken`. If another caller already renewed, use that; otherwise renew.
   */
  async recoverFrom(usedToken: string): Promise<string> {
    if (this.pair && this.pair.access !== usedToken && this.pair.accessExpiresAt - EARLY_MS > this.now()) {
      return this.pair.access;
    }
    if (this.pair?.access === usedToken) {
      this.pair = { ...this.pair, accessExpiresAt: 0 };
    }
    return (await this.renew()).access;
  }

  private renew(): Promise<TokenPair> {
    if (!this.inflight) {
      this.inflight = this.doRenew().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async doRenew(): Promise<TokenPair> {
    if (!this.opts.apiKey) {
      throw new MissingApiKeyError();
    }
    const current = this.pair;
    if (current && current.refreshExpiresAt - EARLY_MS > this.now()) {
      try {
        const next = await this.callAuth('/api/v2/auth/refresh', { refresh_token: current.refresh });
        this.refreshes += 1;
        return this.store(next);
      } catch (e) {
        if (!(e instanceof HubApiError) || e.status !== 401) {
          throw e;
        }
        log.info('refresh token refused; exchanging the key again');
      }
    }
    const fresh = await this.callAuth('/api/v2/auth/token', { api_key: this.opts.apiKey });
    this.exchanges += 1;
    return this.store(fresh);
  }

  private store(body: unknown): TokenPair {
    const b = body as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number };
    if (!b.access_token || !b.refresh_token) {
      throw new HubApiError(502, 'bad_token_response', 'The Hub token answer had no access_token or refresh_token.', undefined, undefined, undefined);
    }
    const t = this.now();
    const next: TokenPair = {
      access: b.access_token,
      refresh: b.refresh_token,
      accessExpiresAt: t + (b.expires_in ?? 3600) * 1000,
      refreshExpiresAt: t + (b.refresh_expires_in ?? 604_800) * 1000,
    };
    // Superseded tokens stay registered: if the Hub ever echoes one back it is still scrubbed.
    redactor.add(next.access);
    redactor.add(next.refresh);
    this.pair = next;
    return next;
  }

  private checkThrottle(): void {
    const t = this.now();
    if (t < this.blockedUntil) {
      throw new AuthThrottledError(Math.ceil((this.blockedUntil - t) / 1000));
    }
    this.authCalls = this.authCalls.filter((c) => t - c < 60_000);
    if (this.authCalls.length >= AUTH_LIMIT_PER_MINUTE) {
      const oldest = this.authCalls[0] as number;
      throw new AuthThrottledError(Math.max(1, Math.ceil((60_000 - (t - oldest)) / 1000)));
    }
    this.authCalls.push(t);
  }

  private async callAuth(path: string, body: Record<string, string | undefined>): Promise<unknown> {
    this.checkThrottle();
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'hb-hub-mcp' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new HubNetworkError(e instanceof Error ? e.message : 'network error', e instanceof Error && e.name === 'TimeoutError');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON error page */
    }
    if (res.ok) {
      return json;
    }
    const retryAfter = Number(res.headers.get('retry-after')) || undefined;
    if (res.status === 429) {
      this.blockedUntil = this.now() + (retryAfter ?? 60) * 1000;
    }
    throw new HubApiError(
      res.status,
      typeof json.error === 'string' ? json.error : `http_${res.status}`,
      typeof json.message === 'string' ? json.message : `Authentication failed with HTTP ${res.status}.`,
      json.details,
      typeof json.request_id === 'string' ? json.request_id : (res.headers.get('x-request-id') ?? undefined),
      retryAfter,
    );
  }

  /** Session summary for hb_status. Never contains a token. */
  summary(): { hasAccessToken: boolean; accessExpiresInSeconds: number | null; exchanges: number; refreshes: number } {
    return {
      hasAccessToken: Boolean(this.pair),
      accessExpiresInSeconds: this.pair ? Math.max(0, Math.round((this.pair.accessExpiresAt - this.now()) / 1000)) : null,
      exchanges: this.exchanges,
      refreshes: this.refreshes,
    };
  }
}
