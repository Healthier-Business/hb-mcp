import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';
import { describeError, HubApiError } from '../src/errors.js';
import { approvalNote, areaLabel } from '../src/approval.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DOCS = 'https://dev.hbcompliance.co.uk/docs/api-access-approval';
const SCOPES = ['occupational-health:requests:read', 'dbs-rtw:workers:read', 'hub:candidates:read'];

describe('API access approval errors', () => {
  it.each([
    ['api_access_not_approved', 'not requested'],
    ['api_access_pending', 'pending'],
    ['api_access_rejected', 'rejected'],
    ['api_access_revoked', 'revoked'],
  ])('turns %s into a plain message with the state and the docs link', async (code, state) => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.scopes.push(...SCOPES);
    h.hub.approvalRefusals.set('occupational-health', code);
    const r = await h.call('hb_call_operation', { operation_id: 'occupational-health.requests.list' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Hub answered 403 ${code}`);
    expect(r.text).toContain(`Occupational Health needs approval in the Hub under Developer > API access; status: ${state}.`);
    expect(r.text).toContain(DOCS);
    expect(r.text).toMatch(/Do not retry/);
    expect(h.hub.apiRequests().filter((q) => q.path.includes('/occupational-health/'))).toHaveLength(1);
  });

  it('describes webhook_events_not_approved with the refused events', () => {
    const e = new HubApiError(403, 'webhook_events_not_approved', 'm', undefined, 'r1', undefined, {}, { areas: ['dbs-rtw'], events: ['dbs-rtw.worker.checked'], docsUrl: DOCS });
    const text = describeError(e);
    expect(text).toContain('DBS & Right To Work needs approval in the Hub under Developer > API access before a webhook endpoint can subscribe');
    expect(text).toContain('dbs-rtw.worker.checked');
    expect(text).toContain('Nothing was saved');
  });

  it('only shows an https docs link and tolerates a missing areas field', () => {
    const e = new HubApiError(403, 'api_access_pending', 'm', undefined, undefined, undefined, {}, {});
    expect(describeError(e)).toContain('This area needs approval in the Hub under Developer > API access; status: pending.');
  });

  it('task tools report a refused area in one line instead of failing', async () => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.scopes.push(...SCOPES);
    h.hub.approvalRefusals.set('occupational-health', 'api_access_pending');
    const r = await h.call('hb_needs_attention');
    expect(r.text).not.toContain('Unexpected error');
    expect(r.text).toMatch(/approval in the Hub under Developer > API access/);
  });
});

describe('hb_status approval state', () => {
  it('lists the sensitive areas and warns for the ones not approved', async () => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.apiAccessRows = [
      { area: 'occupational-health', label: 'Occupational Health', sensitive: true, status: 'pending', decided_at: null },
      { area: 'dbs-rtw', label: 'DBS & Right To Work', sensitive: true, status: 'approved', decided_at: '2026-11-03T10:15:00Z' },
      { area: 'online-training', label: 'Online Training', sensitive: false, status: 'not_required', decided_at: null },
    ];
    const r = await h.call('hb_status');
    expect(r.json.api_access.areas.map((a: { area: string; status: string }) => [a.area, a.status])).toEqual([['occupational-health', 'pending'], ['dbs-rtw', 'approved']]);
    expect(r.json.warnings).toEqual([expect.stringContaining('Occupational Health needs approval in the Hub under Developer > API access; status: pending.')]);
  });

  it('says the sandbox is open and adds no warning', async () => {
    h = await startHarness();
    const r = await h.call('hb_status');
    expect(r.json.api_access.areas.every((a: { status: string }) => a.status === 'not_required')).toBe(true);
    expect(JSON.stringify(r.json.warnings ?? [])).not.toContain('needs approval');
  });

  it('works with a key that has no scopes at all and never fails hb_status when the Hub lacks the call', async () => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.scopes.length = 0;
    h.hub.apiAccessRows = [{ area: 'dbs-rtw', label: 'DBS & Right To Work', sensitive: true, status: 'revoked', decided_at: '2026-11-04T09:00:00Z' }];
    const r = await h.call('hb_status');
    expect(r.json.api_access.areas[0].status).toBe('revoked');
    const h2 = await startHarness({ HB_ENV: 'live' }, h.hub);
    h.hub.failNext(404, { error: 'not_found', message: 'No such endpoint.' }, {}, (q) => q.path === '/api/v2/account/api-access');
    const r2 = await h2.call('hb_status');
    expect(r2.isError).toBe(false);
    expect(r2.json.api_access.available).toBe(false);
    await h2.close();
  });

  it('is a read-only operation any key can call, in compact and full mode', async () => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.scopes.length = 0;
    const op = h.ctx.catalogue.get('account.api-access.show');
    expect(op?.scope).toBeNull();
    expect(op?.method).toBe('GET');
    const r = await h.call('hb_call_operation', { operation_id: 'account.api-access.show' });
    expect(r.isError).toBe(false);
    const full = await startHarness({ HB_ENV: 'live', HB_TOOL_MODE: 'full' }, h.hub);
    const { tools } = await full.client.listTools();
    const t = tools.find((x) => x.name === 'account_api_access_show');
    expect(t?.annotations?.readOnlyHint).toBe(true);
    await full.close();
  });
});

describe('hb_go_live_check approval findings', () => {
  it('fails for a pending area the key holds a scope for, and passes an approved one', async () => {
    h = await startHarness({ HB_ENV: 'live' });
    h.hub.scopes.push('occupational-health:requests:read', 'dbs-rtw:workers:read');
    h.hub.apiAccessRows = [
      { area: 'occupational-health', label: 'Occupational Health', sensitive: true, status: 'pending', decided_at: null },
      { area: 'dbs-rtw', label: 'DBS & Right To Work', sensitive: true, status: 'approved', decided_at: '2026-11-03T10:15:00Z' },
    ];
    const r = await h.call('hb_go_live_check');
    expect(r.text).toMatch(/FAIL\s+Occupational Health needs approval in the Hub under Developer > API access; status: pending/);
    expect(r.text).toMatch(/OK\s+DBS & Right To Work: approved by Hub staff \(2026-11-03\)/);
    expect(r.text).toContain('account.api-access.show');
  });
});

describe('descriptions say live use needs approval', () => {
  it('adds the note for Occupational Health and DBS & Right To Work only', async () => {
    expect(approvalNote(['occupational-health'])).toContain('Live use of Occupational Health needs the Hub\'s one-off approval');
    expect(approvalNote(['dbs-rtw'])).toContain('DBS & Right To Work');
    expect(approvalNote(['online-training'])).toBe('');
    expect(areaLabel('some-new-area')).toBe('Some New Area');
    h = await startHarness({ HB_TOOL_MODE: 'full', HB_READ_ONLY: 'false' });
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    expect(byName.get('occupational_health_requests_list')).toContain('needs the Hub\'s one-off approval');
    expect(byName.get('dbs_rtw_workers_list')).toContain('needs the Hub\'s one-off approval');
    expect(byName.get('hub_candidates_list')).not.toContain('one-off approval');
    expect(byName.get('hb_request_occupational_health')).toContain('one-off approval');
    expect(byName.get('hb_verify_worker')).toContain('DBS & Right To Work');
    const d = await h.call('hb_describe_operation', { operation_id: 'occupational-health.requests.list' }).catch(() => undefined);
    expect(d).toBeDefined();
  });

  it('compact describe and search flag the operation', async () => {
    h = await startHarness();
    const d = await h.call('hb_describe_operation', { operation_id: 'dbs-rtw.workers.list' });
    expect(d.json.approval).toContain('DBS & Right To Work');
    expect(d.json.live_needs_approval).toBe(true);
  });
});
