import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scopeAllowed } from '../src/context.js';
import { redactor } from '../src/redact.js';
import { allTaskTools, CORE_TASK_TOOL_NAMES, READ_TASK_TOOL_NAMES, TASK_TOOL_NAMES, WRITE_TASK_TOOL_NAMES } from '../src/tools/tasks.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY, MockHub } from './helpers/mock-hub.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const EXAMPLE_SECRET = 'whsec_C3J27XDCG2LmlZGEONYlgCtjfIZ4SOcMz9CPVNPkNa1Hedcm';
const WRITE_ENV = { HB_READ_ONLY: 'false' };
const LIVE_WRITE_ENV = { HB_ENV: 'live', HB_READ_ONLY: 'false', HB_ALLOW_LIVE_WRITES: 'true' };

const toStop: MockHub[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const hub of toStop.splice(0)) await hub.stop();
});

const ALL_SCOPES = new MockHub().scopes;
async function withScopes(env: Record<string, string>, drop: (s: string) => boolean = () => false): Promise<Harness> {
  const hub = await new MockHub(ALL_SCOPES.filter((s) => !drop(s))).start();
  toStop.push(hub);
  h = await startHarness(env, hub);
  return h;
}
const writes = (x: Harness) => x.hub.apiRequests().filter((r) => r.method !== 'GET');
const ops = (r: { data: any }) => r.data.operations_called as string[];

describe('task tool surface', () => {
  it('read-only: only the fourteen read task tools, annotated read-only; writes hidden', async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const task = tools.filter((t) => (TASK_TOOL_NAMES as readonly string[]).includes(t.name));
    expect(task.map((t) => t.name).sort()).toEqual([...READ_TASK_TOOL_NAMES].sort());
    for (const t of task) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(tools).toHaveLength(8 + 14);
    expect(h.client.getInstructions()).toContain('hb_find_candidate');
    expect(h.client.getInstructions()).toContain('hb_credits');
    expect(h.client.getInstructions()).not.toContain('hb_book_practical_training');
    expect(h.client.getInstructions()).toContain('HB_TASK_TOOLS');
  });

  it('sandbox with writes: all 30 task tools in compact (38 tools) and in full mode; write annotations are correct', async () => {
    h = await startHarness(WRITE_ENV);
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(8 + 30);
    expect(WRITE_TASK_TOOL_NAMES).toHaveLength(16);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of WRITE_TASK_TOOL_NAMES) {
      expect(by[n], n).toBeDefined();
      expect(by[n]!.annotations?.readOnlyHint, n).toBe(false);
    }
    expect(by.hb_book_practical_training!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(by.hb_setup_sandbox_webhook!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(by.hb_change_booking!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(by.hb_rotate_webhook_secret!.annotations).toMatchObject({ destructiveHint: true });
    expect(by.hb_save_candidate!.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(by.hb_book_practical_training!.description).toContain('[SANDBOX]');
    expect(by.hb_setup_sandbox_webhook!.description).toContain('SANDBOX ONLY');
    for (const n of WRITE_TASK_TOOL_NAMES) expect((by[n]!.inputSchema as any).properties.confirm ?? n === 'hb_setup_sandbox_webhook').toBeTruthy();
    await h.close();
    h = await startHarness({ ...WRITE_ENV, HB_TOOL_MODE: 'full' });
    const full = (await h.client.listTools()).tools;
    expect(full.filter((t) => (TASK_TOOL_NAMES as readonly string[]).includes(t.name))).toHaveLength(30);
    expect(full).toHaveLength(210 + 5 + 30);
  });

  it('HB_TASK_TOOLS=core offers the first seven plus credits, bookings, webhook health and verification status; none offers no task tool', async () => {
    h = await startHarness({ ...WRITE_ENV, HB_TASK_TOOLS: 'core' });
    const names = (await h.client.listTools()).tools.map((t) => t.name).filter((n) => (TASK_TOOL_NAMES as readonly string[]).includes(n));
    expect(names.sort()).toEqual([...CORE_TASK_TOOL_NAMES].sort());
    expect(CORE_TASK_TOOL_NAMES).toHaveLength(11);
    await h.close();
    h = await startHarness({ HB_TASK_TOOLS: 'core' });
    expect((await h.client.listTools()).tools).toHaveLength(8 + 9);
    await h.close();
    h = await startHarness({ ...WRITE_ENV, HB_TASK_TOOLS: 'none' });
    expect((await h.client.listTools()).tools).toHaveLength(8);
    expect(h.client.getInstructions()).not.toContain('hb_find_candidate');
  });

  it('HB_TOOLSETS hides task tools whose portals are not enabled', async () => {
    h = await startHarness({ ...WRITE_ENV, HB_TOOLSETS: 'hub' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['hb_find_candidate', 'hb_candidate_overview', 'hb_go_live_check']));
    expect(names).not.toContain('hb_account_summary');
    expect(names).not.toContain('hb_book_practical_training');
    expect(names).not.toContain('hb_setup_sandbox_webhook');
  });

  it('live without live-write permission hides the write tools too', async () => {
    h = await startHarness({ HB_ENV: 'live', HB_READ_ONLY: 'false' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('hb_book_practical_training');
  });

  it('wildcard scopes count for the scope check', () => {
    expect(scopeAllowed(['*'], 'hub:candidates:read')).toBe(true);
    expect(scopeAllowed(['hub:*'], 'hub:candidates:read')).toBe(true);
    expect(scopeAllowed(['hub:*'], 'practical-training:bookings:read')).toBe(false);
    expect(scopeAllowed(['occupational-health:requests:write'], 'occupational-health:requests:read')).toBe(true);
  });
});

describe('hb_find_candidate', () => {
  it('finds by text and says which portals have a record', async () => {
    h = await startHarness();
    const r = await h.call('hb_find_candidate', { query: 'jane' });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain(REF);
    expect(r.parts[0]).toContain('Jane Doe');
    expect(r.parts[0]).toContain('Online Training: compliant');
    expect(ops(r)).toEqual(expect.arrayContaining(['hub.candidates.list', 'hub.candidates.show']));
    expect(h.hub.apiRequests().find((x) => x.opId === 'hub.candidates.list')!.query.get('search')).toBe('jane');
    expect(r.data.candidates[0].candidate_ref).toBe(REF);
    expect(r.text).not.toContain(MOCK_KEY);
  });

  it('a uuid goes straight to the show operation', async () => {
    h = await startHarness();
    const r = await h.call('hb_find_candidate', { query: REF });
    expect(ops(r).filter((o) => o !== 'auth.me.show')).toEqual(['hub.candidates.show']);
    expect(r.data.candidates).toHaveLength(1);
  });

  it('reports no match without inventing one', async () => {
    h = await startHarness();
    h.hub.failNext(200, { data: [], meta: { page: 1, per_page: 10, total: 0, last_page: 1 }, links: {} }, {}, (x) => x.opId === 'hub.candidates.list');
    const r = await h.call('hb_find_candidate', { query: 'nobody' });
    expect(r.parts[0]).toContain('No candidate matches');
    expect(r.parts[0]).toContain('Never guess');
  });

  it('missing scope: nothing is sent and the scope is named', async () => {
    const x = await withScopes({}, (s) => s === 'hub:candidates:read' || s === 'hub:candidates:write');
    const r = await x.call('hb_find_candidate', { query: 'jane' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('hub:candidates:read');
    expect(x.hub.apiRequests().filter((q) => q.opId?.startsWith('hub.'))).toHaveLength(0);
  });
});

describe('hb_candidate_overview', () => {
  it('summarises every portal, one line per record, with the operations used', async () => {
    h = await startHarness();
    const r = await h.call('hb_candidate_overview', { candidate_ref: REF });
    expect(r.isError).toBe(false);
    for (const label of ['Online training:', 'Practical training:', 'Virtual BLS:', 'References:', 'DBS and right to work:', 'Registration monitoring:', 'Clinical appraisals:', 'Clinical interviews:', 'Occupational health:']) {
      expect(r.parts[0]).toContain(label);
    }
    expect(ops(r)).toEqual(expect.arrayContaining([
      'hub.candidates.show', 'online-training.candidates.show', 'practical-training.bookings.list', 'virtual-bls-training.bookings.list', 'references.requests.list',
      'dbs-rtw.workers.list', 'registration-monitoring.workers.list', 'clinical-appraisals.bookings.list', 'clinical-interviews.bookings.list', 'occupational-health.requests.list',
    ]));
    expect(h.hub.apiRequests().every((q) => q.method === 'GET')).toBe(true);
    const pt = h.hub.apiRequests().find((q) => q.opId === 'practical-training.bookings.list')!;
    expect(pt.query.get('candidate_ref')).toBe(REF);
  });

  it('occupational health is statuses and dates only: no clearance, form, document, answers or contact details', async () => {
    h = await startHarness();
    const r = await h.call('hb_candidate_overview', { candidate_ref: REF });
    const oh = r.parts[0]!.split('\n').filter((l) => /New Starter|Full Clearance/.test(l)).join('\n');
    expect(oh).toContain('Full Clearance');
    expect(r.text).not.toContain('Exposure Prone');
    expect(r.text).not.toContain('Questionnaire');
    expect(r.text).not.toContain('FTW Certificate');
    expect(r.text).not.toContain('jane.doe@example.com');
    expect(r.text).not.toContain('zoom');
    expect(r.text).not.toContain('07700');
    expect(r.parts[0]).toContain('statuses and dates only');
    const sent = h.hub.apiRequests().filter((q) => q.path.includes('occupational-health'));
    expect(sent.map((q) => q.opId)).toEqual(['occupational-health.requests.list']);
  });

  it('skips portals the key has no scope for, names them, and does not call them', async () => {
    const x = await withScopes({}, (s) => s.startsWith('occupational-health:') || s.startsWith('practical-training:'));
    const r = await x.call('hb_candidate_overview', { candidate_ref: REF });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Skipped:');
    expect(r.parts[0]).toContain('Occupational health (the key lacks the scope occupational-health:requests:read)');
    expect(r.parts[0]).toContain('Practical training');
    expect(ops(r)).not.toContain('occupational-health.requests.list');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('occupational-health') || q.path.includes('practical-training'))).toHaveLength(0);
    expect(r.parts[0]).toContain('Online training:');
  });

  it('a portal the account does not use is skipped with that reason', async () => {
    h = await startHarness();
    h.hub.failNext(403, { error: 'portal_unavailable', message: 'The account does not use this portal.' }, {}, (q) => q.opId === 'references.requests.list');
    const r = await h.call('hb_candidate_overview', { candidate_ref: REF });
    expect(r.parts[0]).toContain('References (the account does not use this portal)');
  });

  it('a toolset left out by HB_TOOLSETS is skipped', async () => {
    h = await startHarness({ HB_TOOLSETS: 'hub,online-training' });
    const r = await h.call('hb_candidate_overview', { candidate_ref: REF });
    expect(r.parts[0]).toContain('toolset is not enabled');
    expect(ops(r).sort()).toEqual(['hub.candidates.show', 'online-training.candidates.show']);
  });

  it('rejects a candidate_ref that is not a uuid', async () => {
    h = await startHarness();
    const r = await h.call('hb_candidate_overview', { candidate_ref: 'jane' });
    expect(r.isError).toBe(true);
    expect(h.hub.apiRequests()).toHaveLength(0);
  });
});

describe('hb_account_summary', () => {
  it('gives key, credits and webhook health in one answer without secrets', async () => {
    h = await startHarness();
    h.hub.failNext(200, {
      data: [{ id: 12, name: 'Orders', url: 'https://example.com/hooks/hub?token=abc123secrettoken', events: ['a'], is_active: true, consecutive_failures: 3, last_response_code: 500, last_delivered_at: '2026-10-28T19:53:25Z' }],
    }, {}, (q) => q.opId === 'webhooks.endpoints.list');
    const r = await h.call('hb_account_summary');
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Mock key');
    expect(r.parts[0]).toContain('Online training: balance 100 credits');
    expect(r.parts[0]).toContain('Occupational health: balance 42');
    expect(r.parts[0]).toContain('Practical training:');
    expect(r.parts[0]).toContain('#12 Orders: failing (3 failed in a row)');
    expect(r.parts[0]).toContain('recent for #12');
    expect(r.text).not.toContain('abc123secrettoken');
    expect(r.text).not.toContain(MOCK_KEY);
    expect(ops(r)).toEqual(expect.arrayContaining(['auth.me.show', 'online-training.credits.show', 'webhooks.endpoints.list', 'webhooks.deliveries.list']));
    expect(r.data.webhook_endpoints[0].health).toBe('failing');
  });

  it('skips what the key cannot read and says so', async () => {
    const x = await withScopes({}, (s) => s.startsWith('account:') || s.startsWith('occupational-health:credits'));
    const r = await x.call('hb_account_summary');
    expect(r.parts[0]).toContain('Skipped:');
    expect(r.parts[0]).toContain('webhook endpoints (the key lacks the scope account:webhooks:read)');
    expect(r.parts[0]).toContain('Occupational health credits');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('/webhooks') || q.path.includes('occupational-health'))).toHaveLength(0);
  });
});

describe('hb_needs_attention', () => {
  it('builds the list from what the API exposes', async () => {
    h = await startHarness();
    h.hub.failNext(200, { data: [{ id: 12, name: 'Orders', url: 'https://example.com/h', events: [], is_active: false, consecutive_failures: 25, last_response_code: 500 }] }, {}, (q) => q.opId === 'webhooks.endpoints.list');
    h.hub.failNext(200, { data: [{ id: 9, candidate_name: 'Jo Smith', candidate_ref: REF, booking_status: 'pending', course: { name: 'Manual Handling' }, start_date: '2026-11-07T09:00:00Z' }] }, {}, (q) => q.opId === 'practical-training.bookings.list');
    const r = await h.call('hb_needs_attention');
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('webhook endpoint(s) are failing or switched off');
    expect(r.parts[0]).toContain('#12 Orders: disabled');
    expect(r.parts[0]).toContain('awaiting candidate payment');
    expect(r.parts[0]).toContain('Jo Smith');
    expect(r.parts[0]).toContain('unacknowledged registration alert');
    expect(r.parts[0]).toContain('online training candidate(s) need attention');
    expect(r.parts[0]).toContain('Occupational health: 7 awaiting the candidate, 13 rejected or failed (counts only)');
    expect(ops(r)).toContain('occupational-health.requests.stats');
    expect(ops(r)).not.toContain('occupational-health.alerts.list');
    expect(r.text).not.toContain('Exposure Prone');
    expect(h.hub.apiRequests().every((q) => q.method === 'GET')).toBe(true);
  });

  it('does not report bookings that are not pending (the mock ignores filters, the tool checks)', async () => {
    h = await startHarness();
    const r = await h.call('hb_needs_attention');
    expect(r.parts[0]).not.toContain('awaiting candidate payment');
  });

  it('with no scopes for a portal it is listed under not checked', async () => {
    const x = await withScopes({}, (s) => s.startsWith('dbs-rtw:'));
    const r = await x.call('hb_needs_attention');
    expect(r.parts[0]).toContain('Not checked:');
    expect(r.parts[0]).toContain('dbs-rtw (the key lacks the scope dbs-rtw:alerts:read)');
    expect(ops(r)).not.toContain('dbs-rtw.alerts.list');
  });
});

describe('hb_go_live_check', () => {
  it('reports environment, scopes against the portals needed, webhooks and the remaining steps; sends only reads', async () => {
    h = await startHarness();
    const r = await h.call('hb_go_live_check', { portals: ['hub', 'practical-training', 'account'] });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Environment: SANDBOX');
    expect(r.parts[0]).toContain('WARN  This server points at a SANDBOX');
    expect(r.parts[0]).toContain('OK    The key type matches the environment (test key)');
    expect(r.parts[0]).toContain('OK    practical-training: the key has');
    expect(r.parts[0]).toContain('The key also reaches portals you did not list');
    expect(r.parts[0]).toContain('The key has no expiry date');
    expect(r.parts[0]).toContain('IP allowlist: the API does not show it');
    expect(r.parts[0]).toContain('At least one active webhook endpoint');
    expect(r.parts[0]).toContain('hb://guides/going-live');
    expect(r.data.remaining_steps.length).toBeGreaterThan(5);
    expect(h.hub.apiRequests().every((q) => q.method === 'GET')).toBe(true);
  });

  it('fails a portal the key has no scope for and a test key against a live URL', async () => {
    const x = await withScopes({ HB_ENV: 'live' }, (s) => s.startsWith('references:'));
    const r = await x.call('hb_go_live_check', { portals: ['references'] });
    expect(r.parts[0]).toContain('FAIL  references: the key has no scope for this portal');
    expect(r.parts[0]).toContain('FAIL  Mismatch: a sandbox test key');
    expect(r.parts[0]).toContain('The server is read-only');
    expect(r.data.ready).toBe(false);
  });

  it('warns on wildcard scopes and a failing or non-https webhook', async () => {
    const hub = await new MockHub(['*']).start();
    toStop.push(hub);
    h = await startHarness({}, hub);
    hub.failNext(200, { data: [{ id: 3, name: 'Old', url: 'http://localhost:9000/x', events: [], is_active: false, consecutive_failures: 4 }] }, {}, (q) => q.opId === 'webhooks.endpoints.list');
    const r = await h.call('hb_go_live_check');
    expect(r.parts[0]).toContain('wildcard scope(s): *');
    expect(r.parts[0]).toContain('FAIL  No active webhook endpoint');
    expect(r.parts[0]).toContain('does not use https');
    expect(r.parts[0]).toContain('is switched off');
    expect(r.parts[0]).toContain('4 failed deliveries in a row');
  });
});

describe('hb_book_practical_training', () => {
  const ARGS = { candidate_ref: REF };
  const CHOSEN = { ...ARGS, event_id: 44, pay_option: 'credits', agency_contact_name: 'Alex Morgan', agency_contact_email: 'alex@example.com' };

  it('is hidden while read-only and refuses if reached directly', async () => {
    h = await startHarness();
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('hb_book_practical_training');
    const r = await h.call('hb_book_practical_training', ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown tool');
    const tool = allTaskTools(h.ctx).find((t) => t.definition.name === 'hb_book_practical_training')!;
    const direct = await tool.definition.handler({ ...CHOSEN, confirm: true });
    expect(direct.isError).toBe(true);
    expect(direct.content[0]!.text).toContain('read-only');
    expect(writes(h)).toHaveLength(0);
  });

  it('call 1 returns options and credits and sends nothing', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_book_practical_training', { ...ARGS, location: 'leeds', date_from: '2026-11-01', date_to: '2026-11-30', course_id: 1 });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Leeds Training Centre');
    expect(r.parts[0]).toContain('45.00 GBP');
    expect(r.parts[0]).toContain('Next: ask the user');
    expect(r.data.executed).toBe(false);
    expect(r.data.options[0].event_id).toBe(44);
    expect(r.data.options[0].booking_credits_for_course).toBe(12);
    expect(writes(h)).toHaveLength(0);
    const list = h.hub.apiRequests().find((q) => q.opId === 'practical-training.events.list')!;
    expect(list.query.get('available_only')).toBe('true');
    expect(list.query.get('start_date_from')).toBe('2026-11-01');
    expect(list.query.get('course_id')).toBe('1');
    expect(ops(r)).toEqual(expect.arrayContaining(['practical-training.locations.list', 'practical-training.events.list', 'practical-training.credits.show']));
  });

  it('a chosen session without confirm returns the plan, still sending nothing', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_book_practical_training', CHOSEN);
    expect(r.parts[0]).toContain('PLAN (nothing sent)');
    expect(r.parts[0]).toContain('takes one booking credit');
    expect(r.parts[0]).toContain('confirm=true');
    expect(r.data.stage).toBe('plan');
    expect(r.data.idempotency_key).toBeTruthy();
    expect(writes(h)).toHaveLength(0);
  });

  it('call 2 with confirm holds then books, with idempotency keys', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_book_practical_training', CHOSEN);
    const key = plan.data.idempotency_key as string;
    const r = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true, idempotency_key: key });
    expect(r.isError).toBe(false);
    expect(r.data.executed).toBe(true);
    expect(r.data.booking.id).toBe(812);
    expect(r.parts[0]).toContain('Booked: booking #812');
    const w = writes(h);
    expect(w.map((q) => q.opId)).toEqual(['practical-training.events.hold', 'practical-training.bookings.create']);
    expect(w[0]!.headers['idempotency-key']).toBe(`${key}-hold`);
    expect(w[1]!.headers['idempotency-key']).toBe(`${key}-book`);
    expect((w[1]!.json as any).hold_hash).toBe('k3Jf9QzP1xV7mW2nB8dR5tY0uLcA4sHe');
    expect((w[1]!.json as any).candidate_ref).toBe(REF);
    expect(ops(r)).toEqual(expect.arrayContaining(['practical-training.events.hold', 'practical-training.bookings.create']));
  });

  it('repeating with the same key does not double book (the Hub replays)', async () => {
    h = await startHarness(WRITE_ENV);
    const a = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true, idempotency_key: 'k-1' });
    const b = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true, idempotency_key: 'k-1' });
    expect(a.data.booking.id).toBe(b.data.booking.id);
    expect(h.hub.apiRequests().filter((q) => q.opId === 'practical-training.bookings.create').map((q) => q.headers['idempotency-key'])).toEqual(['k-1-book', 'k-1-book']);
  });

  it('confirm without the pay option or contact is refused before anything is sent', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_book_practical_training', { ...ARGS, event_id: 44, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('pay_option');
    expect(writes(h)).toHaveLength(0);
  });

  it('a missing scope refuses and names it', async () => {
    const x = await withScopes(WRITE_ENV, (s) => s === 'practical-training:bookings:write');
    const r = await x.call('hb_book_practical_training', { ...CHOSEN, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('practical-training:bookings:write');
    expect(writes(x)).toHaveLength(0);
  });

  it('a rejected booking releases the hold it made and says so', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.failNext(422, { error: 'booking_rejected', message: 'No.' }, {}, (q) => q.opId === 'practical-training.bookings.create');
    const r = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('booking_rejected');
    expect(r.text).toContain('released');
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.events.hold', 'practical-training.bookings.create', 'practical-training.events.release']);
  });

  it('an existing hold (409) stops the booking with advice', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.failNext(409, { error: 'conflict', message: 'You already hold a place.' }, {}, (q) => q.opId === 'practical-training.events.hold');
    const r = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('already has a live hold');
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.events.hold']);
  });

  it('LIVE: needs live-write permission; the plan call sends nothing; confirm=true books', async () => {
    h = await startHarness(LIVE_WRITE_ENV);
    const plan = await h.call('hb_book_practical_training', CHOSEN);
    expect(plan.parts[0]).toContain('LIVE Hub');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_book_practical_training', { ...CHOSEN, confirm: true });
    expect(done.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.events.hold', 'practical-training.bookings.create']);
  });

  it('invite mode: plan first, then one invitation', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_book_practical_training', { ...ARGS, invite: true });
    expect(plan.parts[0]).toContain('PLAN (nothing sent)');
    expect(plan.parts[0]).toContain('valid for 8 weeks');
    expect(writes(h)).toHaveLength(0);
    const sent = await h.call('hb_book_practical_training', { ...ARGS, invite: true, confirm: true });
    expect(sent.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.booking-invites.create']);
    expect((writes(h)[0]!.json as any).candidate_ref).toBe(REF);
  });

  it('warns when the candidate lacks details the Hub requires', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.failNext(200, { data: { candidate_ref: REF, first_name: 'Jane', name: 'Jane Doe', email: 'j@example.com', phone: null, services: [] } }, {}, (q) => q.opId === 'hub.candidates.show');
    const r = await h.call('hb_book_practical_training', ARGS);
    expect(r.parts[0]).toContain('no phone number');
    expect(r.data.missing_details).toEqual(['phone number']);
  });
});

describe('hb_setup_sandbox_webhook', () => {
  const URL_OK = 'https://receiver.example.org/hooks/hub';

  it('is hidden while read-only and refuses if reached directly', async () => {
    h = await startHarness();
    expect((await h.client.listTools()).tools.map((t) => t.name)).not.toContain('hb_setup_sandbox_webhook');
    const tool = allTaskTools(h.ctx).find((t) => t.definition.name === 'hb_setup_sandbox_webhook')!;
    const r = await tool.definition.handler({ url: URL_OK });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('read-only');
    expect(writes(h)).toHaveLength(0);
  });

  it('creates the endpoint, sends a test event, reports the delivery and never shows the secret', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.failNext(200, { data: [{ key: 'all', label: 'All', events: h.ctx.catalogue.events.map((e) => ({ event: e.type, label: e.summary })) }] }, {}, (q) => q.opId === 'webhooks.events.list');
    h.hub.failNext(200, { data: [{ id: 4502, event_type: 'webhook.test', status: 'delivered', attempt: 1, response_code: 200, delivered_at: '2026-10-28T19:53:26Z', created_at: '2026-10-28T19:53:25Z' }] }, {}, (q) => q.opId === 'webhooks.deliveries.list');
    const r = await h.call('hb_setup_sandbox_webhook', { url: URL_OK, name: 'Local test' });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain(EXAMPLE_SECRET);
    expect(r.text).not.toContain('whsec_C3J27XDCG2');
    expect(r.parts[0]).toContain('withheld');
    expect(r.parts[0]).toContain('Test event delivery #4502: delivered, your server answered 200');
    expect(r.data.signing_secret).toBe('withheld');
    const w = writes(h);
    expect(w.map((q) => q.opId)).toEqual(['webhooks.endpoints.create', 'webhooks.endpoints.test']);
    const body = w[0]!.json as any;
    expect(body.url).toBe(URL_OK);
    expect(body.name).toBe('Local test');
    expect(body.events).toEqual(expect.arrayContaining(['online-training.course.completed', 'practical-training.booking.created']));
    expect(body.events.every((e: string) => h!.ctx.catalogue.event(e))).toBe(true);
    expect(ops(r)).toEqual(expect.arrayContaining(['webhooks.endpoints.create', 'webhooks.endpoints.test', 'webhooks.deliveries.list']));
    expect(h.logs.join('\n')).not.toContain(EXAMPLE_SECRET);
  });

  it('reports a queued test whose outcome is not known yet', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_setup_sandbox_webhook', { url: URL_OK });
    expect(r.parts[0]).toContain('was queued; its outcome is not available yet');
  });

  it('save_secret_to keeps the secret in a new owner-only file, never in the answer, and never overwrites', async () => {
    h = await startHarness(WRITE_ENV);
    const dir = mkdtempSync(join(tmpdir(), 'hb-secret-'));
    const file = join(dir, 'secret.txt');
    const r = await h.call('hb_setup_sandbox_webhook', { url: URL_OK, save_secret_to: file });
    expect(r.text).not.toContain(EXAMPLE_SECRET);
    expect(r.parts[0]).toContain(`saved to ${file}`);
    expect(readFileSync(file, 'utf8').trim()).toBe(EXAMPLE_SECRET);
    const again = await h.call('hb_setup_sandbox_webhook', { url: 'https://receiver.example.org/other', save_secret_to: file });
    expect(again.parts[0]).toContain('could NOT be saved');
    expect(readFileSync(file, 'utf8').trim()).toBe(EXAMPLE_SECRET);
    expect(existsSync(file)).toBe(true);
    const rel = await h.call('hb_setup_sandbox_webhook', { url: 'https://receiver.example.org/third', save_secret_to: 'relative.txt' });
    expect(rel.parts[0]).toContain('must be an absolute path');
  });

  it('refuses on LIVE with a clear message and sends nothing', async () => {
    h = await startHarness(LIVE_WRITE_ENV);
    const r = await h.call('hb_setup_sandbox_webhook', { url: URL_OK });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('SANDBOX only');
    expect(r.text).toContain('LIVE');
    expect(h.hub.apiRequests()).toHaveLength(0);
  });

  it('does not create a second endpoint for a URL that already exists', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_setup_sandbox_webhook', { url: 'https://example.com/hooks/hub' });
    expect(r.parts[0]).toContain('already exists');
    expect(writes(h)).toHaveLength(0);
  });

  it('refuses unknown events, http URLs and a key without the scope, before sending', async () => {
    h = await startHarness(WRITE_ENV);
    const bad = await h.call('hb_setup_sandbox_webhook', { url: URL_OK, events: ['nope.event'] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Unknown event');
    const http = await h.call('hb_setup_sandbox_webhook', { url: 'http://receiver.example.org/x' });
    expect(http.isError).toBe(true);
    expect(writes(h)).toHaveLength(0);
    await h.close();
    const x = await withScopes(WRITE_ENV, (s) => s === 'account:webhooks:write');
    const r = await x.call('hb_setup_sandbox_webhook', { url: URL_OK });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('account:webhooks:write');
    expect(writes(x)).toHaveLength(0);
  });

  it('the generic tool no longer shows a signing secret the Hub creates', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_call_operation', { operation_id: 'webhooks.endpoints.create', body: { name: 'x', url: URL_OK, events: ['online-training.course.completed'] } });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain(EXAMPLE_SECRET);
    expect(r.text).toContain('[redacted]');
    expect(r.text).toContain('whsec_C3J27X');
    redactor.forget(EXAMPLE_SECRET);
  });
});
