import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { allTaskTools, WRITE_TASK_TOOL_NAMES } from '../src/tools/tasks.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY, MockHub } from './helpers/mock-hub.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const EXAMPLE_SECRET = 'whsec_C3J27XDCG2LmlZGEONYlgCtjfIZ4SOcMz9CPVNPkNa1Hedcm';
const WRITE_ENV = { HB_READ_ONLY: 'false' };
const LIVE_WRITE_ENV = { HB_ENV: 'live', HB_READ_ONLY: 'false', HB_ALLOW_LIVE_WRITES: 'true' };
const FUTURE = '2099-01-10T10:00:00Z';

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
const writes = (x: Harness) => x.hub.apiRequests().filter((r) => r.method !== 'GET' && !r.opId?.endsWith('imports.preview'));
const ops = (r: { data: any }) => r.data.operations_called as string[];
const answer = (x: Harness, op: string, body: unknown, status = 200) => x.hub.failNext(status, body, {}, (q) => q.opId === op);

// ------------------------------------------------------------------------------------------- read tools

describe('hb_training_progress', () => {
  it('shows courses, modules and practical results with the operations used', async () => {
    h = await startHarness();
    const r = await h.call('hb_training_progress', { candidate_ref: REF, course_id: 12, available_courses: true });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Basic Life Support [Mandatory training]: completed, grade 0.9');
    expect(r.parts[0]).toContain('Modules:');
    expect(r.parts[0]).toContain('Practical results:');
    expect(r.parts[0]).toContain('Courses the account can assign');
    expect(ops(r)).toEqual(expect.arrayContaining(['online-training.candidates.show', 'online-training.candidates.results', 'online-training.candidates.results.show', 'online-training.candidates.modules', 'online-training.candidates.practical-results', 'online-training.courses.list']));
    expect(h.hub.apiRequests().every((q) => q.method === 'GET')).toBe(true);
  });

  it('missing scope is named and nothing is called; a candidate without a record is explained', async () => {
    const x = await withScopes({}, (s) => s.startsWith('online-training:results') || s.startsWith('online-training:candidates'));
    const r = await x.call('hb_training_progress', { candidate_ref: REF });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('online-training:candidates:read');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('online-training'))).toHaveLength(0);
    await x.close();
    h = await startHarness();
    answer(h, 'online-training.candidates.show', { error: 'not_found', message: 'No.' }, 404);
    const none = await h.call('hb_training_progress', { candidate_ref: REF });
    expect(none.parts[0]).toContain('No online training record');
  });
});

describe('hb_list_bookings', () => {
  it('lists the four portals in one table, with no-shows, filters and no contact details', async () => {
    h = await startHarness();
    const r = await h.call('hb_list_bookings', { candidate_ref: REF, date_from: '2026-01-01', date_to: '2026-12-31', status: 'booked' });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('portal | id | candidate | what | start | status | payment');
    for (const p of ['practical-training |', 'virtual-bls-training |', 'clinical-interviews |', 'clinical-appraisals |', 'practical-training (no-show) |']) expect(r.parts[0]).toContain(p);
    expect(r.text).not.toContain('jane.smith@example.com');
    expect(r.text).not.toContain('12A3456E');
    const pt = h.hub.apiRequests().find((q) => q.opId === 'practical-training.bookings.list')!;
    expect(pt.query.get('start_date_from')).toBe('2026-01-01');
    expect(pt.query.get('candidate_ref')).toBe(REF);
    expect(pt.query.get('status')).toBe('booked');
    const ca = h.hub.apiRequests().find((q) => q.opId === 'clinical-appraisals.bookings.list')!;
    expect(ca.query.get('created_from')).toBe('2026-01-01');
  });

  it('portal filter, no-shows off and missing scope', async () => {
    const x = await withScopes({}, (s) => s.startsWith('virtual-bls-training:'));
    const r = await x.call('hb_list_bookings', { include_no_shows: false });
    expect(r.parts[0]).toContain('Skipped: Virtual BLS (the key lacks the scope virtual-bls-training:bookings:read)');
    expect(ops(r)).not.toContain('practical-training.bookings.no-shows');
    expect(ops(r)).not.toContain('virtual-bls-training.bookings.list');
    const only = await x.call('hb_list_bookings', { portals: ['clinical-interviews'] });
    expect(ops(only).filter((o) => o.endsWith('bookings.list'))).toEqual(['clinical-interviews.bookings.list']);
  });
});

describe('hb_credits', () => {
  it('shows balances and recent transactions for every portal, and the OH packages', async () => {
    h = await startHarness();
    const r = await h.call('hb_credits', { recent: 2 });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Online training: balance 100 credits');
    expect(r.parts[0]).toContain('Occupational health: balance 42');
    expect(r.parts[0]).toContain('Virtual BLS:');
    expect(r.parts[0]).toContain('Clinical interviews:');
    expect(r.parts[0]).toContain('Occupational health credit packages: 100 credits for 500.00 GBP');
    expect(r.parts[0]).toMatch(/2026-10-28 withdraw 45\.00 GBP/);
    expect(ops(r)).toEqual(expect.arrayContaining(['online-training.credits.transactions', 'practical-training.credits.transactions', 'occupational-health.credits.packages']));
    const noTx = await h.call('hb_credits', { transactions: false });
    expect(ops(noTx).some((o) => o.endsWith('credits.transactions'))).toBe(false);
  });

  it('skips portals without the credits scope and says so', async () => {
    const x = await withScopes({}, (s) => s.startsWith('clinical-appraisals:credits') || s === 'occupational-health:credits:read');
    const r = await x.call('hb_credits');
    expect(r.parts[0]).toContain('Clinical appraisals credits (the key lacks the scope clinical-appraisals:credits:read)');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('clinical-appraisals'))).toHaveLength(0);
  });
});

describe('hb_webhook_health', () => {
  it('shows health, failed deliveries and a response code summary without query strings', async () => {
    h = await startHarness();
    answer(h, 'webhooks.endpoints.list', { data: [{ id: 3, name: 'Orders', url: 'https://example.com/hook?token=zzsecrettoken1', events: ['a'], is_active: true, consecutive_failures: 4, last_response_code: 500, last_delivered_at: '2026-10-28T19:53:25Z' }] });
    answer(h, 'webhooks.deliveries.list', { data: [{ id: 9, event_type: 'online-training.course.completed', status: 'failed', attempt: 5, response_code: 500, created_at: '2026-10-28T19:00:00Z' }, { id: 8, event_type: 'x', status: 'failed', attempt: 2, response_code: null, created_at: '2026-10-28T18:00:00Z' }] });
    const r = await h.call('hb_webhook_health');
    expect(r.parts[0]).toContain('#3 Orders: failing, 4 failed in a row');
    expect(r.parts[0]).toContain('1 x 500, 1 x no response');
    expect(r.text).not.toContain('zzsecrettoken1');
    expect(r.parts[0]).toContain('not the error text');
    expect(h.hub.apiRequests().find((q) => q.opId === 'webhooks.deliveries.list')!.query.get('status')).toBe('failed');
    expect(ops(r)).toEqual(expect.arrayContaining(['webhooks.endpoints.list', 'webhooks.deliveries.list']));
  });

  it('one endpoint, and a missing scope', async () => {
    h = await startHarness();
    const r = await h.call('hb_webhook_health', { endpoint_id: 12 });
    expect(ops(r)).toContain('webhooks.endpoints.show');
    expect(r.parts[0]).toContain('#12 Orders system: healthy');
    await h.close();
    const x = await withScopes({}, (s) => s.startsWith('account:'));
    const miss = await x.call('hb_webhook_health');
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain('account:webhooks:read');
  });
});

describe('hb_monitoring_alerts', () => {
  it('lists the three portals; occupational health is statuses only', async () => {
    h = await startHarness();
    const r = await h.call('hb_monitoring_alerts', { acknowledged: false });
    expect(r.parts[0]).toContain('DBS and right to work: 1 alert(s)');
    expect(r.parts[0]).toContain('Registration monitoring: 1 alert(s)');
    expect(r.parts[0]).toContain('rejected:4821: rejected [critical] Rejected');
    const oh = await h.call('hb_monitoring_alerts', { portals: ['occupational-health'] });
    expect(oh.text).not.toContain('Jane Doe');
    expect(oh.text).not.toContain('Exposure Prone');
    expect(oh.text).not.toContain('resubmission needed');
    expect(oh.data.alerts[0]).not.toHaveProperty('candidate_name');
    expect(oh.parts[0]).toContain('statuses only');
  });

  it('shows one alert and needs the portal for it; skips portals without scope', async () => {
    h = await startHarness();
    const one = await h.call('hb_monitoring_alerts', { alert_id: 9, portal: 'dbs-rtw' });
    expect(one.parts[0]).toContain('Alert #9 [high]');
    expect(ops(one)).toContain('dbs-rtw.alerts.show');
    const bad = await h.call('hb_monitoring_alerts', { alert_id: 9 });
    expect(bad.isError).toBe(true);
    await h.close();
    const x = await withScopes({}, (s) => s.startsWith('occupational-health:alerts'));
    const r = await x.call('hb_monitoring_alerts');
    expect(r.parts[0]).toContain('Occupational health (the key lacks the scope occupational-health:alerts:read)');
    expect(ops(r)).not.toContain('occupational-health.alerts.list');
  });
});

describe('hb_worker_status', () => {
  it('shows the check result, history and evidence metadata without personal documents or numbers', async () => {
    h = await startHarness();
    const r = await h.call('hb_worker_status', { portal: 'dbs-rtw', search: 'jane' });
    expect(r.parts[0]).toContain('DBS: Clear – no new info, certificate ********3456');
    expect(r.parts[0]).toContain('Right to work: Has right to work');
    expect(r.parts[0]).toContain('evidence dbs_certificate');
    expect(r.text).not.toContain('1988-04-17');
    expect(r.text).not.toContain('jane.doe@example.com');
    expect(ops(r)).toEqual(expect.arrayContaining(['dbs-rtw.workers.list', 'dbs-rtw.workers.verification', 'dbs-rtw.workers.evidence']));
    const reg = await h.call('hb_worker_status', { portal: 'registration-monitoring', worker_id: 41 });
    expect(reg.parts[0]).toContain('NMC registration Active');
    expect(reg.text).not.toContain('12A3456E');
    expect(reg.text).not.toContain('nmc-12A3456E-20261028.png');
    expect(h.hub.apiRequests().every((q) => q.method === 'GET')).toBe(true);
  });

  it('needs something to look up, and names a missing scope', async () => {
    h = await startHarness();
    expect((await h.call('hb_worker_status', { portal: 'dbs-rtw' })).isError).toBe(true);
    await h.close();
    const x = await withScopes({}, (s) => s.startsWith('dbs-rtw:'));
    const r = await x.call('hb_worker_status', { portal: 'dbs-rtw', worker_id: 41 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('dbs-rtw:workers:read');
  });
});

describe('hb_billing_summary', () => {
  it('shows usage and bills for both monitoring portals', async () => {
    h = await startHarness();
    const r = await h.call('hb_billing_summary');
    expect(r.parts[0]).toContain('DBS and right to work: billing per_candidate, free trial until 2026-11-01');
    expect(r.parts[0]).toContain('bill HB-2026-0005 October 2026: 38 workers, 91.20 GBP, Paid');
    expect(r.parts[0]).toContain('Registration monitoring:');
    expect(ops(r)).toEqual(expect.arrayContaining(['dbs-rtw.billing.usage', 'dbs-rtw.billing.bills', 'registration-monitoring.billing.usage', 'registration-monitoring.billing.bills']));
  });

  it('missing scope is listed as skipped', async () => {
    const x = await withScopes({}, (s) => s.startsWith('dbs-rtw:billing'));
    const r = await x.call('hb_billing_summary');
    expect(r.parts[0]).toContain('DBS and right to work usage (the key lacks the scope dbs-rtw:billing:read)');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('dbs-rtw'))).toHaveLength(0);
  });
});

describe('hb_get_report', () => {
  it('returns metadata and download instructions, never file bytes', async () => {
    h = await startHarness();
    const r = await h.call('hb_get_report', { kind: 'practical_certificate', booking_id: 812, check_download: true });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('Practical training attendance certificate: available');
    expect(r.parts[0]).toContain('/api/v2/practical-training/bookings/812/certificate');
    expect(r.parts[0]).toContain('application/pdf');
    expect(r.parts[0]).toContain('13 bytes');
    expect(r.text).not.toContain('JVBERi0xLjQgbW9jaw==');
    expect(r.text).not.toContain('%PDF');
    expect(r.text).not.toContain(MOCK_KEY);
    expect(ops(r)).toEqual(expect.arrayContaining(['practical-training.bookings.show', 'practical-training.bookings.certificate']));
    expect(r.data.download_check.size_bytes).toBeGreaterThan(0);
  });

  it('online training certificate, OH reports list, health data note', async () => {
    h = await startHarness();
    const ot = await h.call('hb_get_report', { kind: 'online_training_certificate', candidate_ref: REF, certificate_type: 'current' });
    expect(ot.parts[0]).toContain(`/online-training/candidates/${REF}/certificate?type=current`);
    const oh = await h.call('hb_get_report', { kind: 'occupational_health_reports' });
    expect(oh.parts[0]).toContain('all_requests: All requests (xlsx), complete');
    expect(oh.parts[0]).toContain('health data');
    const iv = await h.call('hb_get_report', { kind: 'interview_report', booking_id: 812 });
    expect(iv.data.health_data).toBe(true);
    expect(iv.parts[0]).toContain('health data');
    expect((await h.call('hb_get_report', { kind: 'interview_report' })).isError).toBe(true);
  });

  it('missing scope', async () => {
    const x = await withScopes({}, (s) => s.startsWith('clinical-interviews:bookings'));
    const r = await x.call('hb_get_report', { kind: 'interview_report', booking_id: 812 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('clinical-interviews:bookings:read');
  });
});

// ------------------------------------------------------------------------------------------ write tools

const MIN: Record<string, { args: Record<string, unknown>; drop: string }> = {
  hb_book_practical_training: { args: { candidate_ref: REF, event_id: 44, pay_option: 'credits', agency_contact_name: 'A', agency_contact_email: 'a@example.com' }, drop: 'practical-training:bookings:write' },
  hb_setup_sandbox_webhook: { args: { url: 'https://receiver.example.org/h' }, drop: 'account:webhooks:write' },
  hb_book_slot: { args: { portal: 'virtual-bls-training', candidate_ref: REF, course_id: 1, date: '2026-11-10', time: '11:00', pay_option: 'credits', agency_contact_name: 'A', agency_contact_email: 'a@example.com', address: '1 High St', city: 'London', postcode: 'SW1A 1AA' }, drop: 'virtual-bls-training:bookings:write' },
  hb_change_booking: { args: { portal: 'practical-training', booking_id: 812, action: 'cancel' }, drop: 'practical-training:bookings:write' },
  hb_invite_to_practical: { args: { action: 'create', candidate_ref: REF }, drop: 'practical-training:bookings:write' },
  hb_save_candidate: { args: { first_name: 'New', last_name: 'Person', email: 'new.person@example.org' }, drop: 'hub:candidates:write' },
  hb_assign_training: { args: { candidate_ref: REF, course_ids: [14] }, drop: 'online-training:candidates:write' },
  hb_request_references: { args: { candidate_ref: REF, collection_mode: 'candidate_provides' }, drop: 'references:requests:write' },
  hb_request_occupational_health: { args: { candidate_ref: REF, request_type: 'new_starter', clearance_type_id: 3, scope: 'full', imms_method: 'candidate' }, drop: 'occupational-health:requests:write' },
  hb_chase_outstanding: { args: { kind: 'occupational_health_reminder', candidate_ref: REF }, drop: 'occupational-health:candidates:write' },
  hb_verify_worker: { args: { portal: 'registration-monitoring', first_name: 'Jo', last_name: 'Bloggs', email: 'jo@example.org', consent_given: true, regulator: 'nmc', registration_number: '99Z9999Z' }, drop: 'registration-monitoring:workers:write' },
  hb_acknowledge_alerts: { args: { portal: 'dbs-rtw', all_open: true }, drop: 'dbs-rtw:alerts:write' },
  hb_bulk_import_workers: { args: { portal: 'dbs-rtw', file: { filename: 'w.csv', content_text: 'first_name,last_name\nJo,B\n' } }, drop: 'dbs-rtw:imports:write' },
  hb_redeliver_webhooks: { args: { endpoint_id: 12, delivery_ids: [4501] }, drop: 'account:webhooks:write' },
  hb_rotate_webhook_secret: { args: { endpoint_id: 12 }, drop: 'account:webhooks:write' },
};

describe('every write task tool', () => {
  it('is covered by the table', () => {
    expect(Object.keys(MIN).sort()).toEqual([...WRITE_TASK_TOOL_NAMES].sort());
  });

  for (const name of WRITE_TASK_TOOL_NAMES) {
    const { args, drop } = MIN[name]!;

    it(`${name}: hidden and refused while read-only`, async () => {
      h = await startHarness();
      expect((await h.client.listTools()).tools.map((t) => t.name)).not.toContain(name);
      const tool = allTaskTools(h.ctx).find((t) => t.definition.name === name)!;
      const r = await tool.definition.handler({ ...args, confirm: true });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/read-only/);
      expect(writes(h)).toHaveLength(0);
    });

    it(`${name}: a missing scope refuses and names it, sending nothing`, async () => {
      const x = await withScopes(WRITE_ENV, (s) => s === drop);
      const r = await x.call(name, { ...args, confirm: true });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(drop);
      expect(writes(x)).toHaveLength(0);
    });

    it.skipIf(name === 'hb_setup_sandbox_webhook')(`${name}: the first call (no confirm) sends no change and never shows a key`, async () => {
      h = await startHarness(WRITE_ENV);
      const r = await h.call(name, args);
      expect(writes(h)).toHaveLength(0);
      expect(r.text).not.toContain(MOCK_KEY);
      expect(r.text).not.toContain(EXAMPLE_SECRET);
      if (!r.isError && name !== 'hb_invite_to_practical') expect(r.parts[0]).toMatch(/Nothing was sent|PLAN|Preview|nothing sent/i);
    });
  }

  it('live: hidden without live-write permission; plan call sends nothing; confirm executes', async () => {
    h = await startHarness({ HB_ENV: 'live', HB_READ_ONLY: 'false' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of WRITE_TASK_TOOL_NAMES) expect(names).not.toContain(n);
    await h.close();
    h = await startHarness(LIVE_WRITE_ENV);
    const plan = await h.call('hb_save_candidate', MIN.hb_save_candidate!.args);
    expect(plan.parts[0]).toContain('LIVE Hub');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_save_candidate', { ...MIN.hb_save_candidate!.args, confirm: true });
    expect(done.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['hub.candidates.create']);
  });
});

describe('hb_book_slot', () => {
  const VBLS = MIN.hb_book_slot!.args;

  it('call 1 lists courses, then slots, with credits; unknown slots are problems', async () => {
    h = await startHarness(WRITE_ENV);
    const types = await h.call('hb_book_slot', { portal: 'virtual-bls-training', candidate_ref: REF });
    expect(types.parts[0]).toContain('1 Basic Life Support');
    expect(types.data.problems.join(' ')).toContain('course_id is needed');
    const slots = await h.call('hb_book_slot', { portal: 'virtual-bls-training', candidate_ref: REF, course_id: 1 });
    expect(slots.parts[0]).toContain('2026-11-10 11:00');
    expect(slots.parts[0]).toContain('Credits for this virtual BLS');
    const wrong = await h.call('hb_book_slot', { ...VBLS, time: '23:45' });
    expect(wrong.data.problems.join(' ')).toContain('is not a free timeslot');
    expect(writes(h)).toHaveLength(0);
  });

  it('virtual BLS: hold then book with idempotency keys', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_book_slot', { ...VBLS, confirm: true, idempotency_key: 'bk1' });
    expect(r.isError).toBe(false);
    const w = writes(h);
    expect(w.map((q) => q.opId)).toEqual(['virtual-bls-training.timeslots.hold', 'virtual-bls-training.bookings.create']);
    expect(w[0]!.headers['idempotency-key']).toBe('bk1-hold');
    expect(w[1]!.headers['idempotency-key']).toBe('bk1-book');
    expect((w[0]!.json as any)).toEqual({ course_id: 1, date: '2026-11-10', time: '11:00' });
    expect((w[1]!.json as any).hold_hash).toBe('Qm7xT2kLp9VdR4sNw8YbHc3JfAe6ZuGo');
    expect(r.parts.join('\n')).toContain('Booked virtual BLS #77');
  });

  it('a rejected booking releases its own hold', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'virtual-bls-training.bookings.create', { error: 'booking_rejected', message: 'No.' }, 422);
    const r = await h.call('hb_book_slot', { ...VBLS, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('released');
    expect(writes(h).map((q) => q.opId)).toEqual(['virtual-bls-training.timeslots.hold', 'virtual-bls-training.bookings.create', 'virtual-bls-training.timeslots.release']);
  });

  it('clinical interview: hold then book; appraisal needs explicit awareness and books without a hold', async () => {
    h = await startHarness(WRITE_ENV);
    const ci = await h.call('hb_book_slot', { portal: 'clinical-interviews', candidate_ref: REF, interview_type_id: 3, date: '2026-10-12', time: '11:00', pay_option: 'credits', agency_contact_name: 'A', agency_contact_email: 'a@example.com', confirm: true });
    expect(ci.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['clinical-interviews.timeslots.hold', 'clinical-interviews.bookings.create']);
    const ca = { portal: 'clinical-appraisals', candidate_ref: REF, appraisal_type_id: 2, pay_option: 'credits', agency_contact_name: 'A', agency_contact_email: 'a@example.com' };
    const refused = await h.call('hb_book_slot', { ...ca, confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('video_call_awareness');
    const before = writes(h).length;
    const ok = await h.call('hb_book_slot', { ...ca, video_call_awareness: true, photo_id_awareness: true, confirm: true });
    expect(ok.isError).toBe(false);
    expect(writes(h).slice(before).map((q) => q.opId)).toEqual(['clinical-appraisals.bookings.create']);
    expect((writes(h).at(-1)!.json as any).video_call_awareness).toBe(true);
  });
});

describe('hb_change_booking', () => {
  const future = { id: 812, candidate_ref: REF, candidate_name: 'Jane Doe', course: { id: 1, name: 'Manual Handling' }, start_date: FUTURE, booking_status: 'booked', pay_status: 'completed', pay_option: 'credits', cost_pence: 4500, currency: 'GBP' };

  it('cancel: plan shows the rules and window, confirm cancels and reports the refund', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'practical-training.bookings.show', { data: future });
    const plan = await h.call('hb_change_booking', { portal: 'practical-training', booking_id: 812, action: 'cancel' });
    expect(plan.parts[0]).toContain('outside the 48-hour window');
    expect(plan.parts[0]).toContain('48 hours or more away');
    expect(plan.parts[0]).toContain('emails the candidate');
    expect(writes(h)).toHaveLength(0);
    answer(h, 'practical-training.bookings.show', { data: future });
    const done = await h.call('hb_change_booking', { portal: 'practical-training', booking_id: 812, action: 'cancel', confirm: true });
    expect(done.isError).toBe(false);
    expect(done.parts[0]).toContain('refund: credits 95.00 GBP, 1 credit(s)');
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.bookings.cancel']);
  });

  it('reschedule is refused for practical training; allowed for virtual BLS and interviews with a slot check', async () => {
    h = await startHarness(WRITE_ENV);
    const pt = await h.call('hb_change_booking', { portal: 'practical-training', booking_id: 812, action: 'reschedule', date: '2026-11-10', time: '11:00' });
    expect(pt.parts[0]).toContain('no reschedule');
    expect(pt.data.problems.join(' ')).toContain('reschedule is not available');
    const ptc = await h.call('hb_change_booking', { portal: 'practical-training', booking_id: 812, action: 'reschedule', date: '2026-11-10', time: '11:00', confirm: true });
    expect(ptc.isError).toBe(true);
    expect(writes(h)).toHaveLength(0);
    answer(h, 'virtual-bls-training.bookings.show', { data: { id: 77, candidate_name: 'Jo', course: { id: 1, name: 'BLS' }, start_date: FUTURE, booking_status: 'booked', can_reschedule: true, can_cancel: true } });
    const bad = await h.call('hb_change_booking', { portal: 'virtual-bls-training', booking_id: 77, action: 'reschedule', date: '2026-11-10', time: '09:00' });
    expect(bad.data.problems.join(' ')).toContain('is not a free slot');
    answer(h, 'virtual-bls-training.bookings.show', { data: { id: 77, candidate_name: 'Jo', course: { id: 1, name: 'BLS' }, start_date: FUTURE, booking_status: 'booked', can_reschedule: true, can_cancel: true } });
    const ok = await h.call('hb_change_booking', { portal: 'virtual-bls-training', booking_id: 77, action: 'reschedule', date: '2026-11-10', time: '11:00', confirm: true });
    expect(ok.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['virtual-bls-training.bookings.reschedule']);
    expect((writes(h)[0]!.json as any)).toEqual({ date: '2026-11-10', time: '11:00' });
  });

  it('refuses a booking that cannot be changed and a late fee error is explained', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'clinical-interviews.bookings.show', { data: { id: 812, start_date: FUTURE, booking_status: 'cancelled', can_cancel: false } });
    const r = await h.call('hb_change_booking', { portal: 'clinical-interviews', booking_id: 812, action: 'cancel', confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('only booked or rescheduled');
    expect(writes(h)).toHaveLength(0);
  });
});

describe('hb_invite_to_practical', () => {
  it('lists invitations and the account link without one-time links, no confirm needed', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_invite_to_practical', { action: 'list' });
    expect(r.parts[0]).toContain('#17 Jane Doe: waiting');
    expect(r.parts[0]).toContain('Account booking link: https://hub.hbcompliance.co.uk/practical-training/book?sgi=C1048');
    expect(r.text).not.toContain('si=Qm1xT9vK2hZ0aB7nR4cD8eF3gH6jL5pS1tUwYx2z');
    expect(writes(h)).toHaveLength(0);
  });

  it('create: plan says who is emailed, confirm sends once; delete: plan then confirm; a used invitation cannot be withdrawn', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_invite_to_practical', { action: 'create', candidate_ref: REF });
    expect(plan.parts[0]).toContain('An email will be sent to jane.doe@example.com');
    expect(writes(h)).toHaveLength(0);
    const sent = await h.call('hb_invite_to_practical', { action: 'create', candidate_ref: REF, confirm: true });
    expect(sent.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['practical-training.booking-invites.create']);
    answer(h, 'practical-training.booking-invites.show', { data: { id: 17, candidate_name: 'Jane Doe', status: 'used', booking_id: 812, expires_at: '2026-12-23T19:53:24Z' } });
    const used = await h.call('hb_invite_to_practical', { action: 'delete', invite_id: 17, confirm: true });
    expect(used.isError).toBe(true);
    expect(used.text).toContain('already used');
    expect(writes(h)).toHaveLength(1);
    answer(h, 'practical-training.booking-invites.show', { data: { id: 17, candidate_name: 'Jane Doe', status: 'waiting', expires_at: '2026-12-23T19:53:24Z' } });
    answer(h, 'practical-training.booking-invites.show', { data: { id: 17, candidate_name: 'Jane Doe', status: 'waiting', expires_at: '2026-12-23T19:53:24Z' } });
    const plan2 = await h.call('hb_invite_to_practical', { action: 'delete', invite_id: 17 });
    expect(plan2.parts[0]).toContain('Withdraw invitation #17');
    const del = await h.call('hb_invite_to_practical', { action: 'delete', invite_id: 17, confirm: true });
    expect(del.isError).toBe(false);
    expect(writes(h).at(-1)!.opId).toBe('practical-training.booking-invites.delete');
  });
});

describe('hb_save_candidate', () => {
  it('refuses a duplicate without the override, then creates with it', async () => {
    h = await startHarness(WRITE_ENV);
    const dupe = { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com' };
    const plan = await h.call('hb_save_candidate', dupe);
    expect(plan.parts[0]).toContain('Possible duplicate');
    expect(plan.parts[0]).toContain('(same email)');
    expect(plan.parts[0]).toContain('Cannot proceed yet');
    const refused = await h.call('hb_save_candidate', { ...dupe, confirm: true });
    expect(refused.isError).toBe(true);
    expect(writes(h)).toHaveLength(0);
    const ok = await h.call('hb_save_candidate', { ...dupe, allow_duplicate: true, confirm: true });
    expect(ok.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['hub.candidates.create']);
    expect(writes(h)[0]!.headers['idempotency-key']).toBeTruthy();
  });

  it('create with no duplicate mentions the activation email; is_active false does not', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_save_candidate', { first_name: 'New', last_name: 'Person', email: 'new.person@example.org' });
    expect(plan.parts[0]).toContain('activation email');
    expect(plan.data.problems).toEqual([]);
    const quiet = await h.call('hb_save_candidate', { first_name: 'New', last_name: 'Person', email: 'new.person@example.org', is_active: false });
    expect(quiet.parts[0]).toContain('No activation email is sent');
    const missing = await h.call('hb_save_candidate', { first_name: 'Only' });
    expect(missing.data.problems.join(' ')).toContain('last_name is needed');
  });

  it('update shows a field-by-field diff and sends only the changed fields', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_save_candidate', { candidate_ref: REF, phone: '07700 900999', first_name: 'Jane', roles: ['Staff Nurse', 'Theatre Nurse'] });
    expect(plan.parts[0]).toContain('phone: "07700 900123" -> "07700 900999"');
    expect(plan.parts[0]).toContain('roles: ["Staff Nurse"] -> ["Staff Nurse","Theatre Nurse"]');
    expect(plan.parts[0]).toContain('already as asked: first_name');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_save_candidate', { candidate_ref: REF, phone: '07700 900999', first_name: 'Jane', roles: ['Staff Nurse', 'Theatre Nurse'], confirm: true });
    expect(done.isError).toBe(false);
    expect(writes(h)[0]!.json).toEqual({ phone: '07700 900999', roles: ['Staff Nurse', 'Theatre Nurse'] });
    const same = await h.call('hb_save_candidate', { candidate_ref: REF, first_name: 'Jane' });
    expect(same.data.problems).toEqual(['nothing would change.']);
  });
});

describe('hb_assign_training', () => {
  it('adds without removing what the candidate has, and the plan says who is emailed', async () => {
    h = await startHarness(WRITE_ENV);
    const catalogue = { data: [{ id: 12, name: 'Basic Life Support' }, { id: 14, name: 'Fire Safety' }] };
    answer(h, 'online-training.courses.list', catalogue);
    const plan = await h.call('hb_assign_training', { candidate_ref: REF, course_ids: [14], send_email: 'training_reminder' });
    expect(plan.parts[0]).toContain('Add: 14 Fire Safety');
    expect(plan.parts[0]).toContain('Kept as they are: 12 Basic Life Support');
    expect(plan.parts[0]).toContain('Remove: nothing');
    expect(plan.parts[0]).toContain('emailed about the added courses');
    expect(plan.parts[0]).toContain('training_reminder reminder email');
    expect(writes(h)).toHaveLength(0);
    answer(h, 'online-training.courses.list', catalogue);
    const done = await h.call('hb_assign_training', { candidate_ref: REF, course_ids: [14], send_email: 'training_reminder', training_charge: 'client', confirm: true });
    expect(done.isError).toBe(false);
    const w = writes(h);
    expect(w.map((q) => q.opId)).toEqual(['online-training.candidates.courses', 'online-training.candidates.emails']);
    expect((w[0]!.json as any).course_ids.sort()).toEqual([12, 14]);
    expect((w[0]!.json as any).training_charge).toBe('client');
    expect((w[1]!.json as any).email_type).toBe('training_reminder');
  });

  it('removal is explicit, unknown courses and no-change are problems, live plan says a real person is emailed', async () => {
    h = await startHarness(LIVE_WRITE_ENV);
    const unknown = await h.call('hb_assign_training', { candidate_ref: REF, course_ids: [999] });
    expect(unknown.data.problems.join(' ')).toContain('not in the catalogue');
    const same = await h.call('hb_assign_training', { candidate_ref: REF, course_ids: [12] });
    expect(same.data.problems.join(' ')).toContain('already has exactly these courses');
    const rm = await h.call('hb_assign_training', { candidate_ref: REF, course_ids: [12], remove_course_ids: [12] });
    expect(rm.parts[0]).toContain('Remove: 12 Basic Life Support (results and history are kept; no credits are refunded)');
    expect(rm.parts[0]).toContain('a real person on the LIVE Hub');
    expect(writes(h)).toHaveLength(0);
  });
});

describe('hb_request_references', () => {
  const referee = { name: 'Dr Helen Carter', email: 'helen.carter@riverside.example', organisation: 'Riverside Surgery', position: 'Practice Manager' };

  it('plan lists who will be emailed and warns about open duplicates; confirm creates', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_request_references', { candidate_ref: REF, collection_mode: 'client_adds', referees: [referee], references_required: 2, expiry_days: 14 });
    expect(plan.parts[0]).toContain('helen.carter@riverside.example');
    expect(plan.parts[0]).toContain('An email will be sent to');
    expect(plan.parts[0]).toContain('WARNING: 1 request(s) for this candidate are already open');
    expect(plan.parts[0]).toContain('Form: HB Default');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_request_references', { candidate_ref: REF, collection_mode: 'client_adds', referees: [referee], confirm: true });
    expect(done.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['references.requests.create']);
    expect((writes(h)[0]!.json as any).referees[0]).toMatchObject({ referee_name: 'Dr Helen Carter', referee_email: 'helen.carter@riverside.example', referee_organisation: 'Riverside Surgery' });
  });

  it('checks the mode and duplicates; adds one referee to an existing request', async () => {
    h = await startHarness(LIVE_WRITE_ENV);
    const none = await h.call('hb_request_references', { candidate_ref: REF, collection_mode: 'client_adds' });
    expect(none.data.problems.join(' ')).toContain('at least one referee');
    const dup = await h.call('hb_request_references', { candidate_ref: REF, collection_mode: 'client_adds', referees: [referee, referee] });
    expect(dup.data.problems.join(' ')).toContain('same email');
    const cp = await h.call('hb_request_references', { candidate_ref: REF, collection_mode: 'candidate_provides' });
    expect(cp.parts[0]).toContain('a real person on the LIVE Hub');
    const add = await h.call('hb_request_references', { request_uuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', referees: [referee], confirm: true });
    expect(add.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['references.requests.referees.create']);
  });
});

describe('hb_request_occupational_health', () => {
  const ARGS = MIN.hb_request_occupational_health!.args;

  it('validates against the options, shows credits and handles no health answers; confirm creates', async () => {
    h = await startHarness(WRITE_ENV);
    const list = await h.call('hb_request_occupational_health', { candidate_ref: REF });
    expect(list.parts[0]).toContain('3 Exposure Prone Procedures (EPP)');
    expect(list.data.problems.join(' ')).toContain('request_type is needed');
    const paper = await h.call('hb_request_occupational_health', { ...ARGS, hq_method: 'paper' });
    expect(paper.data.problems.join(' ')).toContain('file uploads');
    const plan = await h.call('hb_request_occupational_health', ARGS);
    expect(plan.data.problems).toEqual([]);
    expect(plan.parts[0]).toContain('The request uses credits');
    expect(plan.parts[0]).toContain('No health answers are handled');
    expect(plan.parts[0]).toContain('health questionnaire link');
    const done = await h.call('hb_request_occupational_health', { ...ARGS, confirm: true });
    expect(done.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['occupational-health.requests.create']);
    const sent = writes(h)[0]!.body;
    for (const [k, v] of Object.entries({ candidate_ref: REF, request_type: 'new_starter', clearance_type_id: '3', hq_method: 'online', scope: 'full', imms_method: 'candidate' })) expect(sent).toContain(`name="${k}"\r\n\r\n${v}`);
    expect(sent).not.toContain('paper_hq');
    expect(done.text).not.toContain('Questionnaire');
  });
});

describe('hb_chase_outstanding', () => {
  const REQ = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const pending = { data: { uuid: REQ, candidate_name: 'Amelia Jones', status: 'in_progress', status_label: 'In progress', references_completed: 0, references_required: 2, expires_at: '2026-12-01T00:00:00Z', referees: [{ uuid: 'r1', name: 'Mr David Hughes', email: 'david@northgate.example', status: 'sent', status_label: 'Sent', reminder_count: 1 }] } };

  it('references reminders: plan lists who is contacted; confirm sends; nothing outstanding is a problem', async () => {
    h = await startHarness(WRITE_ENV);
    const none = await h.call('hb_chase_outstanding', { kind: 'references_reminders', request_uuid: REQ });
    expect(none.data.problems.join(' ')).toContain('nobody to remind');
    answer(h, 'references.requests.show', pending);
    const plan = await h.call('hb_chase_outstanding', { kind: 'references_reminders', request_uuid: REQ });
    expect(plan.parts[0]).toContain('Mr David Hughes <david@northgate.example>');
    expect(plan.parts[0]).toContain('An email will be sent to 1 referee(s)');
    expect(writes(h)).toHaveLength(0);
    answer(h, 'references.requests.show', pending);
    const done = await h.call('hb_chase_outstanding', { kind: 'references_reminders', request_uuid: REQ, confirm: true });
    expect(done.isError).toBe(false);
    expect(done.parts[0]).toContain('Reminders sent: 1');
    expect(writes(h).map((q) => q.opId)).toEqual(['references.requests.reminders']);
  });

  it('extend, cancel (final), one referee, occupational health and training emails', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'references.requests.show', pending);
    const ext = await h.call('hb_chase_outstanding', { kind: 'references_extend', request_uuid: REQ, days: 7, confirm: true });
    expect(ext.isError).toBe(false);
    answer(h, 'references.requests.show', pending);
    const cancelPlan = await h.call('hb_chase_outstanding', { kind: 'references_cancel', request_uuid: REQ });
    expect(cancelPlan.parts[0]).toContain('final'.length ? 'CANCEL the request' : '');
    expect(cancelPlan.parts[0]).toContain('Mr David Hughes');
    answer(h, 'references.requests.show', pending);
    const ref1 = await h.call('hb_chase_outstanding', { kind: 'references_referee_reminder', request_uuid: REQ, referee_uuid: 'r1', confirm: true });
    expect(ref1.isError).toBe(false);
    const oh = await h.call('hb_chase_outstanding', { kind: 'occupational_health_reminder', candidate_ref: REF });
    expect(oh.parts[0]).toContain('Remind Jane Doe to complete the health questionnaire');
    const ot = await h.call('hb_chase_outstanding', { kind: 'training_email', candidate_ref: REF, email_type: 'course_completion_reminder', confirm: true });
    expect(ot.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['references.requests.extend', 'references.referees.reminder', 'online-training.candidates.emails']);
  });
});

describe('hb_verify_worker', () => {
  const RTW = { portal: 'dbs-rtw', first_name: 'Jo', last_name: 'Bloggs', email: 'jo.bloggs@example.org', date_of_birth: '1990-05-05', consent_given: true, dbs_certificate_number: '001234567890', dbs_surname: 'Bloggs', rtw_share_code: 'QWE RTY UIO' };

  it('plan shows masked values, billing and data used; consent must be explicit', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_verify_worker', RTW);
    expect(plan.parts[0]).toMatch(/DBS certificate \*+890/);
    expect(plan.parts[0]).toMatch(/share code \*+UIO/);
    expect(plan.parts[0]).toContain('free trial until 2026-11-01');
    expect(plan.parts[0]).toContain('Personal data that will be sent');
    expect(plan.text).not.toContain('001234567890');
    expect(plan.text).not.toContain('QWE RTY UIO');
    expect(writes(h)).toHaveLength(0);
    const noConsent = await h.call('hb_verify_worker', { ...RTW, consent_given: undefined });
    expect(noConsent.data.problems.join(' ')).toContain('consent_given must be true');
  });

  it('create then verify both tracks and read the job; secrets never appear, even in an echoed error', async () => {
    h = await startHarness(WRITE_ENV);
    const done = await h.call('hb_verify_worker', { ...RTW, confirm: true, idempotency_key: 'vw' });
    expect(done.isError).toBe(false);
    const w = writes(h);
    expect(w.map((q) => q.opId)).toEqual(['dbs-rtw.workers.create', 'dbs-rtw.workers.verify', 'dbs-rtw.workers.verify']);
    expect((w[0]!.json as any).dbs_certificate_number).toBe('001234567890');
    expect((w[0]!.json as any).rtw_share_code).toBe('QWE RTY UIO');
    expect(w[0]!.headers['idempotency-key']).toBe('vw-create');
    expect(w.slice(1).map((q) => (q.json as any).track).sort()).toEqual(['dbs', 'rtw']);
    expect(done.text).not.toContain('001234567890');
    expect(done.text).not.toContain('QWE RTY UIO');
    expect(done.parts[0]).toContain('check job');
    answer(h, 'dbs-rtw.workers.create', { error: 'validation_failed', message: 'The share code QWE RTY UIO is not valid.', details: { rtw_share_code: ['QWE RTY UIO bad'] } }, 422);
    const bad = await h.call('hb_verify_worker', { ...RTW, confirm: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain('QWE RTY UIO');
    expect(bad.text).toContain('[redacted]');
  });

  it('registration worker and an existing worker re-check', async () => {
    h = await startHarness(WRITE_ENV);
    const reg = await h.call('hb_verify_worker', { ...MIN.hb_verify_worker!.args, confirm: true });
    expect(reg.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['registration-monitoring.workers.create', 'registration-monitoring.workers.verify']);
    const before = writes(h).length;
    const again = await h.call('hb_verify_worker', { portal: 'dbs-rtw', worker_id: 41, track: 'dbs', confirm: true });
    expect(again.isError).toBe(false);
    expect(writes(h).slice(before).map((q) => `${q.opId}:${(q.json as any)?.track}`)).toEqual(['dbs-rtw.workers.verify:dbs']);
  });
});

describe('hb_acknowledge_alerts', () => {
  it('needs an explicit scope of alerts; lists what is affected; acknowledges one, ids, a type or all', async () => {
    h = await startHarness(WRITE_ENV);
    const vague = await h.call('hb_acknowledge_alerts', { portal: 'dbs-rtw' });
    expect(vague.data.problems.join(' ')).toContain('say which alerts');
    const plan = await h.call('hb_acknowledge_alerts', { portal: 'dbs-rtw', ids: [9] });
    expect(plan.parts[0]).toContain('#9 [high] Registration expired');
    expect(writes(h)).toHaveLength(0);
    const ids = await h.call('hb_acknowledge_alerts', { portal: 'dbs-rtw', ids: [9], confirm: true });
    expect(ids.parts[0]).toContain('Acknowledged 3 alert(s)');
    expect(writes(h)[0]!.json).toEqual({ ids: [9] });
    const one = await h.call('hb_acknowledge_alerts', { portal: 'registration-monitoring', alert_id: 9, confirm: true });
    expect(one.isError).toBe(false);
    const all = await h.call('hb_acknowledge_alerts', { portal: 'registration-monitoring', all_open: true, confirm: true });
    expect(all.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['dbs-rtw.alerts.acknowledge-bulk', 'registration-monitoring.alerts.acknowledge', 'registration-monitoring.alerts.acknowledge-bulk']);
    expect(writes(h).at(-1)!.json).toEqual({});
  });

  it('occupational health dismiss and clear are separate and statuses only', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_acknowledge_alerts', { portal: 'occupational-health', oh_action: 'dismiss', oh_key: 'rejected:4821' });
    expect(plan.parts[0]).toContain('Dismiss rejected:4821');
    expect(plan.text).not.toContain('Jane Doe');
    expect(plan.text).not.toContain('Exposure Prone');
    const unknownKey = await h.call('hb_acknowledge_alerts', { portal: 'occupational-health', oh_action: 'dismiss', oh_key: 'nope:1' });
    expect(unknownKey.data.problems.join(' ')).toContain('no shown alert has the key');
    const dismissed = await h.call('hb_acknowledge_alerts', { portal: 'occupational-health', oh_action: 'dismiss', oh_key: 'rejected:4821', confirm: true });
    expect(dismissed.isError).toBe(false);
    const clear = await h.call('hb_acknowledge_alerts', { portal: 'occupational-health', oh_action: 'clear' });
    expect(clear.parts[0]).toContain('CLEAR all');
    const cleared = await h.call('hb_acknowledge_alerts', { portal: 'occupational-health', oh_action: 'clear', confirm: true });
    expect(cleared.isError).toBe(false);
    expect(writes(h).map((q) => q.opId)).toEqual(['occupational-health.alerts.dismiss', 'occupational-health.alerts.clear']);
  });
});

describe('hb_bulk_import_workers', () => {
  const ARGS = MIN.hb_bulk_import_workers!.args;

  it('call 1 previews and shows counts and errors without sample rows; call 2 imports', async () => {
    h = await startHarness(WRITE_ENV);
    const plan = await h.call('hb_bulk_import_workers', ARGS);
    expect(plan.isError).toBe(false);
    expect(plan.parts[0]).toContain('120 row(s), 118 valid, 2 invalid');
    expect(plan.parts[0]).toContain('line 14: The registration number field is required');
    expect(plan.parts[0]).toContain('nothing imported');
    expect(plan.text).not.toContain('12A3456E');
    expect(h.hub.apiRequests().map((q) => q.opId)).toEqual(expect.arrayContaining(['dbs-rtw.imports.preview']));
    expect(h.hub.apiRequests().some((q) => q.opId === 'dbs-rtw.imports.create')).toBe(false);
    const done = await h.call('hb_bulk_import_workers', { ...ARGS, confirm: true, idempotency_key: 'imp' });
    expect(done.isError).toBe(false);
    expect(done.parts[0]).toContain('118 imported, 2 failed of 120');
    const create = h.hub.apiRequests().find((q) => q.opId === 'dbs-rtw.imports.create')!;
    expect(create.headers['idempotency-key']).toBe('imp-import');
    expect(create.headers['content-type']).toContain('multipart/form-data');
    expect(create.body).toContain('first_name,last_name');
  });

  it('a file with no valid rows is a problem', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'dbs-rtw.imports.preview', { data: { headers: ['a'], total_rows: 3, valid_count: 0, invalid_count: 3, errors: [{ line: 2, message: 'bad' }] } });
    const r = await h.call('hb_bulk_import_workers', { ...ARGS, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no row is valid');
    expect(h.hub.apiRequests().some((q) => q.opId === 'dbs-rtw.imports.create')).toBe(false);
  });
});

describe('hb_redeliver_webhooks', () => {
  const failedList = { data: [{ id: 9, event_type: 'online-training.course.completed', status: 'failed', attempt: 5, response_code: 500, created_at: '2026-10-28T19:00:00Z' }, { id: 8, event_type: 'x.y', status: 'failed', attempt: 5, response_code: null, created_at: '2026-10-28T18:00:00Z' }] };

  it('lists the failed deliveries, then redelivers them on confirm', async () => {
    h = await startHarness(WRITE_ENV);
    answer(h, 'webhooks.deliveries.list', failedList);
    const plan = await h.call('hb_redeliver_webhooks', { endpoint_id: 12 });
    expect(plan.parts[0]).toContain('#9 online-training.course.completed: failed');
    expect(plan.parts[0]).toContain('same event ids');
    expect(writes(h)).toHaveLength(0);
    answer(h, 'webhooks.deliveries.list', failedList);
    const done = await h.call('hb_redeliver_webhooks', { endpoint_id: 12, confirm: true });
    expect(done.isError).toBe(false);
    expect(done.parts[0]).toContain('Queued 2 redelivery(ies): #9, #8');
    expect(writes(h).map((q) => q.path)).toEqual(['/api/v2/webhooks/12/deliveries/9/redeliver', '/api/v2/webhooks/12/deliveries/8/redeliver']);
  });

  it('nothing failed, a switched-off endpoint and unknown delivery ids are problems', async () => {
    h = await startHarness(WRITE_ENV);
    const none = await h.call('hb_redeliver_webhooks', { endpoint_id: 12 });
    expect(none.data.problems.join(' ')).toContain('nothing to redeliver');
    answer(h, 'webhooks.endpoints.show', { id: 12, name: 'Orders', url: 'https://example.com/h', is_active: false, consecutive_failures: 25 });
    answer(h, 'webhooks.deliveries.list', failedList);
    const off = await h.call('hb_redeliver_webhooks', { endpoint_id: 12, confirm: true });
    expect(off.isError).toBe(true);
    expect(off.text).toContain('switched off');
    const unknown = await h.call('hb_redeliver_webhooks', { endpoint_id: 12, delivery_ids: [123456] });
    expect(unknown.data.problems.join(' ')).toContain('123456');
    expect(writes(h)).toHaveLength(0);
  });
});

describe('hb_rotate_webhook_secret', () => {
  it('plan warns receivers will fail; confirm rotates, saves the secret to a new file and never shows it', async () => {
    h = await startHarness(WRITE_ENV);
    const dir = mkdtempSync(join(tmpdir(), 'hb-rot-'));
    const file = join(dir, 'new-secret.txt');
    const plan = await h.call('hb_rotate_webhook_secret', { endpoint_id: 12, save_secret_to: file });
    expect(plan.parts[0]).toContain('will reject deliveries until you give it the new secret');
    expect(plan.parts[0]).toContain('80 minutes');
    expect(plan.parts[0]).toContain(`saved to ${file}`);
    expect(writes(h)).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
    const done = await h.call('hb_rotate_webhook_secret', { endpoint_id: 12, save_secret_to: file, confirm: true });
    expect(done.isError).toBe(false);
    expect(done.text).not.toContain(EXAMPLE_SECRET);
    expect(done.data.signing_secret).toBe('withheld');
    expect(readFileSync(file, 'utf8').trim()).toBe(EXAMPLE_SECRET);
    expect(writes(h).map((q) => q.opId)).toEqual(['webhooks.endpoints.rotate-secret']);
    const again = await h.call('hb_rotate_webhook_secret', { endpoint_id: 12, save_secret_to: file });
    expect(again.data.problems.join(' ')).toContain('already exists');
  });

  it('without save_secret_to the secret is withheld and lost, with a warning; live plan warns about production', async () => {
    h = await startHarness(LIVE_WRITE_ENV);
    const plan = await h.call('hb_rotate_webhook_secret', { endpoint_id: 12 });
    expect(plan.parts[0]).toContain('LIVE Hub: real events to your production receiver will fail');
    expect(plan.parts[0]).toContain('no save_secret_to');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_rotate_webhook_secret', { endpoint_id: 12, confirm: true });
    expect(done.isError).toBe(false);
    expect(done.text).not.toContain(EXAMPLE_SECRET);
    expect(done.parts[0]).toContain('withheld');
    expect(h.logs.join('\n')).not.toContain(EXAMPLE_SECRET);
  });
});

describe('HB_TASK_TOOLS setting', () => {
  it('parses all (default), core and none, and rejects anything else', () => {
    const base = { HB_API_KEY: 'hbk_test_1234567890', HB_BASE_URL: 'https://x.example/sandbox/abc' } as NodeJS.ProcessEnv;
    expect(loadConfig(base).taskTools).toBe('all');
    expect(loadConfig({ ...base, HB_TASK_TOOLS: 'core' }).taskTools).toBe('core');
    expect(loadConfig({ ...base, HB_TASK_TOOLS: 'none' }).taskTools).toBe('none');
    expect(() => loadConfig({ ...base, HB_TASK_TOOLS: 'some' })).toThrow();
  });
});
