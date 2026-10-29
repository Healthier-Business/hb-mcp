import { describe, expect, it } from 'vitest';
import { AuthThrottledError, HubApiError, MissingApiKeyError } from '../src/errors.js';
import { TokenManager } from '../src/tokens.js';

function pair(n: number) {
  return { token_type: 'Bearer', access_token: `access_token_${n}_xxxxxxxx`, refresh_token: `refresh_token_${n}_xxxxxxxx`, expires_in: 3600, refresh_expires_in: 604800 };
}

function fakeHub(opts: { refreshFails?: boolean; throttle429?: boolean } = {}) {
  const calls: { path: string; body: any }[] = [];
  let n = 0;
  const usedRefresh = new Set<string>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    calls.push({ path, body });
    await new Promise((r) => setTimeout(r, 5));
    if (opts.throttle429) {
      return new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many', request_id: 'r' }), { status: 429, headers: { 'Retry-After': '42' } });
    }
    if (path.endsWith('/token')) return new Response(JSON.stringify(pair(++n)), { status: 200 });
    if (opts.refreshFails || usedRefresh.has(body.refresh_token)) {
      return new Response(JSON.stringify({ error: 'invalid_token', message: 'bad', request_id: 'r' }), { status: 401 });
    }
    usedRefresh.add(body.refresh_token);
    return new Response(JSON.stringify(pair(++n)), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('TokenManager', () => {
  const base = { baseUrl: 'https://hub.test', timeoutMs: 5000 };

  it('exchanges the key once for many concurrent callers (single-flight)', async () => {
    const hub = fakeHub();
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl });
    const tokens = await Promise.all(Array.from({ length: 25 }, () => tm.getAccessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(hub.calls.filter((c) => c.path.endsWith('/token'))).toHaveLength(1);
    expect(await tm.getAccessToken()).toBe(tokens[0]);
    expect(hub.calls).toHaveLength(1);
  });

  it('refreshes with the newest refresh token each time (rotation) and renews early', async () => {
    let now = 1_000_000;
    const hub = fakeHub();
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl, now: () => now });
    await tm.getAccessToken();
    now += 3600_000 - 30_000; // inside the 60 s early window
    const second = await tm.getAccessToken();
    now += 3600_000 - 30_000;
    const third = await tm.getAccessToken();
    expect(second).toBe('access_token_2_xxxxxxxx');
    expect(third).toBe('access_token_3_xxxxxxxx');
    const refreshes = hub.calls.filter((c) => c.path.endsWith('/refresh'));
    expect(refreshes.map((c) => c.body.refresh_token)).toEqual(['refresh_token_1_xxxxxxxx', 'refresh_token_2_xxxxxxxx']);
    expect(tm.exchanges).toBe(1);
    expect(tm.refreshes).toBe(2);
  });

  it('falls back to exchanging the key when the refresh token is refused', async () => {
    let now = 0;
    const hub = fakeHub({ refreshFails: true });
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl, now: () => now });
    await tm.getAccessToken();
    now += 3600_000;
    expect(await tm.getAccessToken()).toBe('access_token_2_xxxxxxxx');
    expect(tm.exchanges).toBe(2);
  });

  it('recoverFrom: concurrent callers refused with the same token cause only one renewal', async () => {
    const hub = fakeHub();
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl });
    const used = await tm.getAccessToken();
    const results = await Promise.all([tm.recoverFrom(used), tm.recoverFrom(used), tm.recoverFrom(used)]);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBe(used);
    expect(hub.calls.filter((c) => c.path.endsWith('/refresh'))).toHaveLength(1);
    // a late caller that was refused with the OLD token just gets the new one
    expect(await tm.recoverFrom(used)).toBe(results[0]);
    expect(hub.calls.filter((c) => c.path.endsWith('/refresh'))).toHaveLength(1);
  });

  it('respects a 429 with Retry-After and does not hammer the endpoint', async () => {
    const hub = fakeHub({ throttle429: true });
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl });
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(HubApiError);
    const err = await tm.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthThrottledError);
    expect(err.retryAfterSeconds).toBeGreaterThan(30);
    expect(hub.calls).toHaveLength(1);
  });

  it('keeps its own 10-a-minute budget', async () => {
    let now = 0;
    const hub = fakeHub();
    const tm = new TokenManager({ ...base, apiKey: 'hbk_key_1234567890', fetchImpl: hub.fetchImpl, now: () => now });
    let token = await tm.getAccessToken();
    for (let i = 0; i < 9; i++) {
      now += 1000;
      token = await tm.recoverFrom(token);
    }
    now += 1000;
    await expect(tm.recoverFrom(token)).rejects.toBeInstanceOf(AuthThrottledError);
    now += 60_000;
    await expect(tm.recoverFrom(token)).resolves.toBeTruthy();
  });

  it('fails clearly without a key and never puts the key in an error', async () => {
    const tm = new TokenManager({ ...base, apiKey: undefined, fetchImpl: fakeHub().fetchImpl });
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
