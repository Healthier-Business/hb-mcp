import { describe, expect, it } from 'vitest';
import { ConfigError, detectMode, loadConfig, normaliseBaseUrl, writesEnabled } from '../src/config.js';

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe('config', () => {
  it('defaults: live Hub, compact, read-only', () => {
    const c = loadConfig(env({}));
    expect(c.baseUrl).toBe('https://hub.hbcompliance.co.uk');
    expect(c.mode).toBe('live');
    expect(c.toolMode).toBe('compact');
    expect(c.readOnly).toBe(true);
    expect(c.allowLiveWrites).toBe(false);
    expect(writesEnabled(c)).toBe(false);
  });

  it('treats empty settings as not set, as Claude Code passes unset variables as empty strings', () => {
    const c = loadConfig(env({ HB_ENV: '', HB_TOOLSETS: '', HB_BASE_URL: '', HB_READ_ONLY: '', HB_API_KEY: '  ' }));
    expect(c.baseUrl).toBe('https://hub.hbcompliance.co.uk');
    expect(c.mode).toBe('live');
    expect(c.readOnly).toBe(true);
    expect(c.apiKey).toBeUndefined();
  });

  it('detects sandbox from path style and host style URLs, treats unknown hosts as live', () => {
    expect(detectMode('https://dev.example.com/sandbox/8c1f2d3e-0000-4000-8000-000000000000', undefined).mode).toBe('sandbox');
    expect(detectMode('https://abc.sandbox.example.com', undefined).mode).toBe('sandbox');
    expect(detectMode('https://hub.example.com', undefined)).toEqual({ mode: 'live', source: 'unrecognised-host' });
    expect(detectMode('https://hub.hbcompliance.co.uk', undefined).mode).toBe('live');
    expect(detectMode('https://hub.example.com', 'sandbox').mode).toBe('sandbox');
  });

  it('live writes need both flags; sandbox writes need only HB_READ_ONLY=false', () => {
    expect(writesEnabled(loadConfig(env({ HB_READ_ONLY: 'false' })))).toBe(false);
    expect(writesEnabled(loadConfig(env({ HB_READ_ONLY: 'false', HB_ALLOW_LIVE_WRITES: 'true' })))).toBe(true);
    expect(writesEnabled(loadConfig(env({ HB_READ_ONLY: 'false', HB_ENV: 'sandbox' })))).toBe(true);
    expect(writesEnabled(loadConfig(env({ HB_ALLOW_LIVE_WRITES: 'true' })))).toBe(false);
  });

  it('rejects bad values with clear messages', () => {
    expect(() => loadConfig(env({ HB_READ_ONLY: 'maybe' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ HB_TOOLSETS: 'hub,nope' }))).toThrow(/nope/);
    expect(() => loadConfig(env({ HB_TOOL_MODE: 'big' }))).toThrow(ConfigError);
    expect(() => normaliseBaseUrl('http://hub.example.com')).toThrow(/https/);
    expect(() => normaliseBaseUrl('https://u:p@hub.example.com')).toThrow(/credentials/);
    expect(normaliseBaseUrl('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000');
    expect(normaliseBaseUrl('https://x.test/sandbox/abc/api/v2/')).toBe('https://x.test/sandbox/abc');
  });

  it('parses toolsets', () => {
    expect(loadConfig(env({ HB_TOOLSETS: 'hub, References' })).toolsets).toEqual(['hub', 'references']);
    expect(loadConfig(env({ HB_TOOLSETS: 'all' })).toolsets).toHaveLength(13);
  });
});
