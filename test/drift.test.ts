import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationCatalogue } from '../src/catalogue.js';
import { loadConfig, TOOLSETS } from '../src/config.js';
import { buildCatalogue, buildEvents, INTERNAL_OPERATIONS, TAG_TOOLSETS } from '../src/generator/build.js';
import { assetPath } from '../src/paths.js';
import { createContext, buildTools } from '../src/server.js';
import { buildInputSchema } from '../src/tools/full.js';

const specRaw = readFileSync(assetPath('spec/hub-v2.json'));
const spec = JSON.parse(specRaw.toString('utf8'));
const sha = createHash('sha256').update(specRaw).digest('hex');

describe('generated catalogue vs the bundled spec', () => {
  it('is exactly what the generator produces from spec/hub-v2.json (run `npm run generate` if this fails)', () => {
    const committed = JSON.parse(readFileSync(assetPath('generated/catalogue.json'), 'utf8'));
    const committedEvents = JSON.parse(readFileSync(assetPath('generated/events.json'), 'utf8'));
    expect(committed.specSha256).toBe(sha);
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildCatalogue(spec, sha))));
    expect(committedEvents).toEqual(JSON.parse(JSON.stringify(buildEvents(spec, sha))));
  });

  it('covers every operation and webhook of the spec', () => {
    const cat = OperationCatalogue.load();
    const specOps = Object.values<any>(spec.paths).flatMap((i) => Object.values<any>(i).map((o) => o.operationId));
    expect(cat.operations.map((o) => o.id).sort()).toEqual([...specOps].sort());
    expect(cat.operations).toHaveLength(189);
    expect(cat.events).toHaveLength(Object.keys(spec.webhooks).length);
    expect(cat.events).toHaveLength(59);
  });

  it('maps every tag to a toolset the config knows, and every toolset has operations', () => {
    expect(new Set(Object.values(TAG_TOOLSETS))).toEqual(new Set(TOOLSETS));
    const cat = OperationCatalogue.load();
    for (const t of TOOLSETS) expect(cat.operations.some((o) => o.toolset === t)).toBe(true);
  });

  it('has unique, valid tool names', () => {
    const cat = OperationCatalogue.load();
    const names = cat.operations.map((o) => o.toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('full mode (writes enabled, all toolsets) exposes one tool per operation except the credential ones', () => {
    const config = loadConfig({ HB_API_KEY: 'hbk_x_1234567890', HB_BASE_URL: 'http://127.0.0.1:1', HB_ENV: 'sandbox', HB_TOOL_MODE: 'full', HB_READ_ONLY: 'false' } as NodeJS.ProcessEnv);
    const ctx = createContext(config);
    const tools = buildTools(ctx);
    const opTools = tools.filter((t) => ctx.catalogue.get(t.name));
    expect(opTools).toHaveLength(189 - INTERNAL_OPERATIONS.size);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['hb_status', 'hb_list_events', 'hb_describe_event', 'hb_verify_webhook_signature']));
    for (const op of ctx.catalogue.operations) {
      if (!op.internal) expect(() => buildInputSchema(op)).not.toThrow();
    }
  });

  it('records its shape: scopes, credits and health-data flags match the spec', () => {
    const cat = OperationCatalogue.load();
    const raw = Object.values<any>(spec.paths).flatMap((i) => Object.values<any>(i));
    for (const o of raw) {
      const c = cat.get(o.operationId)!;
      expect(c.scope).toBe(o['x-required-scope'] ?? null);
      expect(c.healthData).toBe(o['x-health-data'] === true);
      expect(c.credits !== null).toBe(o['x-credits'] !== undefined);
    }
    expect(cat.operations.filter((o) => o.credits)).toHaveLength(9);
    expect(cat.operations.filter((o) => o.healthData)).toHaveLength(9);
  });
});

describe('package metadata', () => {
  it('server version equals package.json version and the bin points at the CLI', async () => {
    const pkg = JSON.parse(readFileSync(assetPath('package.json'), 'utf8'));
    const { SERVER_VERSION } = await import('../src/context.js');
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(pkg.bin['hb-hub-mcp']).toBe('dist/cli.js');
    expect(pkg.name).toBe('@healthier-business/hub-mcp');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@modelcontextprotocol/sdk', 'zod']);
  });
});
