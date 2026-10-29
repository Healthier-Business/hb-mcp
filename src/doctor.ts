import { writesEnabled, type Config } from './config.js';
import { SERVER_VERSION } from './context.js';
import { describeError, HubApiError } from './errors.js';
import { TokenManager } from './tokens.js';
import { redactor } from './redact.js';

export interface DoctorLine {
  level: 'ok' | 'warn' | 'fail' | 'info';
  text: string;
}

/** Environment and connectivity check. Prints scopes and mode, never a secret. */
export async function runDoctor(config: Config, fetchImpl: typeof fetch = fetch): Promise<DoctorLine[]> {
  const out: DoctorLine[] = [];
  const add = (level: DoctorLine['level'], text: string) => out.push({ level, text: redactor.redact(text) });
  redactor.add(config.apiKey);

  add('info', `hb-hub-mcp ${SERVER_VERSION}, Node ${process.version}`);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', `Node ${major >= 20 ? 'is new enough' : 'must be 20 or newer'}`);
  add('info', `Environment: ${config.mode.toUpperCase()} (detected from ${config.modeSource}), base URL ${config.baseUrl}`);
  if (config.mode === 'live') add('warn', 'This is the LIVE Hub. Use a sandbox while building.');
  add('info', `Tool mode: ${config.toolMode}; toolsets: ${config.toolsets.length === 12 ? 'all' : config.toolsets.join(', ')}`);
  add(config.readOnly ? 'ok' : 'warn', config.readOnly ? 'Read-only (HB_READ_ONLY=true): writes are refused.' : `Writes enabled: ${writesEnabled(config) ? 'yes' : 'no (live writes need HB_ALLOW_LIVE_WRITES=true)'}`);

  if (!config.apiKey) {
    add('fail', 'HB_API_KEY is not set.');
  } else {
    add('ok', `HB_API_KEY is set (${config.apiKey.startsWith('hbk_test_') ? 'sandbox test key' : config.apiKey.startsWith('hbk_') ? 'live-style key' : 'unexpected prefix: keys start with hbk_'}).`);
    if (config.apiKey.startsWith('hbk_test_') && config.mode === 'live') add('warn', 'A test key with a LIVE base URL will not work. Set HB_BASE_URL to your sandbox.');
  }

  try {
    const res = await fetchImpl(config.baseUrl + '/api/v2/auth/me', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(config.requestTimeoutMs), redirect: 'error' });
    add(res.status === 401 ? 'ok' : 'warn', `Base URL reachable unauthenticated: HTTP ${res.status}${res.status === 401 ? ' (expected 401 without a token)' : ''}`);
  } catch (e) {
    add('fail', `Cannot reach ${config.baseUrl}: ${e instanceof Error ? e.message : 'network error'}`);
  }

  if (config.apiKey) {
    const tokens = new TokenManager({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, fetchImpl });
    try {
      const token = await tokens.getAccessToken();
      add('ok', 'Token exchange succeeded.');
      const res = await fetchImpl(config.baseUrl + '/api/v2/auth/me', { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
      const me = (await res.json()) as { client_id?: number; key?: { name?: string; prefix?: string; scopes?: string[]; expires_at?: string | null } };
      add('ok', `Key "${me.key?.name ?? '?'}" (${me.key?.prefix ?? '?'}...) for client ${me.client_id ?? '?'}; expires ${me.key?.expires_at ?? 'never'}`);
      const scopes = me.key?.scopes ?? [];
      add('info', `Scopes (${scopes.length}): ${scopes.join(', ') || 'none'}`);
      if (!config.readOnly && !scopes.some((s) => s.endsWith(':write'))) add('warn', 'Writes are enabled but the key has no :write scope.');
    } catch (e) {
      add('fail', `Token exchange failed: ${describeError(e)}`);
      if (e instanceof HubApiError && e.code === 'ip_not_allowed') add('info', 'This machine\'s public IP is not on the key\'s allowlist (calls leave from the machine running this server).');
    }
  }
  return out;
}
