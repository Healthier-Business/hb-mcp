import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http-transport.js';
import { PACKAGE_ROOT } from '../src/paths.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY, MockHub } from './helpers/mock-hub.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('resources', () => {
  it('lists guides and portals, reads them, and serves operations and events as templates', async () => {
    h = await startHarness();
    const { resources } = await h.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['hb://guides/authentication', 'hb://guides/going-live', 'hb://portals/occupational-health', 'hb://portals/hub', 'hb://spec/overview']));
    expect(uris.filter((u) => u.startsWith('hb://guides/'))).toHaveLength(15);
    const auth = await h.client.readResource({ uri: 'hb://guides/authentication' });
    expect((auth.contents[0] as any).text).toContain('refresh token');
    const portal = await h.client.readResource({ uri: 'hb://portals/occupational-health' });
    expect((portal.contents[0] as any).text).toContain('occupational-health.requests.create');
    const hub = await h.client.readResource({ uri: 'hb://portals/hub' });
    expect((hub.contents[0] as any).text).toContain('hub.candidates.list');
    const op = await h.client.readResource({ uri: 'hb://spec/operations/hub.candidates.create' });
    expect(JSON.parse((op.contents[0] as any).text).scope).toBe('hub:candidates:write');
    const ev = await h.client.readResource({ uri: 'hb://spec/events/occupational-health.request.submitted' });
    expect((ev.contents[0] as any).text).toContain('data');
    const { resourceTemplates } = await h.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['hb://spec/operations/{id}', 'hb://spec/events/{type}']);
    await expect(h.client.readResource({ uri: 'hb://guides/nope' })).rejects.toThrow();
  });
});

describe('prompts', () => {
  it('lists the workflows and fills them in, mode-aware', async () => {
    h = await startHarness();
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['book-practical-training', 'check-candidate-compliance', 'webhook-sandbox-setup', 'go-live-checklist', 'onboard-candidate']);
    const book = await h.client.getPrompt({ name: 'book-practical-training', arguments: { candidate: 'Jane Doe' } });
    const text = (book.messages[0]!.content as any).text as string;
    expect(text).toContain('Jane Doe');
    expect(text).toContain('practical-training.bookings.create');
    expect(text).toContain('read-only');
    await expect(h.client.getPrompt({ name: 'book-practical-training', arguments: {} })).rejects.toThrow(/candidate/);
    const live = await h.client.getPrompt({ name: 'go-live-checklist' });
    expect((live.messages[0]!.content as any).text).toContain('allowlist');
  });

  it('every operation id named in the prompts exists in the spec', async () => {
    h = await startHarness();
    const { prompts } = await h.client.listPrompts();
    for (const p of prompts) {
      const args = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, 'x']));
      const text = ((await h.client.getPrompt({ name: p.name, arguments: args })).messages[0]!.content as any).text as string;
      for (const id of (text.match(/\b(?:hub|practical-training|occupational-health|online-training|webhooks)\.[a-z-]+\.[a-z.-]+[a-z]/g) ?? []).filter((i) => !i.endsWith('.uk'))) {
        expect(h.ctx.catalogue.get(id), `${p.name} mentions unknown operation ${id}`).toBeDefined();
      }
    }
  });
});

describe('Streamable HTTP transport', () => {
  it('serves an MCP session over HTTP on loopback and makes a Hub call', async () => {
    h = await startHarness();
    const http = await startHttpServer(h.ctx, { host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(7);
    const r = await client.callTool({ name: 'hb_call_operation', arguments: { operation_id: 'hub.candidates.list' } });
    expect(r.isError).toBeFalsy();
    await client.close();
    await http.close();
  });

  it('refuses to listen beyond loopback without a token, and enforces the token when given', async () => {
    h = await startHarness();
    await expect(startHttpServer(h.ctx, { host: '0.0.0.0', port: 0 })).rejects.toThrow(/HB_MCP_HTTP_TOKEN/);
    const http = await startHttpServer(h.ctx, { host: '127.0.0.1', port: 0, authToken: 'tok-12345678' });
    const denied = await fetch(`http://127.0.0.1:${http.port}/mcp`, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${http.port}/healthz`)).status).toBe(200);
    await http.close();
  });
});

describe('stdio (the real CLI process)', () => {
  it('starts, lists tools, answers from the mock Hub, shuts down, and prints nothing to stdout but protocol', async () => {
    const hub = await new MockHub().start();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts'],
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH ?? '', HB_API_KEY: MOCK_KEY, HB_BASE_URL: hub.url, HB_ENV: 'sandbox', HB_LOG_LEVEL: 'debug' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('hb_call_operation');
    const r = await client.callTool({ name: 'hb_status', arguments: {} });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text).auth.ok).toBe(true);
    const read = await client.callTool({ name: 'hb_call_operation', arguments: { operation_id: 'hub.candidates.list' } });
    expect(read.isError).toBeFalsy();
    await client.close();
    await hub.stop();
    const logs = stderr.join('');
    expect(logs).toContain('[hb-hub-mcp]');
    expect(logs).not.toContain(MOCK_KEY);
    for (const t of hub.issued) expect(logs).not.toContain(t);
  });

  it('--version, --help and a bad configuration exit cleanly', async () => {
    const { execFileSync, spawnSync } = await import('node:child_process');
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: PACKAGE_ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run(['--help']).stdout).toContain('HB_READ_ONLY');
    const bad = run([], { HB_READ_ONLY: 'perhaps' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Configuration error');
    void execFileSync;
  });
});

describe('--doctor', () => {
  it('checks env, reachability and the token exchange, prints scopes and mode, never the key', async () => {
    const hub = await new MockHub().start();
    const { runDoctor } = await import('../src/doctor.js');
    const { loadConfig } = await import('../src/config.js');
    const lines = await runDoctor(loadConfig({ HB_API_KEY: MOCK_KEY, HB_BASE_URL: hub.url, HB_ENV: 'sandbox' } as NodeJS.ProcessEnv));
    const text = lines.map((l) => `${l.level} ${l.text}`).join('\n');
    expect(text).toContain('SANDBOX');
    expect(text).toContain('Token exchange succeeded');
    expect(text).toContain('Scopes (');
    expect(text).toContain('reachable unauthenticated: HTTP 401');
    expect(text).not.toContain(MOCK_KEY);
    expect(lines.some((l) => l.level === 'fail')).toBe(false);
    const noKey = await runDoctor(loadConfig({ HB_BASE_URL: hub.url, HB_ENV: 'sandbox' } as NodeJS.ProcessEnv));
    expect(noKey.some((l) => l.level === 'fail' && l.text.includes('HB_API_KEY'))).toBe(true);
    await hub.stop();
  });
});
