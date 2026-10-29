import { z } from 'zod';
import type { AppContext } from '../context.js';
import { UUID, day, maskId, money, protect, rows, when, why, type CallOutcome, type Json } from './task-support.js';
import { done, failed, send, writeBase, writeTask, type WriteCtx } from './task-kit.js';

const PORTAL = z.enum(['dbs-rtw', 'registration-monitoring']);
const FREQ = z.enum(['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'six_month', 'nine_month', 'yearly']);
const label = (p: string): string => (p === 'dbs-rtw' ? 'DBS and right to work' : 'Registration monitoring');

// -------------------------------------------------------------------------------------- hb_verify_worker

const verifyArgs = z.object({
  portal: PORTAL,
  worker_id: z.number().int().optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(30).optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  profession: z.string().max(100).optional(),
  consent_given: z.boolean().optional(),
  monitoring_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  check_frequency: FREQ.optional(),
  dbs_certificate_number: z.string().optional(),
  dbs_surname: z.string().max(100).optional(),
  rtw_share_code: z.string().optional(),
  regulator: z.string().max(20).optional(),
  registration_number: z.string().max(40).optional(),
  track: z.enum(['dbs', 'rtw']).optional(),
  verify_now: z.boolean().optional(),
  ...writeBase,
});

const normShare = (s: string): string => s.replace(/\s+/g, '').toUpperCase();
const shareOk = (s: string): boolean => /^[A-Z0-9]{9}$/.test(normShare(s));
const spaced = (s: string): string => normShare(s).replace(/(.{3})(?=.)/g, '$1 ');

async function pollJob(c: WriteCtx<unknown>, portal: string, jobId: number): Promise<Json | undefined> {
  let last: Json | undefined;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await c.ctx.sleep(1500);
    const r = await c.run.call(`${portal}.verify.job`, { path_params: { job: jobId } }, { noPrecheck: true });
    if (!r.ok) return last;
    last = r.data;
    if (['completed', 'failed'].includes(String(last?.status))) return last;
  }
  return last;
}

export const verifyWorkerTool = writeTask({
  name: 'hb_verify_worker',
  title: 'Add and verify a worker',
  description:
    'Add a worker to DBS and right to work or to registration monitoring (param `portal`) and run the first check, or re-check or update the share code of an existing worker (worker_id), in two calls. CALL 1 validates the details, shows what personal data will be sent (certificate numbers and share codes only in masked form), the billing basis and trial status, and any worker with the same email; it sends nothing. CALL 2 with confirm=true creates the worker (idempotency key), asks for the verification, waits briefly for the job and reports the result. consent_given must be set to true by the user. Share codes and certificate numbers are never echoed back beyond a masked form, and are scrubbed from errors. Document uploads and passport images are not supported. Uses {portal}.workers.create/.show/.list/.verify/.share-code, {portal}.verify.job and {portal}.billing.usage.',
  properties: {
    portal: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring'] },
    worker_id: { type: 'integer', description: 'An existing worker: re-check them (and set a new share code if given).' },
    first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
    date_of_birth: { type: 'string', description: 'YYYY-MM-DD. DBS needs it; a share code check needs it.' },
    profession: { type: 'string' },
    consent_given: { type: 'boolean', description: 'The user confirms the worker consented to being monitored. Must be true to create.' },
    monitoring_start_date: { type: 'string' },
    check_frequency: { type: 'string', enum: ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'six_month', 'nine_month', 'yearly'] },
    dbs_certificate_number: { type: 'string', description: 'DBS: exactly 12 digits (with dbs_surname and date_of_birth).' },
    dbs_surname: { type: 'string' },
    rtw_share_code: { type: 'string', description: 'Right to work share code: 3 groups of 3 letters or digits.' },
    regulator: { type: 'string', description: 'Registration monitoring: nmc, gmc, hcpc, gdc, goc, gphc, ahcs, swe, sssc, scw, niscc, psni, gosc or gcc.' },
    registration_number: { type: 'string', description: 'Registration monitoring: the registration number.' },
    track: { type: 'string', enum: ['dbs', 'rtw'], description: 'DBS and right to work: which track to re-check when the worker has both (default: both).' },
    verify_now: { type: 'boolean', description: 'Run the check now (default true).' },
  },
  required: ['portal'],
  schema: verifyArgs,
  availability: { anyOf: ['dbs-rtw', 'registration-monitoring'] },
  ops: (a) => (a.worker_id !== undefined
    ? [`${a.portal}.workers.show`, `${a.portal}.workers.verify`, `${a.portal}.verify.job`, ...(a.rtw_share_code ? [`${a.portal}.workers.share-code`] : [])]
    : [`${a.portal}.workers.create`, `${a.portal}.workers.verify`, `${a.portal}.verify.job`, `${a.portal}.workers.show`]),
  plan: async (c) => {
    const { run, args } = c;
    protect(args.rtw_share_code, normShare(args.rtw_share_code ?? ''), args.dbs_certificate_number);
    const problems: string[] = [];
    const usage = await run.get(`${args.portal}.billing.usage`, {});
    const lines: string[] = [];
    const billing = usage.ok ? usage.data ?? {} : undefined;
    const billingLine = billing ? `Billing: ${billing.billing_type ?? '-'}${billing.trial?.on_trial ? `, free trial until ${day(billing.trial.expires_at)}` : ''}${billing.trial?.restricted ? ', RESTRICTED (checks may be refused)' : ''}; this month ${billing.estimate?.active_workers ?? '?'} active worker(s). The create and verify calls charge nothing themselves; the account is billed monthly by active workers.` : `Billing was not checked (${why(usage)}).`;
    if (args.worker_id !== undefined) {
      const show = await run.get(`${args.portal}.workers.show`, { path_params: { worker: args.worker_id } });
      if (!show.ok) return { lines: [], problems: [`the worker could not be read (${why(show)}).`] };
      const w = show.data ?? {};
      if (w.is_active === false) problems.push('the worker is not active, so the Hub refuses a check.');
      const tracks = args.portal === 'dbs-rtw' ? [w.dbs ? 'dbs' : '', w.rtw ? 'rtw' : ''].filter(Boolean) : ['registration'];
      lines.push(`Worker #${w.id} ${w.first_name ?? ''} ${w.last_name ?? ''}: enrolled for ${tracks.join(' and ') || 'nothing'}.`);
      if (args.rtw_share_code) {
        if (args.portal !== 'dbs-rtw') problems.push('share codes are for DBS and right to work only.');
        else if (!shareOk(args.rtw_share_code)) problems.push('the share code must be 3 groups of 3 letters or digits.');
        else lines.push(`New share code ${maskId(args.rtw_share_code)} will replace the stored one (the Home Office check also needs the date of birth on the worker).`);
      }
      if (args.verify_now !== false) lines.push(`A check will be requested now (${args.track ?? tracks.join(' and ')}); it runs in the background and the tool waits briefly for the result.`);
      lines.push(billingLine);
      return { lines, problems, data: { mode: 'existing', worker_id: w.id, tracks } };
    }
    for (const f of ['first_name', 'last_name', 'email'] as const) if (!args[f]) problems.push(`${f} is needed.`);
    if (args.consent_given !== true) problems.push('consent_given must be true: the user must confirm the worker consented to being monitored.');
    const tracks: string[] = [];
    if (args.portal === 'dbs-rtw') {
      if (args.dbs_certificate_number) {
        tracks.push('dbs');
        if (!/^\d{12}$/.test(args.dbs_certificate_number.replace(/\s+/g, ''))) problems.push('the DBS certificate number must be exactly 12 digits.');
        if (!args.dbs_surname) problems.push('dbs_surname is needed with a DBS certificate number.');
        if (!args.date_of_birth) problems.push('date_of_birth is needed for a DBS check.');
      }
      if (args.rtw_share_code) {
        tracks.push('rtw');
        if (!shareOk(args.rtw_share_code)) problems.push('the share code must be 3 groups of 3 letters or digits.');
        if (!args.date_of_birth) problems.push('date_of_birth is needed for a share code check.');
      }
      if (!tracks.length) problems.push('give a DBS certificate number (with surname and date of birth) and/or a right to work share code. Document uploads are not supported by this tool.');
    } else {
      tracks.push('registration');
      if (!args.regulator || !args.registration_number) problems.push('regulator and registration_number are needed.');
    }
    const dupe = args.email ? await run.get(`${args.portal}.workers.list`, { query: { search: args.email, per_page: 5 } }) : undefined;
    const same = dupe?.ok ? rows(dupe).filter((w) => String(w.email ?? '').toLowerCase() === args.email!.toLowerCase()) : [];
    if (same.length) lines.push(`WARNING: a worker with this email already exists (#${same.map((w) => w.id).join(', #')}). Use worker_id to re-check them instead of adding another.`);
    lines.push(`Add to ${label(args.portal)}: ${args.first_name ?? '?'} ${args.last_name ?? '?'} <${args.email ?? '?'}>${args.profession ? `, ${args.profession}` : ''}; tracks: ${tracks.join(' and ') || 'none'}; frequency ${args.check_frequency ?? 'account default'}.`);
    lines.push(`Personal data that will be sent to the Hub: name, email${args.phone ? ', phone' : ''}${args.date_of_birth ? ', date of birth' : ''}${args.dbs_certificate_number ? `, DBS certificate ${maskId(args.dbs_certificate_number)}` : ''}${args.rtw_share_code ? `, share code ${maskId(args.rtw_share_code)}` : ''}${args.registration_number ? `, registration number ${maskId(args.registration_number)}` : ''}. Consent recorded as given now.`);
    if (args.verify_now !== false) lines.push('The first check is requested right after the worker is created.');
    lines.push(billingLine);
    return { lines, problems, data: { mode: 'create', tracks, existing_same_email: same.map((w) => w.id) } };
  },
  execute: async (c, plan) => {
    const { args } = c;
    const cx = c as WriteCtx<unknown>;
    let workerId = args.worker_id;
    const lines: string[] = [];
    let tracks = (plan.data?.tracks as string[]) ?? [];
    if (workerId === undefined) {
      const body: Json = {
        first_name: args.first_name, last_name: args.last_name, email: args.email, consent_given: true,
        ...(args.phone ? { phone: args.phone } : {}), ...(args.date_of_birth ? { date_of_birth: args.date_of_birth } : {}), ...(args.profession ? { profession: args.profession } : {}),
        ...(args.monitoring_start_date ? { monitoring_start_date: args.monitoring_start_date } : {}),
        ...(args.portal === 'dbs-rtw'
          ? { ...(args.dbs_certificate_number ? { dbs_certificate_number: args.dbs_certificate_number.replace(/\s+/g, ''), dbs_surname: args.dbs_surname } : {}), ...(args.rtw_share_code ? { rtw_document_type: 'share_code', rtw_share_code: spaced(args.rtw_share_code) } : {}), ...(args.check_frequency ? { dbs_check_frequency: args.check_frequency, rtw_check_frequency: args.check_frequency } : {}) }
          : { regulator: args.regulator, registration_number: args.registration_number, ...(args.check_frequency ? { check_frequency: args.check_frequency } : {}) }),
      };
      const created = await send(cx, `${args.portal}.workers.create`, { body }, 'create');
      if (!created.ok) return failed(c, 'The worker was not created', created);
      workerId = created.data?.id as number;
      lines.push(`Worker #${workerId} created${created.data?.dbs?.certificate_number ? `; DBS certificate ${created.data.dbs.certificate_number}` : ''}.`);
    } else if (args.rtw_share_code) {
      const r = await send(cx, `${args.portal}.workers.share-code`, { path_params: { worker: workerId }, body: { rtw_share_code: spaced(args.rtw_share_code) } }, 'share');
      if (!r.ok) return failed(c, 'The share code was not updated', r);
      lines.push(`Share code updated (${maskId(args.rtw_share_code)}).`);
    }
    const jobs: { track: string; job?: Json }[] = [];
    if (args.verify_now !== false) {
      let toRun: (string | undefined)[] = args.portal === 'registration-monitoring' ? [undefined] : args.track ? [args.track] : tracks;
      if (args.worker_id !== undefined && args.portal === 'dbs-rtw' && !args.track) {
        const show = await c.run.get(`${args.portal}.workers.show`, { path_params: { worker: workerId } });
        tracks = [show.data?.dbs ? 'dbs' : '', show.data?.rtw ? 'rtw' : ''].filter(Boolean);
        toRun = tracks;
      }
      if (toRun.length === 0) toRun = [undefined];
      for (const t of toRun) {
        const v = await send(cx, `${args.portal}.workers.verify`, { path_params: { worker: workerId }, body: t ? { track: t } : {} }, `verify-${t ?? 'registration'}`);
        if (!v.ok) {
          lines.push(`The ${t ?? 'registration'} check could not be requested: ${why(v)}.`);
          continue;
        }
        const job = await pollJob(cx, args.portal, Number(v.data?.job_id));
        jobs.push({ track: t ?? 'registration', job });
        lines.push(`${t ?? 'registration'} check job ${v.data?.job_id}: ${job?.status ?? v.data?.status ?? 'pending'}${job?.failed_count ? ', failed' : ''}${job?.status === 'completed' || job?.status === 'failed' ? '' : ' (still running: read the result later with hb_worker_status)'}.`);
      }
      const show = await c.run.get(`${args.portal}.workers.show`, { path_params: { worker: workerId } });
      if (show.ok) {
        const w = show.data ?? {};
        lines.push(args.portal === 'dbs-rtw' ? `Now: DBS ${w.dbs?.status_label ?? '-'}, right to work ${w.rtw?.status_label ?? '-'}.` : `Now: ${String(w.regulator ?? '').toUpperCase()} registration ${w.status_label ?? '-'}.`);
      }
    }
    return done(c, lines, { worker_id: workerId, jobs: jobs.map((j) => ({ track: j.track, job_id: j.job?.job_id, status: j.job?.status })) });
  },
});

// --------------------------------------------------------------------------------- hb_acknowledge_alerts

const ackArgs = z.object({
  portal: z.enum(['dbs-rtw', 'registration-monitoring', 'occupational-health']),
  alert_id: z.number().int().optional(),
  ids: z.array(z.number().int()).max(500).optional(),
  type: z.string().max(100).optional(),
  all_open: z.boolean().optional(),
  oh_action: z.enum(['dismiss', 'clear']).optional(),
  oh_key: z.string().max(100).optional(),
  ...writeBase,
});

export const acknowledgeAlertsTool = writeTask({
  name: 'hb_acknowledge_alerts',
  title: 'Acknowledge or dismiss alerts',
  description:
    'Acknowledge alerts in DBS and right to work or registration monitoring (one with alert_id, several with ids, every open alert of a type with type, or all open alerts only with all_open=true), or dismiss occupational health alerts (oh_action dismiss with oh_key, or clear to hide all shown alerts: shared with every Hub user, the requests themselves do not change). Two calls: CALL 1 lists exactly which alerts are affected and sends nothing; CALL 2 with confirm=true does it. Nobody is emailed. Occupational health alerts are shown as statuses only. Uses {portal}.alerts.list/.show/.acknowledge/.acknowledge-bulk and occupational-health.alerts.list/.dismiss/.clear.',
  properties: {
    portal: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring', 'occupational-health'] },
    alert_id: { type: 'integer', description: 'DBS/RTW or registration: acknowledge this alert.' },
    ids: { type: 'array', items: { type: 'integer' }, description: 'Acknowledge these alert ids (max 500).' },
    type: { type: 'string', description: 'Acknowledge every open alert of this type.' },
    all_open: { type: 'boolean', description: 'Acknowledge EVERY open alert of the portal. Must be explicit.' },
    oh_action: { type: 'string', enum: ['dismiss', 'clear'], description: 'Occupational health: dismiss one alert (oh_key) or clear all.' },
    oh_key: { type: 'string', description: 'Occupational health alert key, for example rejected:4821.' },
  },
  required: ['portal'],
  schema: ackArgs,
  availability: { anyOf: ['dbs-rtw', 'registration-monitoring', 'occupational-health'] },
  destructive: true,
  idempotent: false,
  ops: (a) => {
    if (a.portal === 'occupational-health') return a.oh_action === 'clear' ? ['occupational-health.alerts.list', 'occupational-health.alerts.clear'] : ['occupational-health.alerts.list', 'occupational-health.alerts.dismiss'];
    return a.alert_id !== undefined ? [`${a.portal}.alerts.show`, `${a.portal}.alerts.acknowledge`] : [`${a.portal}.alerts.list`, `${a.portal}.alerts.acknowledge-bulk`];
  },
  plan: async (c) => {
    const { run, args } = c;
    const problems: string[] = [];
    if (args.portal === 'occupational-health') {
      if (!args.oh_action) return { lines: [], problems: ['oh_action is needed: dismiss (with oh_key) or clear.'] };
      const list = await run.get('occupational-health.alerts.list', { query: { per_page: 100 } });
      if (!list.ok) return { lines: [], problems: [`the alerts could not be read (${why(list)}).`] };
      const alerts = rows(list);
      const lines = [`${alerts.length} occupational health alert(s) are shown (statuses only):`, ...alerts.slice(0, 15).map((x) => `  - ${x.key}: ${x.type} [${x.severity}] ${x.status_label ?? ''}, ${when(x.at)}`)];
      if (args.oh_action === 'dismiss') {
        if (!args.oh_key) problems.push('oh_key is needed.');
        else if (!alerts.some((x) => x.key === args.oh_key)) problems.push(`no shown alert has the key ${args.oh_key}.`);
        else lines.push(`Dismiss ${args.oh_key}. It stays hidden until the request changes status. Dismissals are shared with your account's users and the Hub Alerts page.`);
      } else {
        lines.push(`CLEAR all ${alerts.length} shown alert(s): hidden for every user of the account until each request changes status. The requests are not changed.`);
        if (!alerts.length) problems.push('there are no shown alerts to clear.');
      }
      return { lines, problems, data: { portal: args.portal, shown: alerts.length } };
    }
    if (args.alert_id !== undefined) {
      const show = await run.get(`${args.portal}.alerts.show`, { path_params: { alert: args.alert_id } });
      if (!show.ok) return { lines: [], problems: [`the alert could not be read (${why(show)}).`] };
      const x = show.data ?? {};
      if (x.acknowledged === true) problems.push('the alert is already acknowledged.');
      return { lines: [`Acknowledge alert #${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.worker?.name ?? 'worker'}, ${x.previous_status ?? '-'} -> ${x.new_status ?? '-'}, raised ${when(x.created_at)}.`], problems, data: { alert_id: x.id } };
    }
    if (!args.ids?.length && !args.type && args.all_open !== true) return { lines: [], problems: ['say which alerts: alert_id, ids, type, or all_open=true (the Hub would otherwise acknowledge every open alert).'] };
    const list = await run.get(`${args.portal}.alerts.list`, { query: { acknowledged: 'false', per_page: 100, sort: '-created_at', ...(args.type && !args.ids?.length ? { type: args.type } : {}) } });
    if (!list.ok) return { lines: [], problems: [`the open alerts could not be read (${why(list)}).`] };
    let open = rows(list).filter((x) => x.acknowledged === false);
    if (args.ids?.length) open = open.filter((x) => args.ids!.includes(Number(x.id)));
    else if (args.type) open = open.filter((x) => x.type === args.type);
    const lines = [`${args.ids?.length ? `${args.ids.length} id(s) given` : args.type ? `Open alerts of type ${args.type}` : 'ALL open alerts'}: ${open.length} found${Number(list.body?.meta?.total) > rows(list).length ? ` (the first 100 of ${list.body.meta.total} were checked)` : ''}.`];
    for (const x of open.slice(0, 15)) lines.push(`  - #${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.worker?.name ?? 'worker'}, ${when(x.created_at)}`);
    lines.push('Alerts that are missing, belong to another portal or are already acknowledged are skipped by the Hub without an error. Nobody is emailed.');
    return { lines, problems: open.length ? [] : ['no open alert matches.'], data: { matching: open.map((x) => x.id) } };
  },
  execute: async (c) => {
    const { args } = c;
    const cx = c as WriteCtx<unknown>;
    if (args.portal === 'occupational-health') {
      if (args.oh_action === 'clear') {
        const r = await send(cx, 'occupational-health.alerts.clear', {}, 'clear');
        if (!r.ok) return failed(c, 'The alerts were not cleared', r);
        return done(c, [`Cleared ${r.data?.dismissed ?? 0} alert(s).`], { dismissed: r.data?.dismissed });
      }
      const r = await send(cx, 'occupational-health.alerts.dismiss', { body: { key: args.oh_key } }, 'dismiss');
      if (!r.ok) return failed(c, 'The alert was not dismissed', r);
      return done(c, [`Dismissed ${r.data?.dismissed ?? 0} alert(s).`], { dismissed: r.data?.dismissed });
    }
    if (args.alert_id !== undefined) {
      const r = await send(cx, `${args.portal}.alerts.acknowledge`, { path_params: { alert: args.alert_id } }, 'ack');
      if (!r.ok) return failed(c, 'The alert was not acknowledged', r);
      return done(c, [`Alert #${args.alert_id} acknowledged.`], { acknowledged_count: 1 });
    }
    const body: Json = args.ids?.length ? { ids: args.ids } : args.type ? { type: args.type } : {};
    const r = await send(cx, `${args.portal}.alerts.acknowledge-bulk`, { body }, 'ack-bulk');
    if (!r.ok) return failed(c, 'The alerts were not acknowledged', r);
    return done(c, [`Acknowledged ${r.data?.acknowledged_count ?? 0} alert(s).`], { acknowledged_count: r.data?.acknowledged_count });
  },
});

// -------------------------------------------------------------------------------- hb_bulk_import_workers

const fileSchema = z.object({ filename: z.string().max(200), content_text: z.string().optional(), content_base64: z.string().optional(), content_type: z.string().optional() }).refine((f) => f.content_text !== undefined || f.content_base64 !== undefined, 'file needs content_text or content_base64');

const importArgs = z.object({
  portal: PORTAL,
  file: fileSchema,
  column_mapping: z.record(z.string(), z.string()).optional(),
  check_frequency: FREQ.optional(),
  monitoring_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  consent_given: z.boolean().optional(),
  is_active: z.boolean().optional(),
  ...writeBase,
});

const importBody = (a: z.infer<typeof importArgs>): Json => ({
  file: { filename: a.file.filename, content_type: a.file.content_type ?? 'text/csv', ...(a.file.content_text !== undefined ? { content_text: a.file.content_text } : { content_base64: a.file.content_base64 }) },
  ...(a.column_mapping ? { column_mapping: a.column_mapping } : {}),
  ...(a.check_frequency ? { check_frequency: a.check_frequency } : {}),
  ...(a.monitoring_start_date ? { monitoring_start_date: a.monitoring_start_date } : {}),
  ...(a.consent_given !== undefined ? { consent_given: a.consent_given } : {}),
  ...(a.is_active !== undefined ? { is_active: a.is_active } : {}),
});

export const bulkImportWorkersTool = writeTask({
  name: 'hb_bulk_import_workers',
  title: 'Bulk import workers from a CSV',
  description:
    'Import workers from a CSV into DBS and right to work or registration monitoring (param `portal`), in two calls. CALL 1 uploads the file for a PREVIEW (nothing is imported) and returns the plan: row counts, valid and invalid rows, the first errors with their line numbers, the column mapping the Hub suggests; sample rows (personal data) are not shown. CALL 2 with the same arguments and confirm=true imports the file (idempotency key) and reports imported and failed counts. `file` is {filename, content_text} (or content_base64), max 10 MB. The preview call is a POST but changes nothing. Uses {portal}.imports.preview/.create/.show.',
  properties: {
    portal: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring'] },
    file: { type: 'object', properties: { filename: { type: 'string' }, content_text: { type: 'string' }, content_base64: { type: 'string' }, content_type: { type: 'string' } }, required: ['filename'], description: 'The CSV: {"filename":"workers.csv","content_text":"first_name,last_name,..."}.' },
    column_mapping: { type: 'object', description: 'Optional {field: column header} when headers differ.' },
    check_frequency: { type: 'string', enum: ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'six_month', 'nine_month', 'yearly'] },
    monitoring_start_date: { type: 'string' },
    consent_given: { type: 'boolean', description: 'Consent applies to every row (the user must confirm it).' },
    is_active: { type: 'boolean' },
  },
  required: ['portal', 'file'],
  schema: importArgs,
  availability: { anyOf: ['dbs-rtw', 'registration-monitoring'] },
  ops: (a) => [`${a.portal}.imports.preview`, `${a.portal}.imports.create`, `${a.portal}.imports.show`],
  plan: async (c) => {
    const { run, args } = c;
    const pre = await run.call(`${args.portal}.imports.preview`, { body: importBody(args), confirm: true }, { noPrecheck: true });
    if (!pre.ok) return { lines: [`The preview failed: ${why(pre)}.`, ...(pre.error ? [pre.error.split('\n').slice(0, 6).join('\n')] : [])], problems: ['the file could not be previewed.'] };
    const p = pre.data ?? {};
    const errors: Json[] = Array.isArray(p.errors) ? p.errors : [];
    const problems: string[] = [];
    if (!Number(p.total_rows)) problems.push('the file has no rows.');
    else if (!Number(p.valid_count)) problems.push('no row is valid.');
    const lines = [
      `Preview of ${args.file.filename} for ${label(args.portal)} (nothing imported): ${p.total_rows ?? '?'} row(s), ${p.valid_count ?? '?'} valid, ${p.invalid_count ?? '?'} invalid${p.truncated ? ' (only part of the file was checked)' : ''}.`,
      `Columns: ${(p.headers ?? []).join(', ')}.`,
      ...(errors.length ? ['First errors:', ...errors.slice(0, 10).map((e) => `  - line ${e.line}: ${e.message}`), ...(errors.length > 10 ? [`  …and ${errors.length - 10} more`] : [])] : ['No row errors.']),
      Number(p.invalid_count) > 0 ? 'Invalid rows are skipped on import; the valid ones are imported.' : 'All rows are valid.',
      args.consent_given === true ? 'consent_given=true applies to every row.' : 'consent_given is not set for the import: the file or the account defaults decide it. Confirm with the user that every worker consented.',
    ];
    return { lines, problems, data: { preview: { total_rows: p.total_rows, valid_count: p.valid_count, invalid_count: p.invalid_count, truncated: p.truncated, headers: p.headers, errors: errors.slice(0, 20) } } };
  },
  execute: async (c) => {
    const { args } = c;
    const cx = c as WriteCtx<unknown>;
    const r = await send(cx, `${args.portal}.imports.create`, { body: importBody(args) }, 'import');
    if (!r.ok) return failed(c, 'The import was not started', r);
    let imp: Json = r.data ?? {};
    for (let i = 0; i < 2 && !['completed', 'failed'].includes(String(imp.status)) && imp.id; i++) {
      await c.ctx.sleep(1500);
      const s = await c.run.call(`${args.portal}.imports.show`, { path_params: { import: imp.id } }, { noPrecheck: true });
      if (!s.ok) break;
      imp = s.data ?? imp;
    }
    const errors: Json[] = Array.isArray(imp.errors) ? imp.errors : [];
    return done(c, [`Import #${imp.id}: ${imp.status ?? '-'}, ${imp.imported_count ?? 0} imported, ${imp.failed_count ?? 0} failed of ${imp.total_rows ?? '?'} row(s), progress ${imp.progress ?? '?'}%.`, ...errors.slice(0, 10).map((e) => `  - line ${e.line}: ${e.message}`), ...(['completed', 'failed'].includes(String(imp.status)) ? [] : ['Still running: read it later with the import id (hb_call_operation on the imports.show operation).'])], { import: { id: imp.id, status: imp.status, imported_count: imp.imported_count, failed_count: imp.failed_count, total_rows: imp.total_rows, errors: errors.slice(0, 20) } });
  },
});

export type { AppContext, CallOutcome };
export { money, UUID };
