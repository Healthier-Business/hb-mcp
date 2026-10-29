import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('full mode', () => {
  it('read-only default: only GET operations plus the four helpers; no writes, no credential ops', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full' });
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    const gets = h.ctx.catalogue.operations.filter((o) => o.method === 'GET' && !o.internal);
    expect(names).toHaveLength(gets.length + 5 + 5);
    expect(names).toContain('hub_candidates_list');
    expect(names).not.toContain('hub_candidates_create');
    expect(names).not.toContain('auth_token_create');
    for (const t of tools.filter((x) => h!.ctx.catalogue.get(x.name))) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description).toContain('[SANDBOX]');
    }
  });

  it('writes enabled in a sandbox: 186 operation tools, annotations from method and flags', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full', HB_READ_ONLY: 'false' });
    const { tools } = await h.client.listTools();
    expect(tools.filter((t) => h!.ctx.catalogue.get(t.name))).toHaveLength(186);
    expect(tools).toHaveLength(186 + 5 + 7);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.hub_candidates_create!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(by.webhooks_endpoints_delete!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(by.practical_training_bookings_cancel!.annotations?.destructiveHint).toBe(true);
    expect(by.hub_candidates_list!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
    expect(by.practical_training_bookings_create!.description).toContain('Uses credits');
    expect(by.occupational_health_requests_show!.description).toContain('Involves health data');
    expect(by.hub_candidates_create!.description).toContain('Scope: hub:candidates:write');
    expect(by.hub_candidates_create!.inputSchema.required).toEqual(expect.arrayContaining(['body']));
    const props = (by.hub_candidates_create!.inputSchema as any).properties;
    expect(props.body.required).toEqual(['first_name', 'last_name', 'email']);
    expect(props.confirm).toBeDefined();
    expect(props.idempotency_key).toBeDefined();
    expect((by.hub_candidates_show!.inputSchema as any).required).toEqual(['candidate_ref']);
  });

  it('HB_TOOLSETS filters tools by portal', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full', HB_TOOLSETS: 'hub,references', HB_READ_ONLY: 'false' });
    const { tools } = await h.client.listTools();
    const ops = tools.map((t) => h!.ctx.catalogue.get(t.name)).filter(Boolean);
    expect(new Set(ops.map((o) => o!.toolset))).toEqual(new Set(['hub', 'references']));
    expect(ops).toHaveLength(4 + 11);
  });

  it('calls read tools through the same pipeline', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full' });
    const list = await h.call('hub_candidates_list', { per_page: 10, search: 'jane', all_pages: true, fields: ['candidate_ref'] });
    expect(list.isError).toBe(false);
    expect(list.json.meta.pagination.pages_fetched).toBe(3);
    expect(h.hub.apiRequests()[0]!.query.get('search')).toBe('jane');
    const show = await h.call('hub_candidates_show', { candidate_ref: REF });
    expect(show.json.body.data.candidate_ref).toBe(REF);
    const bad = await h.call('hub_candidates_show', { candidate_ref: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('uuid');
    const unknown = await h.call('hub_candidates_show', { candidate_ref: REF, bogus: 1 });
    expect(unknown.isError).toBe(true);
  });

  it('a hidden write cannot be reached by name', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full' });
    const r = await h.call('hub_candidates_create', { body: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown tool');
    expect(h.hub.apiRequests()).toHaveLength(0);
  });

  it('full-mode write in a sandbox: path, query, body split correctly; live asks for a plan', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full', HB_READ_ONLY: 'false' });
    const upd = await h.call('hub_candidates_update', { candidate_ref: REF, body: { first_name: 'Janet' } });
    expect(upd.isError).toBe(false);
    const sent = h.hub.apiRequests().at(-1)!;
    expect(sent.method).toBe('PATCH');
    expect(sent.path).toBe(`/api/v2/hub/candidates/${REF}`);
    expect(sent.json).toEqual({ first_name: 'Janet' });
    await h.close();

    h = await startHarness({ HB_TOOL_MODE: 'full', HB_READ_ONLY: 'false', HB_ENV: 'live', HB_ALLOW_LIVE_WRITES: 'true' });
    const plan = await h.call('hub_candidates_update', { candidate_ref: REF, body: { first_name: 'Janet' } });
    expect(plan.json.status).toBe('confirmation_required');
    expect(h.hub.apiRequests()).toHaveLength(0);
    const done = await h.call('hub_candidates_update', { candidate_ref: REF, body: { first_name: 'Janet' }, confirm: true });
    expect(done.json.meta.status).toBe(200);
  });

  it('a sample of tools across portals responds (every read tool answers against the mock)', async () => {
    h = await startHarness({ HB_TOOL_MODE: 'full' });
    const { tools } = await h.client.listTools();
    let ok = 0;
    for (const t of tools) {
      const op = h.ctx.catalogue.get(t.name);
      if (!op || op.parameters.some((p) => p.required && p.in === 'query')) continue;
      const args: Record<string, unknown> = {};
      for (const p of op.parameters.filter((x) => x.in === 'path')) {
        args[p.name] = p.schema.format === 'uuid' ? REF : p.schema.type === 'integer' ? 5 : 'abc';
      }
      const r = await h.call(t.name, args);
      if (!r.isError) ok += 1;
      else expect(r.text).not.toContain('Unexpected error');
    }
    expect(ok).toBeGreaterThan(100);
  });
});

describe('concurrency', () => {
  it('many parallel calls with an expired token cause one refresh', async () => {
    h = await startHarness();
    await h.call('hb_status');
    h.hub.expireAccessTokens();
    const results = await Promise.all(Array.from({ length: 12 }, () => h!.call('hb_call_operation', { operation_id: 'hub.candidates.list' })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(h.hub.refreshes).toBe(1);
    expect(h.hub.exchanges).toBe(1);
  });

  it('a revoked pair recovers through the key (refresh refused, exchange again)', async () => {
    h = await startHarness();
    await h.call('hb_status');
    h.hub.revokeAllAccessTokens();
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(r.isError).toBe(false);
    expect(h.hub.exchanges).toBe(2);
  });
});
