import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY } from './helpers/mock-hub.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('compact mode tool list', () => {
  it('exposes the eight meta tools plus the fourteen read-only task tools, with annotations and mode-aware descriptions', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['hb_account_summary', 'hb_billing_summary', 'hb_call_operation', 'hb_candidate_overview', 'hb_credits', 'hb_describe_event', 'hb_describe_operation', 'hb_find_candidate', 'hb_get_report', 'hb_go_live_check', 'hb_list_bookings', 'hb_list_events', 'hb_monitoring_alerts', 'hb_needs_attention', 'hb_search_guides', 'hb_search_operations', 'hb_status', 'hb_training_progress', 'hb_verification_status', 'hb_verify_webhook_signature', 'hb_webhook_health', 'hb_worker_status'],
    );
    const call = tools.find((t) => t.name === 'hb_call_operation')!;
    expect(call.description).toContain('[SANDBOX]');
    expect(call.description).toContain('READ-ONLY');
    expect(call.annotations?.readOnlyHint).toBe(true);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('sends server instructions at connect time', () => {
    const text = h.client.getInstructions() ?? '';
    expect(text).toContain('candidate_ref');
    expect(text).toContain('Never ask the user to paste a key');
    expect(text).toContain('SANDBOX');
  });
});

describe('hb_status', () => {
  it('reports mode, scopes, rate limit and never a secret', async () => {
    await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    const r = await h.call('hb_status');
    expect(r.isError).toBe(false);
    expect(r.json.mode).toBe('sandbox');
    expect(r.json.read_only).toBe(true);
    expect(r.json.writes_enabled).toBe(false);
    expect(r.json.auth.ok).toBe(true);
    expect(r.json.auth.key.scopes).toContain('hub:candidates:read');
    expect(r.json.rate_limit.limit).toBe(1000);
    expect(r.text).not.toContain(MOCK_KEY);
  });

  it('says so clearly when no key is configured', async () => {
    const h2 = await startHarness({ HB_API_KEY: '' }, h.hub);
    const r = await h2.call('hb_status');
    expect(r.json.auth.configured).toBe(false);
    expect(r.json.warnings[0]).toContain('HB_API_KEY');
  });

  it('surfaces a wrong key as a clear problem', async () => {
    const h2 = await startHarness({ HB_API_KEY: 'hbk_test_wrongwrongwrongwrong' }, h.hub);
    const r = await h2.call('hb_status');
    expect(r.json.auth.ok).toBe(false);
    expect(r.json.auth.problem).toContain('invalid_credentials');
    expect(JSON.stringify(r.json)).not.toContain('wrongwrongwrong');
  });
});

describe('search and describe', () => {
  it('finds operations by text, portal, method and scope', async () => {
    const r = await h.call('hb_search_operations', { query: 'candidate', toolset: 'hub' });
    expect(r.json.operations.map((o: any) => o.id)).toEqual(expect.arrayContaining(['hub.candidates.list', 'hub.candidates.show']));
    const w = await h.call('hb_search_operations', { scope: 'bookings:write', writes_only: true, limit: 50 });
    expect(w.json.operations.length).toBeGreaterThan(3);
    for (const o of w.json.operations) {
      expect(o.kind).toBe('write');
      expect(o.callable_now).toBe(false);
      expect(o.why_not).toContain('read-only');
    }
    const g = await h.call('hb_search_operations', { method: 'DELETE' });
    expect(g.json.operations.every((o: any) => o.method === 'DELETE')).toBe(true);
    expect(g.json.operations.length).toBe(7);
  });

  it('never lists the credential operations', async () => {
    const r = await h.call('hb_search_operations', { query: 'auth token refresh revoke', limit: 50 });
    const ids = r.json.operations.map((o: any) => o.id);
    expect(ids).not.toContain('auth.token.create');
    expect(ids).not.toContain('auth.refresh.create');
  });

  it('describes an operation fully, including credits, health data and a ready example', async () => {
    const d = await h.call('hb_describe_operation', { operation_id: 'practical-training.bookings.create' });
    expect(d.json.scope).toBe('practical-training:bookings:write');
    expect(d.json.side_effects.credits).toContain('pay_option');
    expect(d.json.body.required_fields).toContain('candidate_ref');
    expect(d.json.how_to_call.body.candidate_ref).toBe(REF);
    expect(d.json.errors.map((e: any) => e.status)).toEqual(expect.arrayContaining([402, 422, 429]));
    const hd = await h.call('hb_describe_operation', { operation_id: 'occupational-health.requests.show' });
    expect(hd.json.side_effects.health_data).toBe(true);
  });

  it('suggests ids for a mistyped operation and accepts the underscore tool name', async () => {
    const d = await h.call('hb_describe_operation', { operation_id: 'hub.candidate.lst' });
    expect(d.isError).toBe(true);
    expect(d.text).toContain('hub.candidates.list');
    const ok = await h.call('hb_describe_operation', { operation_id: 'hub_candidates_list' });
    expect(ok.isError).toBe(false);
  });
});

describe('hb_call_operation reads', () => {
  it('calls a list operation, reports meta, rate limit and request id', async () => {
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', query: { per_page: 5 } });
    expect(r.isError).toBe(false);
    expect(r.json.meta.status).toBe(200);
    expect(r.json.meta.environment).toBe('sandbox');
    expect(r.json.meta.rate_limit.limit).toBe(1000);
    expect(r.json.meta.request_id).toMatch(/^req_/);
    expect(r.json.body.data.length).toBeGreaterThan(0);
    const sent = h.hub.apiRequests().at(-1)!;
    expect(sent.query.get('per_page')).toBe('5');
    expect(sent.headers.authorization).toMatch(/^Bearer /);
  });

  it('puts path params into the URL (encoded)', async () => {
    await h.call('hb_call_operation', { operation_id: 'hub.candidates.show', path_params: { candidate_ref: REF } });
    expect(h.hub.apiRequests().at(-1)!.path).toBe(`/api/v2/hub/candidates/${REF}`);
  });

  it('follows pagination with all_pages and respects max_pages', async () => {
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', all_pages: true, fields: ['candidate_ref', '_page'] });
    expect(r.json.meta.pagination.pages_fetched).toBe(3);
    const pages = new Set(r.json.body.data.map((d: any) => d._page));
    expect([...pages]).toEqual([1, 2, 3]);
    expect(Object.keys(r.json.body.data[0]).sort()).toEqual(['_page', 'candidate_ref']);
    const capped = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', all_pages: true, max_pages: 2 });
    expect(capped.json.meta.pagination.pages_fetched).toBe(2);
    expect(capped.json.meta.pagination.stopped_because).toBe('max_pages_reached');
  });

  it('truncates oversize answers with a notice', async () => {
    const small = await startHarness({ HB_MAX_RESPONSE_CHARS: '2000' }, h.hub);
    const r = await small.call('hb_call_operation', { operation_id: 'hub.candidates.list', all_pages: true });
    expect(r.text.length).toBeLessThanOrEqual(2200);
    expect(r.text).toMatch(/Showing \d+ of \d+ items|truncated at 2000/);
  });

  it('returns files as base64 with their type', async () => {
    const r = await h.call('hb_call_operation', { operation_id: 'practical-training.bookings.certificate', path_params: { booking: '55' } });
    expect(r.json.body.content_type).toBe('application/pdf');
    expect(Buffer.from(r.json.body.content_base64, 'base64').toString()).toContain('%PDF');
  });

  it('marks health data answers', async () => {
    const r = await h.call('hb_call_operation', { operation_id: 'occupational-health.requests.show', path_params: { id: '1' } });
    expect(r.json.meta.health_data).toContain('health data');
  });

  it('refreshes once on 401 and carries on', async () => {
    await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    h.hub.expireAccessTokens();
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(r.isError).toBe(false);
    expect(h.hub.refreshes).toBe(1);
    expect(h.hub.exchanges).toBe(1);
  });

  it('retries a read after 429 Retry-After, then succeeds', async () => {
    h.hub.failNext(429, { error: 'rate_limited', message: 'slow', request_id: 'r1' }, { 'Retry-After': '2' }, (r) => r.opId === 'hub.candidates.list');
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(r.isError).toBe(false);
    expect(h.hub.apiRequests().filter((x) => x.opId === 'hub.candidates.list')).toHaveLength(2);
  });

  it('retries a read once after a dropped connection', async () => {
    h.hub.dropNext((r) => r.opId === 'hub.candidates.list');
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(r.isError).toBe(false);
  });
});

describe('hb_call_operation validation (nothing is sent)', () => {
  const sentCount = () => h.hub.apiRequests().length;
  it('rejects a missing path parameter, an unknown query parameter and a bad path value', async () => {
    const a = await h.call('hb_call_operation', { operation_id: 'hub.candidates.show' });
    expect(a.isError).toBe(true);
    expect(a.text).toContain('path_params.candidate_ref is required');
    const b = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', query: { nope: 1 } });
    expect(b.text).toContain('query.nope is not a query parameter');
    const c = await h.call('hb_call_operation', { operation_id: 'hub.candidates.show', path_params: { candidate_ref: 'not-a-uuid' } });
    expect(c.text).toContain('must be a valid uuid');
    const d = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', query: { per_page: 'many' } });
    expect(d.isError).toBe(true);
    expect(sentCount()).toBe(0);
  });

  it('rejects unknown operations with suggestions and unknown argument shapes', async () => {
    const a = await h.call('hb_call_operation', { operation_id: 'hub.candidates.listt' });
    expect(a.isError).toBe(true);
    expect(a.text).toContain('Unknown operation');
    const b = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', query: 'x' });
    expect(b.isError).toBe(true);
    const c = await h.call('hb_call_operation', {});
    expect(c.isError).toBe(true);
  });

  it('refuses a body on a GET and a header the operation does not declare', async () => {
    expect((await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', body: { a: 1 } })).text).toContain('takes no body');
    expect((await h.call('hb_call_operation', { operation_id: 'hub.candidates.list', headers: { Authorization: 'Bearer x' } })).text).toContain('is not a header');
    expect(sentCount()).toBe(0);
  });

  it('refuses the credential operations', async () => {
    const r = await h.call('hb_call_operation', { operation_id: 'auth.token.create', body: { api_key: MOCK_KEY } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('handled by the server itself');
    expect(h.hub.requests.filter((x) => x.path.endsWith('/auth/token'))).toHaveLength(0);
  });
});

describe('error mapping', () => {
  const cases: [number, string, string, string][] = [
    [402, 'insufficient_credits', 'Not enough credits.', 'top up'],
    [403, 'insufficient_scope', 'The key needs the scope hub:candidates:read.', 'scope'],
    [403, 'ip_not_allowed', 'Your address is not allowed.', 'allowlist'],
    [404, 'not_found', 'The resource was not found.', 'candidate_ref'],
    [409, 'conflict', 'Slot taken.', 'Conflict'],
    [422, 'validation_failed', 'The given data was invalid.', 'details'],
    [429, 'rate_limited', 'Too many requests.', 'Retry-After'],
    [500, 'server_error', 'Something broke.', 'request_id'],
  ];
  for (const [status, code, message, hint] of cases) {
    it(`maps ${status} ${code} with request id and next steps`, async () => {
      h.hub.failNext(status, { error: code, message, details: status === 422 ? { email: ['bad'] } : undefined, request_id: 'req_abc123' }, status === 429 ? { 'Retry-After': '99' } : {}, (r) => r.opId === 'hub.candidates.list');
      const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`${status} ${code}`);
      expect(r.text).toContain('req_abc123');
      expect(r.text.toLowerCase()).toContain(hint.toLowerCase());
      if (status === 429) expect(r.text).toContain('retry_after_seconds: 99');
      if (status === 422) expect(r.text).toContain('"email"');
    });
  }
});

describe('events', () => {
  it('lists the 66 events, filters by portal, describes one with schema and example', async () => {
    const all = await h.call('hb_list_events');
    expect(all.json.count).toBe(66);
    const oh = await h.call('hb_list_events', { portal: 'occupational-health' });
    expect(oh.json.count).toBeGreaterThan(3);
    const type = oh.json.events[0].type;
    const d = await h.call('hb_describe_event', { event_type: type });
    expect(d.json.type).toBe(type);
    expect(d.json.data_schema.type).toBe('object');
    expect(d.json.example.event_type).toBe(type);
    expect(d.json.headers.join(' ')).toContain('X-Hub-Signature');
    const bad = await h.call('hb_describe_event', { event_type: 'nope.nothing' });
    expect(bad.isError).toBe(true);
  });
});

describe('search ranking', () => {
  it('puts the obvious operation first for natural phrases', async () => {
    const top = async (q: string) => (await h.call('hb_search_operations', { query: q, limit: 3 })).json.operations.map((o: any) => o.id);
    expect(await top('book practical training')).toContain('practical-training.bookings.create');
    expect(await top('list candidates')).toContain('hub.candidates.list');
    expect(await top('create webhook')).toContain('webhooks.endpoints.create');
    expect(await top('cancel booking')).toEqual(expect.arrayContaining([expect.stringMatching(/bookings\.cancel$/)]));
  });
});
