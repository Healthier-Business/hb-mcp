import { z } from 'zod';
import type { AppContext } from '../context.js';
import { redactor } from '../redact.js';
import { readOnlyHints, refusal, rows, taskResult, when, why, money, TaskRun, type Json, type TaskTool } from './task-support.js';
import { done, failed, send, writeBase, writeTask, type PlanResult, type WriteCtx } from './task-kit.js';
import { DEFAULT_CERTIFICATE_MAX_KB, DEFAULT_CERTIFICATE_TYPES, formatSize, readUploadFile, type SafeFile } from './upload-files.js';

export const TV_STATUSES = ['pending', 'processing', 'verified', 'not_found', 'rejected', 'failed'] as const;
export const TV_EVENTS = [
  'training-verification.submitted',
  'training-verification.processing',
  'training-verification.verified',
  'training-verification.not_found',
  'training-verification.rejected',
  'training-verification.failed',
  'training-verification.refunded',
] as const;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What a charge looks like: free, or the price with VAT. */
function priceText(p: Json | undefined): string {
  if (!p) return 'price not available';
  if (p.free) return `FREE${p.reason?.message ? ` (${p.reason.message})` : ''}`;
  return `${money(p.gross_pence, p.currency)} including VAT (${money(p.net_pence, p.currency)} + ${money(p.vat_pence, p.currency)} VAT)${p.reason?.message ? `: ${p.reason.message}` : ''}`;
}

function balanceText(c: Json): string {
  const parts: string[] = [];
  if (typeof c.money_pence === 'number') parts.push(`money balance ${money(c.money_pence, c.currency)}`);
  if (typeof c.auto_credits === 'number') parts.push(`${c.auto_credits} automated credit(s)`);
  if (typeof c.manual_credits === 'number') parts.push(`${c.manual_credits} manual credit(s)`);
  if (typeof c.legacy_balance_pence === 'number') parts.push(`older balance ${money(c.legacy_balance_pence, c.currency)}`);
  return parts.join(', ') || 'no balance information';
}

/** Whether the credits and balances look able to pay a charged request. Undefined when the figures are not known. */
function looksCovered(p: Json | undefined, c: Json | undefined, requestType: string): boolean | undefined {
  if (!p || p.free) return true;
  if (!c) return undefined;
  const credits = requestType === 'auto' ? c.auto_credits : c.manual_credits;
  if (typeof credits === 'number' && credits >= 1) return true;
  if (typeof c.legacy_balance_pence === 'number' && typeof p.net_pence === 'number' && c.legacy_balance_pence >= p.net_pence) return true;
  if (typeof c.money_pence === 'number' && typeof p.gross_pence === 'number') return c.money_pence >= p.gross_pence;
  return undefined;
}

// --------------------------------------------------------------------------------------- hb_verify_certificate

const verifyArgs = z.object({
  certificate_path: z.string().min(1).max(4096),
  request_type: z.enum(['auto', 'manual']).optional(),
  candidate_name: z.string().min(1).max(255),
  candidate_email: z.string().email().max(255),
  agency_name_on_cert: z.string().min(1).max(255),
  notify_email: z.string().email().max(255).optional(),
  candidate_ref: z.string().uuid().optional(),
  client_reference: z.string().min(1).max(100).optional(),
  file_sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  ...writeBase,
});
type VerifyArgs = z.infer<typeof verifyArgs>;

/** The bytes read while planning, kept out of the plan data so they can never reach an answer. */
const readFiles = new WeakMap<PlanResult, SafeFile>();

export const verifyCertificateTool = writeTask<VerifyArgs>({
  name: 'hb_verify_certificate',
  title: 'Verify a training certificate',
  description:
    'Ask Hub to verify one training certificate (a PDF, JPG or PNG file on this machine), in two calls. CALL 1 checks the file locally and sends nothing: it must be inside a folder allowed by HB_UPLOAD_DIRS (default: the server\'s working directory), not hidden, not a link out of that folder, of an accepted type and within the size limit; the plan shows the file name, size, type and SHA-256 (never the contents), who will be emailed the result, the price (Automated is FREE for regular accounts that use other Hub services, charged for verification-only accounts; Manual is charged for everyone; credits or wallet only, no card) and the credit balance. CALL 2 with confirm=true (and the same arguments) uploads the file with training-verification.verifications.create and reports the 202 result: the check runs afterwards, so follow it with hb_verification_status or the training-verification.* webhooks. The certificate is personal data: it is never shown, logged or returned. A charged request that the credits cannot pay is refused by the Hub (402) and nothing is stored. Uses training-verification.profile.show, .pricing.show, .credits.show and .verifications.create (multipart, with an idempotency key).',
  properties: {
    certificate_path: { type: 'string', description: 'Absolute path of ONE certificate file inside an allowed folder (HB_UPLOAD_DIRS; default the server\'s working directory). Extensions .pdf .jpg .jpeg .png. No wildcards, no hidden files.' },
    request_type: { type: 'string', enum: ['auto', 'manual'], description: 'auto (default): Hub reads and matches the certificate. manual: Healthier Business staff check it (always charged).' },
    candidate_name: { type: 'string', description: 'The candidate\'s name as on the certificate.' },
    candidate_email: { type: 'string', description: 'The candidate\'s email address.' },
    agency_name_on_cert: { type: 'string', description: 'The agency or training provider named on the certificate.' },
    notify_email: { type: 'string', description: 'Where the result email goes. Default: the account\'s verification notification address (required if the account has none).' },
    candidate_ref: { type: 'string', description: 'Optional: link one of your Hub candidates (uuid from hb_find_candidate).' },
    client_reference: { type: 'string', description: 'Optional own reference, max 100 characters; returned on the verification and in every webhook.' },
    file_sha256: { type: 'string', description: 'The SHA-256 shown in the plan. On the confirming call, the upload is refused if the file changed since the plan.' },
  },
  required: ['certificate_path', 'candidate_name', 'candidate_email', 'agency_name_on_cert'],
  schema: verifyArgs,
  availability: { allOf: ['training-verification'] },
  idempotent: true,
  ops: () => ['training-verification.verifications.create'],
  plan: async (c) => {
    const { run, args } = c;
    const requestType = args.request_type ?? 'auto';
    const problems: string[] = [];

    const [profile, pricing, credits] = await Promise.all([
      run.get('training-verification.profile.show', {}),
      run.get('training-verification.pricing.show', {}),
      run.get('training-verification.credits.show', {}),
    ]);
    if (!profile.ok && profile.code === 'portal_unavailable') {
      return { lines: ['This account does not use Training Verification.'], problems: ['the account does not use Training Verification (403 portal_unavailable).'] };
    }
    const limits = profile.ok ? profile.data?.limits : undefined;
    const types: string[] = Array.isArray(limits?.certificate_types) && limits.certificate_types.length ? limits.certificate_types.map(String) : [...DEFAULT_CERTIFICATE_TYPES];
    const maxKb = typeof limits?.max_certificate_kb === 'number' ? limits.max_certificate_kb : DEFAULT_CERTIFICATE_MAX_KB;

    const read = await readUploadFile(args.certificate_path, c.ctx.config.uploadDirs, { types, maxBytes: maxKb * 1024 });
    if (!read.ok) {
      return { lines: [`The certificate file cannot be used: ${read.problem}`, 'Nothing was read beyond that check and nothing was sent.'], problems: [`the file was refused: ${read.problem}`] };
    }
    const file = read.file;
    if (args.file_sha256 && args.file_sha256.toLowerCase() !== file.sha256) {
      problems.push('the file changed since the plan (its SHA-256 differs from file_sha256). Run the plan again and check the file.');
    }

    const prices: Json[] = pricing.ok ? (pricing.data?.prices ?? pricing.data?.request_types ?? []) : profile.ok ? (profile.data?.request_types ?? []) : [];
    const price = Array.isArray(prices) ? prices.find((p) => p?.request_type === requestType) : undefined;
    const balance = credits.ok ? credits.data : undefined;
    const notify = args.notify_email ?? (profile.ok ? profile.data?.default_notify_email : undefined);
    if (!notify) problems.push('the account has no default notification address: give notify_email (where the result email goes).');

    const covered = looksCovered(price, balance, requestType);
    const lines = [
      `Verify a certificate (${requestType === 'auto' ? 'Automated' : 'Manual'}): file ${file.fileName}, ${formatSize(file.sizeBytes)}, ${file.contentType}, SHA-256 ${file.sha256} (contents are never shown).`,
      `Candidate: ${args.candidate_name} <${args.candidate_email}>; agency named on the certificate: ${args.agency_name_on_cert}${args.candidate_ref ? `; linked to candidate ${args.candidate_ref}` : ''}${args.client_reference ? `; your reference ${args.client_reference}` : ''}.`,
      notify
        ? `${c.live ? `The result email WILL be sent to ${notify} (a real address on the LIVE Hub).` : `The result email will be sent to ${notify} (in a sandbox it goes to the sandbox inbox).`}${args.notify_email ? '' : ' (the account\'s default notification address)'}`
        : 'No result email address is known yet.',
      `Price: ${priceText(price)}.${profile.ok && profile.data?.client_type ? ` Account type: ${profile.data.client_type === 'verification_only' ? 'verification-only' : 'regular'}.` : ''}`,
      `Balance: ${credits.ok ? balanceText(balance ?? {}) : `could not be read (${why(credits)})`}.`,
      ...(price && !price.free ? [covered === false ? 'WARNING: the credits and balances look too small for this charge; the Hub will refuse it (402 insufficient_credits) and store nothing. Top up in the Hub first.' : 'It is charged once, from a verification credit, the older balance or the money balance (never a card), and refunded if cancelled while pending.'] : []),
      `Accepted files: ${types.map((t) => `.${t}`).join(', ')} up to ${formatSize(maxKb * 1024)}. The check runs after the upload (202): Automated usually finishes in minutes, Manual waits for staff.`,
      'The certificate is personal data: it is sent to the Hub only, and never shown or logged here.',
    ];
    const result: PlanResult = {
      lines,
      problems,
      data: {
        file: { name: file.fileName, size_bytes: file.sizeBytes, content_type: file.contentType, sha256: file.sha256 },
        request_type: requestType,
        price: price ? { free: price.free === true, gross_pence: price.gross_pence, net_pence: price.net_pence, currency: price.currency } : undefined,
        balance: balance ? { money_pence: balance.money_pence, auto_credits: balance.auto_credits, manual_credits: balance.manual_credits, legacy_balance_pence: balance.legacy_balance_pence } : undefined,
        result_email_to: notify,
        looks_covered: covered,
      },
    };
    readFiles.set(result, file);
    return result;
  },
  execute: async (c, plan) => {
    const { args } = c;
    const file = readFiles.get(plan);
    if (!file) return refusal('The file could not be read again. Nothing was sent.');
    const base64 = file.bytes.toString('base64');
    redactor.add(base64);
    try {
      const body: Json = {
        request_type: args.request_type ?? 'auto',
        candidate_name: args.candidate_name,
        candidate_email: args.candidate_email,
        agency_name_on_cert: args.agency_name_on_cert,
        ...(args.notify_email ? { notify_email: args.notify_email } : {}),
        ...(args.candidate_ref ? { candidate_ref: args.candidate_ref } : {}),
        ...(args.client_reference ? { client_reference: args.client_reference } : {}),
        certificate: { filename: file.fileName, content_type: file.contentType, content_base64: base64 },
      };
      const r = await send(c as WriteCtx<unknown>, 'training-verification.verifications.create', { body }, 'submit');
      if (!r.ok) {
        return failed(
          c,
          'The certificate was not submitted',
          r,
          r.status === 402 ? 'Nothing was stored or charged. Top up credits or the wallet in the Hub (no card is taken through the API), then repeat with confirm=true.' : undefined,
        );
      }
      const v = r.data ?? {};
      const charge = v.charge ?? {};
      const replayed = r.meta?.idempotent_replayed === true;
      return done(
        c,
        [
          `${replayed ? 'This submission was already accepted (same idempotency key): ' : 'Accepted (202): '}verification #${v.id ?? '?'} is ${v.status ?? 'pending'} (${v.request_type ?? args.request_type ?? 'auto'}) for ${v.candidate_name ?? args.candidate_name}${v.client_reference ? `, your reference ${v.client_reference}` : ''}. File ${file.fileName} (${formatSize(file.sizeBytes)}, SHA-256 ${file.sha256}) was uploaded.`,
          `Charge: ${charge.free ? 'free' : `${money(charge.amount_pence, charge.currency)}${charge.credits_used ? `, ${charge.credits_used} credit(s)` : ''}${charge.funding ? ` from ${charge.funding}` : ''}`}.`,
          `The check runs now. Follow it with hb_verification_status (verification_id ${v.id ?? '?'}) or the webhooks training-verification.verified, .not_found, .rejected and .failed. It can be cancelled with hb_change_booking (portal training-verification) only while it is pending.`,
        ],
        { verification: { id: v.id, status: v.status, request_type: v.request_type, client_reference: v.client_reference, charge: v.charge, created_at: v.created_at }, file: { name: file.fileName, size_bytes: file.sizeBytes, sha256: file.sha256 }, idempotent_replayed: replayed },
      );
    } finally {
      redactor.forget(base64);
    }
  },
});

// ------------------------------------------------------------------------------------- hb_verification_status

const statusArgs = z.object({
  verification_id: z.number().int().optional(),
  status: z.enum(TV_STATUSES).optional(),
  request_type: z.enum(['auto', 'manual']).optional(),
  candidate_ref: z.string().uuid().optional(),
  client_reference: z.string().max(100).optional(),
  created_from: DATE.optional(),
  created_to: DATE.optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

function chargeText(ch: Json | undefined): string {
  if (!ch) return 'charge unknown';
  if (ch.free) return 'free';
  return `${money(ch.amount_pence, ch.currency)}${ch.credits_used ? ` (${ch.credits_used} credit)` : ''}${ch.funding ? ` from ${ch.funding}` : ''}${ch.refunded ? ', refunded' : ''}`;
}

/** One line per verification. No email addresses and no certificate details. */
function summaryLine(v: Json): string {
  return `#${v.id} ${v.status} (${v.request_type}) ${v.candidate_name ?? '-'}${v.client_reference ? `, ref ${v.client_reference}` : ''}${v.result?.reason?.code ? `, reason ${v.result.reason.code}` : ''}; charge ${chargeText(v.charge)}; created ${when(v.created_at)}${v.completed_at ? `, completed ${when(v.completed_at)}` : ''}`;
}

export function verificationStatusTool(ctx: AppContext): TaskTool {
  return {
    availability: { allOf: ['training-verification'] },
    definition: {
      name: 'hb_verification_status',
      description:
        'Follow certificate verifications. With verification_id: that verification in full (status, request type, the result with the courses found and the reason code when not verified, the charge and whether it was refunded, the timeline of events, and whether the report and the certificate file are available). Without it: a list, newest first, filtered by status (pending, processing, verified, not_found, rejected, failed), request_type, candidate_ref, client_reference and created_from/created_to. Metadata only: the certificate file and the report are never fetched or returned (download them with the Hub API; the answer says how). Email addresses are left out. Read-only. Uses training-verification.verifications.list, .show and .events.',
      inputSchema: {
        type: 'object',
        properties: {
          verification_id: { type: 'integer', description: 'Show one verification with its timeline.' },
          status: { type: 'string', enum: [...TV_STATUSES], description: 'List filter.' },
          request_type: { type: 'string', enum: ['auto', 'manual'] },
          candidate_ref: { type: 'string', description: 'List filter: verifications linked to this candidate.' },
          client_reference: { type: 'string', description: 'List filter: your own reference (exact).' },
          created_from: { type: 'string', description: 'List filter: UTC day YYYY-MM-DD.' },
          created_to: { type: 'string', description: 'List filter: UTC day YYYY-MM-DD.' },
          limit: { type: 'integer', description: 'List size (default 10, max 25).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Verification status', ...readOnlyHints() },
      handler: async (raw) => {
        const a = statusArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        const base = ctx.config.baseUrl;

        if (a.data.verification_id !== undefined) {
          const id = a.data.verification_id;
          const [show, events] = await Promise.all([
            run.get('training-verification.verifications.show', { path_params: { verification: id } }),
            run.get('training-verification.verifications.events', { path_params: { verification: id }, query: { per_page: 100 } }),
          ]);
          if (!show.ok) return taskResult(ctx, run, { lines: [`Verification #${id} could not be read: ${why(show)}.`, ...(show.error && !show.skipped ? [show.error] : []), `Operations called: ${run.operationsCalled().join(', ')}.`], data: { problem: why(show) } }, true);
          const v = show.data ?? {};
          const result = v.result ?? {};
          const records: Json[] = Array.isArray(result.records) ? result.records : [];
          const reportAvailable = v.status === 'verified';
          const lines = [
            `Verification #${v.id}: ${v.status} (${v.request_type}) for ${v.candidate_name ?? '-'}, agency on the certificate: ${v.agency_name_on_cert ?? '-'}${v.candidate_ref ? `, candidate ${v.candidate_ref}` : ''}${v.client_reference ? `, your reference ${v.client_reference}` : ''}.`,
            `Created ${when(v.created_at)}, updated ${when(v.updated_at)}${v.completed_at ? `, completed ${when(v.completed_at)}` : ''}.`,
            `Charge: ${chargeText(v.charge)}.`,
            ...(v.status === 'pending' ? ['Still pending: it can be cancelled (hb_change_booking, portal training-verification).'] : v.status === 'processing' ? ['Processing: an automated check is running or staff are checking it (manual).'] : []),
            ...(result.matched ? [`Result: matched${result.provider ? ` (training provider ${result.provider})` : ''}${records.length ? `, ${records.length} course(s) found:` : '.'}`, ...records.map((r) => `  - ${r.title}: completed ${r.completed_on ?? '-'}, expires ${r.expires_on ?? '-'} (${r.type ?? '-'})`)] : []),
            ...(result.reason ? [`Reason: ${result.reason.code}${result.reason.message ? ` - ${result.reason.message}` : ''}.`] : []),
            ...(events.ok ? ['Timeline:', ...rows(events).map((e) => `  ${when(e.occurred_at)} ${e.event}${e.reason_code ? ` (${e.reason_code})` : ''}${e.amount_pence != null ? ` ${money(e.amount_pence, v.charge?.currency)}` : ''}`)] : [`Timeline not read (${why(events)}).`]),
            `Certificate file: ${v.certificate_available ? 'available' : 'no longer available'}. Report: ${reportAvailable ? 'available (PDF)' : 'not available (only for a verified result)'}.`,
            ...(v.certificate_available || reportAvailable ? [`Download (never returned here): GET ${base}/api/v2/training-verification/verifications/${v.id}/${reportAvailable ? 'report' : 'certificate'} with the header Authorization: Bearer <access token>; the certificate is at .../certificate. Both are personal data: keep them out of tickets, chat and logs.`] : []),
            `Operations called: ${run.operationsCalled().join(', ')}.`,
          ];
          return taskResult(ctx, run, {
            lines,
            data: {
              verification: { id: v.id, status: v.status, request_type: v.request_type, candidate_name: v.candidate_name, candidate_ref: v.candidate_ref, client_reference: v.client_reference, agency_name_on_cert: v.agency_name_on_cert, charge: v.charge, result: { matched: result.matched, provider: result.provider, records, reason: result.reason }, created_at: v.created_at, updated_at: v.updated_at, completed_at: v.completed_at },
              events: events.ok ? rows(events).map((e) => ({ event: e.event, occurred_at: e.occurred_at, reason_code: e.reason_code, amount_pence: e.amount_pence })) : undefined,
              certificate_available: v.certificate_available === true,
              report_available: reportAvailable,
              download: { certificate: `${base}/api/v2/training-verification/verifications/${v.id}/certificate`, report: `${base}/api/v2/training-verification/verifications/${v.id}/report`, method: 'GET' },
            },
          });
        }

        const q = a.data;
        const list = await run.get('training-verification.verifications.list', {
          query: { per_page: q.limit ?? 10, sort: '-created_at', ...(q.status ? { status: q.status } : {}), ...(q.request_type ? { request_type: q.request_type } : {}), ...(q.candidate_ref ? { candidate_ref: q.candidate_ref.toLowerCase() } : {}), ...(q.client_reference ? { client_reference: q.client_reference } : {}), ...(q.created_from ? { created_from: q.created_from } : {}), ...(q.created_to ? { created_to: q.created_to } : {}) },
        });
        if (!list.ok) return taskResult(ctx, run, { lines: [`Verifications could not be listed: ${why(list)}.`, ...(list.error && !list.skipped ? [list.error] : []), `Operations called: ${run.operationsCalled().join(', ')}.`], data: { problem: why(list) } }, true);
        const items = rows(list);
        const total = list.body?.meta?.total;
        const lines = [
          items.length ? `${items.length} verification(s)${typeof total === 'number' && total > items.length ? ` of ${total}` : ''}, newest first:` : 'No verifications match.',
          ...items.map((v) => `  - ${summaryLine(v)}`),
          ...(items.length ? ['Pass verification_id for the result and the timeline of one.'] : []),
          `Operations called: ${run.operationsCalled().join(', ')}.`,
        ];
        return taskResult(ctx, run, {
          lines,
          data: { count: items.length, total, verifications: items.map((v) => ({ id: v.id, status: v.status, request_type: v.request_type, candidate_name: v.candidate_name, candidate_ref: v.candidate_ref, client_reference: v.client_reference, reason_code: v.result?.reason?.code, charge: v.charge, created_at: v.created_at, completed_at: v.completed_at, certificate_available: v.certificate_available })) },
        });
      },
    },
  };
}
