import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { allTaskTools } from '../src/tools/tasks.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { MOCK_KEY, MockHub } from './helpers/mock-hub.js';

const REF = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const WRITE_ENV = { HB_READ_ONLY: 'false' };
const LIVE_WRITE_ENV = { HB_ENV: 'live', HB_READ_ONLY: 'false', HB_ALLOW_LIVE_WRITES: 'true' };
const MARKER = 'SECRET-CERT-MARKER-91827';

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
const creates = (x: Harness) => x.hub.apiRequests().filter((r) => r.opId === 'training-verification.verifications.create');
const ops = (r: { data: any }) => r.data.operations_called as string[];

/** A folder with a real-looking certificate. The text marker lets the tests prove contents never leave the server. */
function certificateDir(): { dir: string; pdf: string; bytes: Buffer; base64: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hb-cert-'));
  const bytes = Buffer.from(`%PDF-1.4\n% ${MARKER}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
  const pdf = join(dir, 'jo-smith-certificate.pdf');
  writeFileSync(pdf, bytes);
  return { dir, pdf, bytes, base64: bytes.toString('base64') };
}

const person = { candidate_name: 'Jo Smith', candidate_email: 'jo.smith@example.com', agency_name_on_cert: 'Healthy Staffing Ltd' };

function noContents(texts: string[], c: { base64: string }): void {
  const all = texts.join('\n');
  expect(all).not.toContain(c.base64);
  expect(all).not.toContain(c.base64.slice(0, 24));
  expect(all).not.toContain(MARKER);
  expect(all).not.toContain(MOCK_KEY);
}

// -------------------------------------------------------------------------------- tool counts per mode

describe('tool counts', () => {
  const count = async (env: Record<string, string>) => {
    const x = await startHarness(env);
    const n = (await x.client.listTools()).tools.length;
    await x.close();
    return n;
  };
  it('compact: all, core and none, read-only and with writes', async () => {
    expect(await count({})).toBe(8 + 14);
    expect(await count(WRITE_ENV)).toBe(8 + 30);
    expect(await count({ HB_TASK_TOOLS: 'core' })).toBe(8 + 9);
    expect(await count({ ...WRITE_ENV, HB_TASK_TOOLS: 'core' })).toBe(8 + 11);
    expect(await count({ HB_TASK_TOOLS: 'none' })).toBe(8);
    expect(await count({ ...WRITE_ENV, HB_TASK_TOOLS: 'none' })).toBe(8);
  });
  it('compact with writes stays under the 40 tool guidance', async () => {
    expect(await count(WRITE_ENV)).toBeLessThan(40);
  });
  it('full: all, core and none, read-only and with writes', async () => {
    const full = { HB_TOOL_MODE: 'full' };
    expect(await count(full)).toBe(131 + 5 + 14);
    expect(await count({ ...full, ...WRITE_ENV })).toBe(197 + 5 + 30);
    expect(await count({ ...full, HB_TASK_TOOLS: 'core' })).toBe(131 + 5 + 9);
    expect(await count({ ...full, ...WRITE_ENV, HB_TASK_TOOLS: 'core' })).toBe(197 + 5 + 11);
    expect(await count({ ...full, HB_TASK_TOOLS: 'none' })).toBe(131 + 5);
    expect(await count({ ...full, ...WRITE_ENV, HB_TASK_TOOLS: 'none' })).toBe(197 + 5);
  });
  it('hb_verification_status is in core; hb_verify_certificate is not', async () => {
    h = await startHarness({ ...WRITE_ENV, HB_TASK_TOOLS: 'core' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('hb_verification_status');
    expect(names).not.toContain('hb_verify_certificate');
  });
  it('the training-verification toolset can be switched off: both tools disappear', async () => {
    h = await startHarness({ ...WRITE_ENV, HB_TOOLSETS: 'hub,account' });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('hb_verification_status');
    expect(names).not.toContain('hb_verify_certificate');
  });
});

describe('HB_UPLOAD_DIRS setting', () => {
  const base = { HB_API_KEY: 'hbk_test_x1234567890' };
  it('defaults to the working directory only', () => {
    expect(loadConfig(base).uploadDirs).toEqual([process.cwd()]);
    expect(loadConfig({ ...base, HB_UPLOAD_DIRS: '' }).uploadDirs).toEqual([process.cwd()]);
  });
  it('takes a comma list of absolute folders and refuses anything else', () => {
    expect(loadConfig({ ...base, HB_UPLOAD_DIRS: '/srv/certs, /srv/more/' }).uploadDirs).toEqual(['/srv/certs', '/srv/more']);
    expect(() => loadConfig({ ...base, HB_UPLOAD_DIRS: 'certs' })).toThrow(/absolute/);
    expect(() => loadConfig({ ...base, HB_UPLOAD_DIRS: '/srv/ok,../up' })).toThrow(/absolute/);
  });
});

// ------------------------------------------------------------------------------- hb_verify_certificate

describe('hb_verify_certificate: the two-step flow', () => {
  it('call 1 checks the file and shows the plan but sends no write and no file; call 2 uploads it with a derived key', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, notify_email: 'hr@example.com', client_reference: 'PLACEMENT-1' });
    expect(plan.isError).toBe(false);
    expect(writes(h)).toHaveLength(0);
    expect(creates(h)).toHaveLength(0);
    const sha = createHash('sha256').update(c.bytes).digest('hex');
    expect(plan.parts[0]).toContain('jo-smith-certificate.pdf');
    expect(plan.parts[0]).toContain(sha);
    expect(plan.parts[0]).toContain('application/pdf');
    expect(plan.parts[0]).toMatch(/\d+ KB/);
    expect(plan.parts[0]).toContain('FREE');
    expect(plan.parts[0]).toContain('hr@example.com');
    expect(plan.parts[0]).toContain('money balance 48.00 GBP');
    expect(plan.parts[0]).toContain('Nothing was sent');
    expect(plan.data.stage).toBe('plan');
    expect(plan.data.file.sha256).toBe(sha);
    expect(ops(plan)).toEqual(expect.arrayContaining(['training-verification.profile.show', 'training-verification.pricing.show', 'training-verification.credits.show']));
    expect(ops(plan)).not.toContain('training-verification.verifications.create');
    const key = plan.data.idempotency_key as string;

    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, notify_email: 'hr@example.com', client_reference: 'PLACEMENT-1', file_sha256: sha, confirm: true, idempotency_key: key });
    expect(sent.isError).toBe(false);
    const post = creates(h);
    expect(post).toHaveLength(1);
    expect(post[0]!.headers['idempotency-key']).toBe(`${key}-submit`);
    expect(String(post[0]!.headers['content-type'])).toContain('multipart/form-data');
    expect(post[0]!.form!.files.certificate).toMatchObject({ filename: 'jo-smith-certificate.pdf', contentType: 'application/pdf', size: c.bytes.length, sha256: sha });
    expect(post[0]!.form!.fields).toMatchObject({ request_type: 'auto', candidate_name: 'Jo Smith', candidate_email: 'jo.smith@example.com', agency_name_on_cert: 'Healthy Staffing Ltd', notify_email: 'hr@example.com', client_reference: 'PLACEMENT-1' });
    expect(sent.parts[0]).toContain('Accepted (202)');
    expect(sent.parts[0]).toContain('is pending');
    expect(sent.parts[0]).toContain('Charge: free');
    expect(sent.parts[0]).toContain('hb_verification_status');
    expect(sent.data.executed).toBe(true);
    expect(sent.data.verification.status).toBe('pending');
    expect(ops(sent)).toContain('training-verification.verifications.create');
    expect(h.hub.tvVerifications).toHaveLength(1);
    noContents([plan.text, sent.text, ...h.logs], c);
  });

  it('repeating the confirmed call with the same key replays and never creates or charges twice', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.clientType = 'verification_only';
    h.hub.tv.autoCredits = 0;
    const args = { certificate_path: c.pdf, ...person, confirm: true, idempotency_key: 'fixed-key-1' };
    const first = await h.call('hb_verify_certificate', args);
    const money = h.hub.tv.moneyPence;
    const again = await h.call('hb_verify_certificate', args);
    expect(first.isError).toBe(false);
    expect(again.isError).toBe(false);
    expect(again.parts[0]).toContain('already accepted');
    expect(again.data.idempotent_replayed).toBe(true);
    expect(creates(h).map((q) => q.headers['idempotency-key'])).toEqual(['fixed-key-1-submit', 'fixed-key-1-submit']);
    expect(h.hub.tvVerifications).toHaveLength(1);
    expect(h.hub.tv.moneyPence).toBe(money);
  });

  it('the same key with a different file is a conflict, not a second verification', async () => {
    const c = certificateDir();
    const other = join(c.dir, 'other.pdf');
    writeFileSync(other, Buffer.from('%PDF-1.4\n% another file\n'));
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true, idempotency_key: 'k2' });
    const r = await h.call('hb_verify_certificate', { certificate_path: other, ...person, confirm: true, idempotency_key: 'k2' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('idempotency_conflict');
    expect(h.hub.tvVerifications).toHaveLength(1);
  });

  it('refuses the confirming call when the file changed since the plan', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    writeFileSync(c.pdf, Buffer.from('%PDF-1.4\n% replaced after the plan\n'));
    const r = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true, file_sha256: plan.data.file.sha256, idempotency_key: plan.data.idempotency_key });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('file changed since the plan');
    expect(creates(h)).toHaveLength(0);
  });

  it('works from the working directory by default', async () => {
    h = await startHarness(WRITE_ENV);
    const r = await h.call('hb_verify_certificate', { certificate_path: join(process.cwd(), 'test/fixtures/sample-certificate.pdf'), ...person });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain('sample-certificate.pdf');
  });
});

describe('hb_verify_certificate: price, balance and the 402', () => {
  it('Auto is free for a regular account, even with an empty wallet', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.moneyPence = 0;
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(plan.parts[0]).toContain('FREE');
    expect(plan.parts[0]).not.toContain('WARNING');
    expect(plan.data.price.free).toBe(true);
    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(sent.isError).toBe(false);
    expect(sent.parts[0]).toContain('Charge: free');
  });

  it('Manual is charged on a regular account and the plan shows the price with VAT', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, request_type: 'manual' });
    expect(plan.parts[0]).toContain('12.00 GBP including VAT');
    expect(plan.parts[0]).toContain('never a card');
    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, request_type: 'manual', confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(sent.parts[0]).toContain('12.00 GBP from balance');
    expect(h.hub.tv.moneyPence).toBe(4800 - 1200);
  });

  it('Auto is charged on a verification-only account', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.clientType = 'verification_only';
    h.hub.tv.autoCredits = 2;
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(plan.parts[0]).toContain('6.00 GBP including VAT');
    expect(plan.parts[0]).toContain('2 automated credit(s)');
    expect(plan.parts[0]).toContain('verification-only');
    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(sent.parts[0]).toContain('1 credit(s) from credit');
    expect(h.hub.tv.autoCredits).toBe(1);
  });

  it('a charge the wallet cannot pay is warned about in the plan and refused by the Hub with a clear 402; nothing is stored', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.moneyPence = 300;
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, request_type: 'manual' });
    expect(plan.parts[0]).toContain('WARNING: the credits and balances look too small');
    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, request_type: 'manual', confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('insufficient_credits');
    expect(sent.text).toContain('Nothing was stored or charged');
    expect(sent.text).toContain('no card');
    expect(sent.data.executed).toBe(false);
    expect(h.hub.tvVerifications).toHaveLength(0);
    expect(h.hub.tv.moneyPence).toBe(300);
    noContents([plan.text, sent.text, ...h.logs], c);
  });

  it('asks for notify_email when the account has no default address', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.defaultNotifyEmail = null;
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(plan.data.problems[0]).toContain('notify_email');
    const refused = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true });
    expect(refused.isError).toBe(true);
    expect(creates(h)).toHaveLength(0);
  });

  it('a 403 portal_unavailable says the account does not use the portal and sends nothing', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.failNext(403, { error: 'portal_unavailable', message: 'No account.', request_id: 'r1' }, {}, (q) => q.opId === 'training-verification.profile.show');
    const r = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(r.parts[0]).toContain('does not use Training Verification');
    expect(creates(h)).toHaveLength(0);
  });

  it('a Hub 422 on the upload is reported without echoing the file, even if the Hub echoed it back', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.failNext(422, { error: 'validation_failed', message: `The certificate ${c.base64} is invalid.`, details: { certificate: [`bad ${c.base64}`] }, request_id: 'r2' }, {}, (q) => q.opId === 'training-verification.verifications.create');
    const r = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('validation_failed');
    noContents([r.text, ...h.logs], c);
  });
});

describe('hb_verify_certificate: gates', () => {
  it('is hidden and refused while read-only, sending nothing', async () => {
    const c = certificateDir();
    h = await startHarness({ HB_UPLOAD_DIRS: c.dir });
    expect((await h.client.listTools()).tools.map((t) => t.name)).not.toContain('hb_verify_certificate');
    const tool = allTaskTools(h.ctx).find((t) => t.definition.name === 'hb_verify_certificate')!;
    const r = await tool.definition.handler({ certificate_path: c.pdf, ...person, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/read-only/);
    expect(h.hub.apiRequests().filter((q) => q.path.includes('training-verification'))).toHaveLength(0);
  });

  it('a key with only the read scope is refused and the scope is named', async () => {
    const c = certificateDir();
    const x = await withScopes({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir }, (s) => s === 'training-verification:write');
    const r = await x.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('training-verification:write');
    expect(writes(x)).toHaveLength(0);
  });

  it('a key with only the write scope works (write grants read)', async () => {
    const c = certificateDir();
    const x = await withScopes({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir }, (s) => s === 'training-verification:read');
    const r = await x.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true });
    expect(r.isError).toBe(false);
    expect(creates(x)).toHaveLength(1);
  });

  it('live without live-write permission: hidden and refused', async () => {
    const c = certificateDir();
    h = await startHarness({ HB_ENV: 'live', HB_READ_ONLY: 'false', HB_UPLOAD_DIRS: c.dir });
    expect((await h.client.listTools()).tools.map((t) => t.name)).not.toContain('hb_verify_certificate');
    const tool = allTaskTools(h.ctx).find((t) => t.definition.name === 'hb_verify_certificate')!;
    const r = await tool.definition.handler({ certificate_path: c.pdf, ...person, confirm: true });
    expect(r.isError).toBe(true);
    expect(creates(h)).toHaveLength(0);
  });

  it('live with live writes: the plan says LIVE and a real email, sends nothing; confirm uploads', async () => {
    const c = certificateDir();
    h = await startHarness({ ...LIVE_WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(plan.parts[0]).toContain('LIVE Hub');
    expect(plan.parts[0]).toContain('WILL be sent to verifications@example.com');
    expect(writes(h)).toHaveLength(0);
    const sent = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person, confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(sent.isError).toBe(false);
    expect(creates(h)).toHaveLength(1);
  });
});

describe('hb_verify_certificate: path safety', () => {
  const refused = async (env: Record<string, string>, args: Record<string, unknown>, expected: RegExp) => {
    h = await startHarness({ ...WRITE_ENV, ...env });
    const plan = await h.call('hb_verify_certificate', { ...person, ...args });
    expect(plan.parts[0]).toMatch(expected);
    expect(plan.data.problems.length).toBeGreaterThan(0);
    const confirmed = await h.call('hb_verify_certificate', { ...person, ...args, confirm: true });
    expect(confirmed.isError).toBe(true);
    expect(creates(h)).toHaveLength(0);
    expect(writes(h)).toHaveLength(0);
    expect(plan.text + confirmed.text).not.toContain(MARKER);
    await h.close();
    h = undefined;
  };

  it('refuses a file outside the allowed folders', async () => {
    const c = certificateDir();
    const elsewhere = certificateDir();
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: elsewhere.pdf }, /outside the directories/);
  });

  it('refuses a symbolic link that escapes the allowed folder', async () => {
    const c = certificateDir();
    const elsewhere = certificateDir();
    const link = join(c.dir, 'looks-fine.pdf');
    symlinkSync(elsewhere.pdf, link);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: link }, /resolves \(through a symbolic link\) to a place outside/);
  });

  it('refuses a symbolic link to a folder that escapes', async () => {
    const c = certificateDir();
    const elsewhere = certificateDir();
    const link = join(c.dir, 'folder');
    symlinkSync(elsewhere.dir, link);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(link, 'jo-smith-certificate.pdf') }, /outside/);
  });

  it('accepts a symbolic link that stays inside the allowed folder', async () => {
    const c = certificateDir();
    const link = join(c.dir, 'alias.pdf');
    symlinkSync(c.pdf, link);
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    const r = await h.call('hb_verify_certificate', { certificate_path: link, ...person });
    expect(r.isError).toBe(false);
    expect(r.data.problems).toEqual([]);
  });

  it('refuses hidden files and files in hidden folders', async () => {
    const c = certificateDir();
    writeFileSync(join(c.dir, '.hidden-cert.pdf'), c.bytes);
    mkdirSync(join(c.dir, '.private'));
    writeFileSync(join(c.dir, '.private', 'cert.pdf'), c.bytes);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, '.hidden-cert.pdf') }, /hidden/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, '.private', 'cert.pdf') }, /hidden/);
  });

  it('refuses a link whose target is hidden', async () => {
    const c = certificateDir();
    writeFileSync(join(c.dir, '.real.pdf'), c.bytes);
    symlinkSync(join(c.dir, '.real.pdf'), join(c.dir, 'plain.pdf'));
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'plain.pdf') }, /hidden/);
  });

  it('refuses other file types, by name and by what a link points at', async () => {
    const c = certificateDir();
    writeFileSync(join(c.dir, 'notes.txt'), 'plain text');
    writeFileSync(join(c.dir, 'archive.zip'), 'PK');
    symlinkSync(join(c.dir, 'notes.txt'), join(c.dir, 'disguised.pdf'));
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'notes.txt') }, /not accepted/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'archive.zip') }, /not accepted/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'disguised.pdf') }, /not accepted/);
  });

  it('refuses a file whose content does not match its extension', async () => {
    const c = certificateDir();
    writeFileSync(join(c.dir, 'fake.pdf'), 'this is not a pdf');
    writeFileSync(join(c.dir, 'fake.png'), c.bytes);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'fake.pdf') }, /does not look like a real \.pdf/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'fake.png') }, /does not look like a real \.png/);
  });

  it('refuses a file over the size limit given by the profile, and an empty file', async () => {
    const c = certificateDir();
    writeFileSync(join(c.dir, 'big.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024, 65)]));
    writeFileSync(join(c.dir, 'empty.pdf'), '');
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.maxCertificateKb = 2;
    const plan = await h.call('hb_verify_certificate', { certificate_path: join(c.dir, 'big.pdf'), ...person });
    expect(plan.parts[0]).toMatch(/over the limit of 2 KB/);
    const empty = await h.call('hb_verify_certificate', { certificate_path: join(c.dir, 'empty.pdf'), ...person });
    expect(empty.parts[0]).toMatch(/empty/);
    const confirmed = await h.call('hb_verify_certificate', { certificate_path: join(c.dir, 'big.pdf'), ...person, confirm: true });
    expect(confirmed.isError).toBe(true);
    expect(creates(h)).toHaveLength(0);
  });

  it('uses the types the profile lists', async () => {
    const c = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: c.dir });
    h.hub.tv.certificateTypes = ['png'];
    const plan = await h.call('hb_verify_certificate', { certificate_path: c.pdf, ...person });
    expect(plan.parts[0]).toMatch(/not accepted\. The API accepts: \.png/);
  });

  it('refuses a missing file, a folder, a relative path, wildcards, ".." and a null byte', async () => {
    const c = certificateDir();
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, 'missing.pdf') }, /does not exist/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: c.dir }, /not accepted|not a regular file/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: 'jo-smith-certificate.pdf' }, /absolute path/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, '*.pdf') }, /wildcards/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(c.dir, '?.pdf') }, /wildcards/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: `${c.dir}/sub/../jo-smith-certificate.pdf` }, /"\.\."/);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: `${c.pdf}\0.png` }, /not valid/);
  });

  it('a folder that looks like an allowed folder by prefix is not allowed', async () => {
    const c = certificateDir();
    const sibling = `${c.dir}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'c.pdf'), c.bytes);
    await refused({ HB_UPLOAD_DIRS: c.dir }, { certificate_path: join(sibling, 'c.pdf') }, /outside the directories/);
  });

  it('with HB_UPLOAD_DIRS unset only the working directory is allowed', async () => {
    const c = certificateDir();
    await refused({}, { certificate_path: c.pdf }, /outside the directories/);
  });

  it('several folders can be allowed', async () => {
    const a = certificateDir();
    const b = certificateDir();
    h = await startHarness({ ...WRITE_ENV, HB_UPLOAD_DIRS: `${a.dir},${b.dir}` });
    expect((await h.call('hb_verify_certificate', { certificate_path: a.pdf, ...person })).data.problems).toEqual([]);
    expect((await h.call('hb_verify_certificate', { certificate_path: b.pdf, ...person })).data.problems).toEqual([]);
  });

  it('the schema and description document the setting and never offer a way to pass contents', async () => {
    h = await startHarness(WRITE_ENV);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'hb_verify_certificate')!;
    expect(tool.description).toContain('HB_UPLOAD_DIRS');
    expect(Object.keys((tool.inputSchema as any).properties)).not.toEqual(expect.arrayContaining(['certificate_base64']));
    expect(h.client.getInstructions()).toContain('HB_UPLOAD_DIRS');
  });
});

// ----------------------------------------------------------------------------------- hb_verification_status

describe('hb_verification_status', () => {
  it('lists newest first with filters, without email addresses or the certificate', async () => {
    h = await startHarness();
    h.hub.seedVerification({ status: 'verified', client_reference: 'A-1', candidate_ref: REF, completed_at: '2026-10-28T19:58:02Z' });
    h.hub.seedVerification({ status: 'not_found', request_type: 'manual', reason: { code: 'candidate_not_found', message: 'm' } });
    h.hub.seedVerification({ status: 'pending' });
    const all = await h.call('hb_verification_status');
    expect(all.isError).toBe(false);
    expect(all.parts[0]).toContain('3 verification(s)');
    expect(all.data.verifications.map((v: any) => v.status)).toEqual(['pending', 'not_found', 'verified']);
    expect(all.text).not.toContain('jo.smith@example.com');
    expect(all.text).not.toContain('hr@example.com');
    expect(ops(all)).toEqual(['auth.me.show', 'training-verification.verifications.list']);
    const failed = await h.call('hb_verification_status', { status: 'not_found', request_type: 'manual' });
    expect(failed.data.count).toBe(1);
    expect(failed.parts[0]).toContain('reason candidate_not_found');
    const q = h.hub.apiRequests().filter((r) => r.opId === 'training-verification.verifications.list').pop()!;
    expect(q.query.get('status')).toBe('not_found');
    expect(q.query.get('request_type')).toBe('manual');
    const byRef = await h.call('hb_verification_status', { candidate_ref: REF });
    expect(byRef.data.verifications.map((v: any) => v.client_reference)).toEqual(['A-1']);
    const byClient = await h.call('hb_verification_status', { client_reference: 'A-1', created_from: '2026-10-01', created_to: '2026-10-31' });
    expect(byClient.data.count).toBe(1);
    const last = h.hub.apiRequests().filter((r) => r.opId === 'training-verification.verifications.list').pop()!;
    expect(last.query.get('created_from')).toBe('2026-10-01');
    expect(last.query.get('client_reference')).toBe('A-1');
  });

  it('shows one verification with result records, reason, charge, timeline and file availability (metadata only)', async () => {
    h = await startHarness();
    const v = h.hub.seedVerification({ status: 'verified', completed_at: '2026-10-28T19:58:02Z', charge: { free: false, funding: 'balance', amount_pence: 1200, credits_used: 0, currency: 'GBP', refunded: false } });
    v.events.push({ id: 2, event: 'processing_started', occurred_at: '2026-10-28T19:54:01Z', reason_code: null, amount_pence: null }, { id: 3, event: 'verified', occurred_at: '2026-10-28T19:58:02Z', reason_code: null, amount_pence: null });
    const r = await h.call('hb_verification_status', { verification_id: v.id });
    expect(r.isError).toBe(false);
    expect(r.parts[0]).toContain(`Verification #${v.id}: verified`);
    expect(r.parts[0]).toContain('Fire Safety: completed 2026-02-01, expires 2027-02-01');
    expect(r.parts[0]).toContain('12.00 GBP from balance');
    expect(r.parts[0]).toContain('Timeline:');
    expect(r.parts[0]).toContain('processing_started');
    expect(r.parts[0]).toContain('Certificate file: available. Report: available (PDF)');
    expect(r.data.report_available).toBe(true);
    expect(r.data.certificate_available).toBe(true);
    expect(r.data.verification.result.records).toHaveLength(1);
    expect(r.text).not.toContain('jo.smith@example.com');
    expect(ops(r)).toEqual(expect.arrayContaining(['training-verification.verifications.show', 'training-verification.verifications.events']));
    expect(ops(r)).not.toContain('training-verification.verifications.certificate');
    expect(ops(r)).not.toContain('training-verification.verifications.report');
    expect(r.text).not.toContain('content_base64');
  });

  it('shows the reason for a verification that was not verified, and says a pending one can be cancelled', async () => {
    h = await startHarness();
    const nf = h.hub.seedVerification({ status: 'not_found', reason: { code: 'agency_not_found', message: 'The agency could not be matched.' } });
    const r = await h.call('hb_verification_status', { verification_id: nf.id });
    expect(r.parts[0]).toContain('Reason: agency_not_found - The agency could not be matched.');
    expect(r.parts[0]).toContain('Report: not available');
    expect(r.data.report_available).toBe(false);
    const p = h.hub.seedVerification({ status: 'pending' });
    expect((await h.call('hb_verification_status', { verification_id: p.id })).parts[0]).toContain('can be cancelled');
  });

  it('reports an unknown verification and a missing scope', async () => {
    h = await startHarness();
    h.hub.seedVerification();
    const r = await h.call('hb_verification_status', { verification_id: 999999 });
    expect(r.isError).toBe(true);
    const x = await withScopes({}, (s) => s.startsWith('training-verification:'));
    const denied = await x.call('hb_verification_status');
    expect(denied.isError).toBe(true);
    expect(denied.parts[0]).toContain('training-verification:read');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('training-verification'))).toHaveLength(0);
  });

  it('works with the read scope alone and is available in read-only mode', async () => {
    const x = await withScopes({}, (s) => s === 'training-verification:write');
    expect((await x.client.listTools()).tools.map((t) => t.name)).toContain('hb_verification_status');
    expect((await x.call('hb_verification_status')).isError).toBe(false);
  });
});

// ------------------------------------------------------------------------ hb_change_booking (verifications)

describe('hb_change_booking: cancelling a verification', () => {
  const cancelArgs = (id: number) => ({ portal: 'training-verification', booking_id: id, action: 'cancel' });

  it('plan shows the refund effect and sends nothing; confirm cancels a pending charged verification and refunds it', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.tv.moneyPence = 3600;
    const v = h.hub.seedVerification({ status: 'pending', request_type: 'manual', charge: { free: false, funding: 'balance', amount_pence: 1200, credits_used: 0, currency: 'GBP', refunded: false } });
    const plan = await h.call('hb_change_booking', cancelArgs(v.id));
    expect(plan.isError).toBe(false);
    expect(plan.parts[0]).toContain(`Verification #${v.id}`);
    expect(plan.parts[0]).toContain('charged 12.00 GBP');
    expect(plan.parts[0]).toContain('cancelling refunds it to where it came from');
    expect(plan.parts[0]).toContain('pending');
    expect(plan.parts[0]).toContain('No email is sent');
    expect(writes(h)).toHaveLength(0);
    const done = await h.call('hb_change_booking', { ...cancelArgs(v.id), confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(done.isError).toBe(false);
    expect(done.parts[0]).toContain(`Cancelled verification #${v.id}: status rejected (cancelled_by_client); refunded (12.00 GBP)`);
    expect(writes(h).map((q) => q.opId)).toEqual(['training-verification.verifications.cancel']);
    expect(h.hub.tv.moneyPence).toBe(4800);
  });

  it('a free verification has nothing to refund', async () => {
    h = await startHarness(WRITE_ENV);
    const v = h.hub.seedVerification({ status: 'pending' });
    const plan = await h.call('hb_change_booking', cancelArgs(v.id));
    expect(plan.parts[0]).toContain('It was free: there is nothing to refund.');
    const done = await h.call('hb_change_booking', { ...cancelArgs(v.id), confirm: true });
    expect(done.parts[0]).toContain('free, nothing to refund');
  });

  it('only while pending: a processing or verified verification cannot be cancelled and nothing is sent', async () => {
    h = await startHarness(WRITE_ENV);
    for (const status of ['processing', 'verified', 'not_found']) {
      const v = h.hub.seedVerification({ status });
      const plan = await h.call('hb_change_booking', cancelArgs(v.id));
      expect(plan.data.problems[0]).toContain(`is ${status}; only a pending verification can be cancelled`);
      const refused = await h.call('hb_change_booking', { ...cancelArgs(v.id), confirm: true });
      expect(refused.isError).toBe(true);
    }
    expect(writes(h)).toHaveLength(0);
  });

  it('a verification that started after the plan is reported from the Hub 409', async () => {
    h = await startHarness(WRITE_ENV);
    const v = h.hub.seedVerification({ status: 'pending' });
    const plan = await h.call('hb_change_booking', cancelArgs(v.id));
    h.hub.failNext(409, { error: 'not_cancellable', message: 'Only a pending verification can be cancelled.', request_id: 'r9' }, {}, (q) => q.opId === 'training-verification.verifications.cancel');
    const r = await h.call('hb_change_booking', { ...cancelArgs(v.id), confirm: true, idempotency_key: plan.data.idempotency_key });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not_cancellable');
    expect(r.text).toContain('Only a pending verification can be cancelled');
  });

  it('a verification cannot be rescheduled', async () => {
    h = await startHarness(WRITE_ENV);
    const v = h.hub.seedVerification({ status: 'pending' });
    const plan = await h.call('hb_change_booking', { portal: 'training-verification', booking_id: v.id, action: 'reschedule', date: '2026-11-01', time: '10:00' });
    expect(plan.parts[0]).toContain('cannot be rescheduled');
    expect(plan.data.problems.length).toBeGreaterThan(0);
    expect(writes(h)).toHaveLength(0);
  });

  it('needs the write scope, is refused read-only and keeps the other portals working', async () => {
    const x = await withScopes(WRITE_ENV, (s) => s === 'training-verification:write');
    const v = x.hub.seedVerification({ status: 'pending' });
    const r = await x.call('hb_change_booking', { ...cancelArgs(v.id), confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('training-verification:write');
    expect(writes(x)).toHaveLength(0);
    const tool = (await x.client.listTools()).tools.find((t) => t.name === 'hb_change_booking')!;
    expect(JSON.stringify(tool.inputSchema)).toContain('training-verification');
    const old = await x.call('hb_change_booking', { portal: 'practical-training', booking_id: 812, action: 'cancel' });
    expect(old.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------- the extended read tools

describe('extended task tools', () => {
  it('hb_credits shows the training verification balances and ledger', async () => {
    h = await startHarness();
    h.hub.tv.manualCredits = 2;
    const r = await h.call('hb_credits');
    expect(r.parts[0]).toContain('Training verification: money balance 48.00 GBP');
    expect(r.parts[0]).toContain('2 manual verification credit(s)');
    expect(r.parts[0]).toMatch(/Training verification:[\s\S]*2026-10-28 debit -12\.00 GBP: Certificate verification charge/);
    expect(ops(r)).toEqual(expect.arrayContaining(['training-verification.credits.show', 'training-verification.credits.transactions']));
    const tx = h.hub.apiRequests().find((q) => q.opId === 'training-verification.credits.transactions')!;
    expect(tx.query.get('sort')).toBeNull();
  });

  it('hb_credits skips training verification without its scope and says so', async () => {
    const x = await withScopes({}, (s) => s.startsWith('training-verification:'));
    const r = await x.call('hb_credits');
    expect(r.parts[0]).toContain('Training verification credits (the key lacks the scope training-verification:read)');
    expect(x.hub.apiRequests().filter((q) => q.path.includes('training-verification'))).toHaveLength(0);
  });

  it('hb_account_summary includes the training verification balance', async () => {
    h = await startHarness();
    const r = await h.call('hb_account_summary');
    expect(r.parts[0]).toContain('Training verification: money balance 48.00 GBP');
    expect(ops(r)).toContain('training-verification.credits.show');
  });

  it('hb_needs_attention reports failed and stuck pending verifications, not fresh pending ones', async () => {
    h = await startHarness();
    h.hub.seedVerification({ status: 'failed', reason: { code: 'system_error', message: 'm' }, created_at: '2026-10-27T10:00:00Z' });
    h.hub.seedVerification({ status: 'pending', created_at: '2020-01-01T00:00:00Z', candidate_name: 'Old Pending' });
    h.hub.seedVerification({ status: 'pending', created_at: new Date().toISOString(), candidate_name: 'Fresh Pending' });
    const r = await h.call('hb_needs_attention');
    expect(r.parts[0]).toContain('1 certificate verification(s) failed');
    expect(r.parts[0]).toContain('system_error');
    expect(r.parts[0]).toContain('1 certificate verification(s) still pending after an hour');
    expect(r.parts[0]).toContain('Old Pending');
    expect(r.parts[0]).not.toContain('Fresh Pending');
    expect(r.data.checked).toEqual(expect.arrayContaining(['training-verification (failed)', 'training-verification (stuck pending)', 'webhooks']));
    expect(r.text).not.toContain('jo.smith@example.com');
  });

  it('hb_needs_attention lists the area as not checked without the scope', async () => {
    const x = await withScopes({}, (s) => s.startsWith('training-verification:'));
    const r = await x.call('hb_needs_attention');
    expect(r.parts[0]).toContain('training-verification (failed) (the key lacks the scope training-verification:read)');
  });

  it('hb_candidate_overview adds the verifications linked by candidate_ref, with no email, certificate or courses', async () => {
    h = await startHarness();
    h.hub.seedVerification({ status: 'not_found', candidate_ref: REF, client_reference: 'PL-9', reason: { code: 'candidate_not_found', message: 'm' }, created_at: '2026-10-20T10:00:00Z' });
    h.hub.seedVerification({ status: 'verified', candidate_ref: '11111111-2222-4333-8444-555555555555' });
    const r = await h.call('hb_candidate_overview', { candidate_ref: REF });
    expect(r.parts[0]).toContain('Training verification:');
    expect(r.parts[0]).toMatch(/verification #\d+ \(auto\): not_found, reason candidate_not_found, ref PL-9; created 2026-10-20/);
    expect(r.data.records['training-verification']).toHaveLength(1);
    expect(r.text).not.toContain('jo.smith@example.com');
    expect(r.text).not.toContain('Fire Safety');
    const q = h.hub.apiRequests().find((x) => x.opId === 'training-verification.verifications.list')!;
    expect(q.query.get('candidate_ref')).toBe(REF);
  });

  it('hb_get_report gives the verification report and certificate availability and how to download, never the file', async () => {
    h = await startHarness();
    const done = h.hub.seedVerification({ status: 'verified' });
    const pending = h.hub.seedVerification({ status: 'pending' });
    const ok = await h.call('hb_get_report', { kind: 'verification_report', booking_id: done.id, check_download: true });
    expect(ok.parts[0]).toContain('Training verification report: available');
    expect(ok.parts[0]).toContain(`/api/v2/training-verification/verifications/${done.id}/report`);
    expect(ok.parts[0]).toContain('personal data');
    expect(ok.data.available).toBe(true);
    expect(ok.data.personal_data).toBe(true);
    expect(ok.text).not.toContain('content_base64');
    expect(ok.data.download_check.size_bytes).toBeGreaterThan(0);
    const no = await h.call('hb_get_report', { kind: 'verification_report', booking_id: pending.id });
    expect(no.parts[0]).toContain('not available yet');
    const cert = await h.call('hb_get_report', { kind: 'verification_certificate', booking_id: done.id });
    expect(cert.parts[0]).toContain('Submitted training certificate');
    expect(cert.parts[0]).toContain('available');
    expect(cert.parts[0]).toContain('PDF, JPG or PNG');
    const missing = await h.call('hb_get_report', { kind: 'verification_report' });
    expect(missing.isError).toBe(true);
  });

  it('hb_go_live_check mentions the scope, the pricing rules and the live prices', async () => {
    h = await startHarness();
    const r = await h.call('hb_go_live_check', { portals: ['training-verification'] });
    expect(r.parts[0]).toContain('training-verification: the key has');
    expect(r.parts[0]).toContain('can submit and cancel certificate verifications');
    expect(r.parts[0]).toContain('Automated is free for a regular account');
    expect(r.parts[0]).toContain('auto free, manual 12.00 GBP incl. VAT');
    expect(r.parts[0]).toContain('training certificate data');
    expect(ops(r)).toContain('training-verification.pricing.show');
    const x = await withScopes({}, (s) => s === 'training-verification:write');
    const readOnly = await x.call('hb_go_live_check', { portals: ['training-verification'] });
    expect(readOnly.parts[0]).toContain('can only read');
    const none = await withScopes({}, (s) => s.startsWith('training-verification:'));
    const lacking = await none.call('hb_go_live_check', { portals: ['training-verification'] });
    expect(lacking.parts[0]).toContain('training-verification: the key has no scope for this portal');
  });

  it('hb_setup_sandbox_webhook subscribes the seven training verification events by default when the key has the scope', async () => {
    h = await startHarness(WRITE_ENV);
    h.hub.failNext(200, { data: [{ key: 'all', label: 'All', events: h.ctx.catalogue.events.map((e) => ({ event: e.type, label: e.summary })) }] }, {}, (q) => q.opId === 'webhooks.events.list');
    const r = await h.call('hb_setup_sandbox_webhook', { url: 'https://receiver.example.org/hooks/hub' });
    expect(r.isError).toBe(false);
    const body = writes(h).find((q) => q.opId === 'webhooks.endpoints.create')!.json as any;
    expect(body.events).toEqual(expect.arrayContaining(['training-verification.submitted', 'training-verification.processing', 'training-verification.verified', 'training-verification.not_found', 'training-verification.rejected', 'training-verification.failed', 'training-verification.refunded', 'online-training.course.completed']));
    expect(body.events.filter((e: string) => e.startsWith('training-verification.'))).toHaveLength(7);
  });

  it('hb_setup_sandbox_webhook leaves them out without a training verification scope or toolset, and honours explicit events', async () => {
    const x = await withScopes(WRITE_ENV, (s) => s.startsWith('training-verification:'));
    x.hub.failNext(200, { data: [{ key: 'all', label: 'All', events: x.ctx.catalogue.events.map((e) => ({ event: e.type, label: e.summary })) }] }, {}, (q) => q.opId === 'webhooks.events.list');
    await x.call('hb_setup_sandbox_webhook', { url: 'https://receiver.example.org/a' });
    const body = writes(x).find((q) => q.opId === 'webhooks.endpoints.create')!.json as any;
    expect(body.events.some((e: string) => e.startsWith('training-verification.'))).toBe(false);
    const y = await startHarness(WRITE_ENV);
    h = y;
    y.hub.failNext(200, { data: [{ key: 'all', label: 'All', events: y.ctx.catalogue.events.map((e) => ({ event: e.type, label: e.summary })) }] }, {}, (q) => q.opId === 'webhooks.events.list');
    await y.call('hb_setup_sandbox_webhook', { url: 'https://receiver.example.org/b', events: ['training-verification.verified'] });
    const explicit = writes(y).find((q) => q.opId === 'webhooks.endpoints.create')!.json as any;
    expect(explicit.events).toEqual(['training-verification.verified']);
  });
});

describe('events and the catalogue', () => {
  it('lists the seven training verification events', async () => {
    h = await startHarness();
    const r = await h.call('hb_list_events', { portal: 'training-verification' });
    expect(r.json.count).toBe(7);
    expect(r.json.events.map((e: any) => e.type).sort()).toEqual(['training-verification.failed', 'training-verification.not_found', 'training-verification.processing', 'training-verification.refunded', 'training-verification.rejected', 'training-verification.submitted', 'training-verification.verified']);
  });

  it('hb_search_operations finds the portal by toolset and scope', async () => {
    h = await startHarness();
    const r = await h.call('hb_search_operations', { toolset: 'training-verification', limit: 20 });
    expect(r.json.operations).toHaveLength(11);
    expect(new Set(r.json.operations.map((o: any) => o.scope))).toEqual(new Set(['training-verification:read', 'training-verification:write']));
  });

  it('the generic tool can read the new portal with a flat read scope', async () => {
    h = await startHarness();
    const r = await h.call('hb_call_operation', { operation_id: 'training-verification.verifications.list' });
    expect(r.isError).toBe(false);
  });
});
