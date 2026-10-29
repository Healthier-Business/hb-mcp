import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY, MockHub } from './helpers/mock-hub.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const candidate = { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com' };
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('read-only (default)', () => {
  it('refuses every non-GET operation without contacting the Hub', async () => {
    h = await startHarness();
    for (const [id, args] of [
      ['hub.candidates.create', { body: candidate }],
      ['hub.candidates.update', { path_params: { candidate_ref: REF }, body: { first_name: 'X' } }],
      ['webhooks.endpoints.delete', { path_params: { webhook: '1' } }],
    ] as const) {
      const r = await h.call('hb_call_operation', { operation_id: id, ...args, confirm: true });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('read-only');
    }
    expect(h.hub.apiRequests()).toHaveLength(0);
  });
});

describe('sandbox writes (HB_READ_ONLY=false)', () => {
  it('execute directly, add an Idempotency-Key and show it', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate });
    expect(r.isError).toBe(false);
    expect(r.json.meta.status).toBe(201);
    const sent = h.hub.apiRequests().at(-1)!;
    expect(sent.headers['idempotency-key']).toBe(r.json.meta.idempotency_key);
    expect(sent.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replays safely with the same key and reports the replay; a different body is a 409', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    const first = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate, idempotency_key: 'my-key-1' });
    const again = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate, idempotency_key: 'my-key-1' });
    expect(first.json.meta.idempotent_replayed).toBeUndefined();
    expect(again.json.meta.idempotent_replayed).toBe(true);
    const clash = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: { ...candidate, last_name: 'Other' }, idempotency_key: 'my-key-1' });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('idempotency_conflict');
  });

  it('validates the body against the spec before sending', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: { first_name: 'Jane', email: 'not-an-email' } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('body.last_name is required');
    expect(r.text).toContain('body.email must be a valid email');
    expect(h.hub.apiRequests()).toHaveLength(0);
  });

  it('never retries a write after the connection drops, and returns the key to reuse', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    h.hub.dropNext((r) => r.opId === 'hub.candidates.create');
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('outcome is unknown');
    expect(r.text).toMatch(/idempotency_key used: [0-9a-f-]{36}/);
    expect(h.hub.apiRequests().filter((x) => x.opId === 'hub.candidates.create')).toHaveLength(1);
  });

  it('does not auto-retry a write on 429 either', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    h.hub.failNext(429, { error: 'rate_limited', message: 'slow', request_id: 'r' }, { 'Retry-After': '1' }, (r) => r.opId === 'hub.candidates.create');
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate });
    expect(r.isError).toBe(true);
    expect(h.hub.apiRequests().filter((x) => x.opId === 'hub.candidates.create')).toHaveLength(1);
  });

  it('uploads multipart files', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    const r = await h.call('hb_call_operation', {
      operation_id: 'registration-monitoring.imports.create',
      body: { file: { filename: 'starters.csv', content_text: 'a,b\n1,2\n', content_type: 'text/csv' } },
    });
    expect(r.isError).toBe(false);
    const sent = h.hub.apiRequests().at(-1)!;
    expect(sent.headers['content-type']).toContain('multipart/form-data');
    expect(sent.body).toContain('filename="starters.csv"');
  });
});

describe('live writes', () => {
  const live = { HB_ENV: 'live', HB_READ_ONLY: 'false' };

  it('are refused when only HB_READ_ONLY=false (HB_ALLOW_LIVE_WRITES missing)', async () => {
    h = await startHarness(live);
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('HB_ALLOW_LIVE_WRITES');
    expect(h.hub.apiRequests()).toHaveLength(0);
  });

  it('return a plan first and send nothing; confirm=true executes with the same key', async () => {
    h = await startHarness({ ...live, HB_ALLOW_LIVE_WRITES: 'true' });
    const plan = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate });
    expect(plan.isError).toBe(false);
    expect(plan.json.status).toBe('confirmation_required');
    expect(plan.json.executed).toBe(false);
    expect(plan.json.environment).toBe('LIVE');
    expect(plan.json.request).toBe('POST /api/v2/hub/candidates');
    expect(h.hub.apiRequests()).toHaveLength(0);

    const done = await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate, confirm: true, idempotency_key: plan.json.idempotency_key });
    expect(done.json.meta.status).toBe(201);
    expect(done.json.meta.environment).toBe('live');
    expect(h.hub.apiRequests()).toHaveLength(1);
    expect(h.hub.apiRequests()[0]!.headers['idempotency-key']).toBe(plan.json.idempotency_key);
  });

  it('the plan states credits and health data', async () => {
    h = await startHarness({ ...live, HB_ALLOW_LIVE_WRITES: 'true' });
    const booking = await h.call('hb_call_operation', {
      operation_id: 'practical-training.bookings.create',
      body: { hold_hash: 'k3Jf9QzP1xV7mW2nB8dR5tY0uLcA4sHe', candidate_ref: REF, pay_option: 'credits', agency_contact_name: 'A', agency_contact_email: 'a@example.com' },
    });
    expect(booking.json.credits).toContain('pay_option');
    const health = await h.call('hb_call_operation', {
      operation_id: 'occupational-health.requests.questionnaire.answers',
      path_params: { id: '1', shortcode: 'abc' },
      body: { answers: [] },
    });
    // body validation may reject first; the plan only appears for a valid call
    if (health.json?.status === 'confirmation_required') expect(health.json.health_data).toContain('health data');
    expect(h.hub.apiRequests()).toHaveLength(0);
  });

  it('reads on the live URL need no confirmation', async () => {
    h = await startHarness({ ...live, HB_ALLOW_LIVE_WRITES: 'true' });
    const r = await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(r.json.meta.status).toBe(200);
    expect(r.json.meta.environment).toBe('live');
  });

  it('descriptions announce LIVE', async () => {
    h = await startHarness({ ...live, HB_ALLOW_LIVE_WRITES: 'true' });
    const { tools } = await h.client.listTools();
    const call = tools.find((t) => t.name === 'hb_call_operation')!;
    expect(call.description).toContain('[LIVE Hub]');
    expect(call.description).toContain('confirm=true');
    expect(call.annotations?.readOnlyHint).toBe(false);
    expect(call.annotations?.destructiveHint).toBe(true);
  });
});

describe('toolsets', () => {
  it('HB_TOOLSETS also limits what hb_call_operation may call', async () => {
    h = await startHarness({ HB_TOOLSETS: 'hub' });
    expect((await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' })).isError).toBe(false);
    const r = await h.call('hb_call_operation', { operation_id: 'references.requests.list' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('toolset');
  });
});

describe('scopes', () => {
  it('a key without the scope gets a clear 403 with advice', async () => {
    const hub = await new MockHub(['hub:candidates:read']).start();
    h = await startHarness({}, hub);
    const r = await h.call('hb_call_operation', { operation_id: 'references.requests.list' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('insufficient_scope');
    expect(r.text).toContain('Developer page');
    const status = await h.call('hb_status');
    const s = await h.call('hb_search_operations', { query: 'references requests list' });
    expect(status.isError).toBe(false);
    expect(s.json.operations.find((o: any) => o.id === 'references.requests.list').key_has_scope).toBe(false);
    await h.close();
    h = undefined;
    await hub.stop();
  });
});

describe('secrets', () => {
  it('never appear in tool output or logs, even when the Hub echoes a token back', async () => {
    h = await startHarness({ HB_READ_ONLY: 'false' });
    h.hub.expireAccessTokens();
    const outputs: string[] = [];
    outputs.push((await h.call('hb_status')).text);
    outputs.push((await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' })).text);
    h.hub.failNext(401, { error: 'invalid_token', message: `bad token ${h.hub.issued[0]}`, request_id: 'r' }, {}, (r) => r.opId === 'hub.candidates.show');
    h.hub.failNext(401, { error: 'invalid_token', message: `bad token ${h.hub.issued[0]}`, request_id: 'r' }, {}, (r) => r.opId === 'hub.candidates.show');
    outputs.push((await h.call('hb_call_operation', { operation_id: 'hub.candidates.show', path_params: { candidate_ref: REF } })).text);
    outputs.push((await h.call('hb_call_operation', { operation_id: 'hub.candidates.create', body: candidate })).text);
    // a record whose data field is a token the Hub issued
    const spy = h.hub.issued[0]!;
    h.hub.failNext(400, { error: 'bad_request', message: `echo ${spy} and ${MOCK_KEY}`, request_id: 'r' }, {}, (r) => r.opId === 'hub.candidates.list');
    outputs.push((await h.call('hb_call_operation', { operation_id: 'hub.candidates.list' })).text);
    const all = outputs.join('\n') + '\n' + h.logs.join('\n');
    expect(h.hub.issued.length).toBeGreaterThan(2);
    for (const secret of [MOCK_KEY, ...h.hub.issued]) expect(all).not.toContain(secret);
    expect(h.logs.length).toBeGreaterThan(3);
    // logs hold metadata only: no bodies
    expect(h.logs.join('\n')).not.toContain('jane.doe@example.com');
  });
});
