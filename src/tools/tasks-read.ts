import { z } from 'zod';
import { TOOLSETS } from '../config.js';
import type { AppContext } from '../context.js';
import {
  UUID,
  day,
  isUnavailable,
  isTaskAvailable,
  money,
  readOnlyHints,
  refusal,
  safeUrl,
  taskResult,
  when,
  why,
  TaskRun,
  type CallOutcome,
  type Json,
  type TaskTool,
} from './task-support.js';

const PRIVACY_NOTE = 'Occupational health and other health data are shown as statuses and dates only. Ask the user before fetching anything more detailed.';

function rows(r: CallOutcome): Json[] {
  return Array.isArray(r.data) ? r.data : [];
}

// ---------------------------------------------------------------------------------------------- hb_find_candidate

const findArgs = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(25).optional(),
  active_only: z.boolean().optional(),
  include_portals: z.boolean().optional(),
});

const ENRICH_MAX = 5;

function servicesWithRecords(detail: Json): { service: string; label: string; management: string; status: string }[] {
  const list: Json[] = Array.isArray(detail?.services) ? detail.services : [];
  return list
    .filter((s) => s && s.status !== 'not_required')
    .map((s) => ({ service: String(s.service), label: String(s.label ?? s.service), management: String(s.management ?? ''), status: String(s.status ?? '') }));
}

export function findCandidateTool(ctx: AppContext): TaskTool {
  return {
    availability: { allOf: ['hub'] },
    definition: {
      name: 'hb_find_candidate',
      description:
        'Find candidates by name, email, the client\'s own candidate reference, or a candidate_ref (uuid), in one call. Returns a compact table: candidate_ref, name, email, roles, compliance status, next expiry, and which portals have a record for the person. Uses hub.candidates.list (or .show for a uuid) plus hub.candidates.show for the first 5 matches. Read-only; needs hub:candidates:read. Say the result includes the operation ids called.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name, email, own candidate reference, or candidate_ref uuid. Every word must match. Max 100 characters.' },
          limit: { type: 'integer', description: 'Max candidates (default 10, max 25).' },
          active_only: { type: 'boolean', description: 'Only active candidates (default: inactive ones are listed too).' },
          include_portals: { type: 'boolean', description: 'Look up which portals have a record for each of the first 5 matches (default true).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Find a candidate', ...readOnlyHints() },
      handler: async (raw) => {
        const a = findArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        const q = a.data.query.trim();
        const limit = a.data.limit ?? 10;

        let found: Json[] = [];
        let total = 0;
        const details = new Map<string, Json>();
        if (UUID.test(q)) {
          const r = await run.get('hub.candidates.show', { path_params: { candidate_ref: q } });
          if (r.skipped || (!r.ok && r.status !== 404)) return taskFailure(ctx, run, 'hb_find_candidate', r);
          if (r.ok) {
            found = [r.data];
            details.set(q.toLowerCase(), r.data);
          }
          total = found.length;
        } else {
          const r = await run.get('hub.candidates.list', {
            query: { search: q, per_page: limit, sort: 'name', ...(a.data.active_only ? { is_active: 'true' } : {}) },
          });
          if (!r.ok) return taskFailure(ctx, run, 'hb_find_candidate', r);
          found = rows(r).slice(0, limit);
          total = Number(r.body?.meta?.total ?? found.length);
        }

        const enrich = a.data.include_portals !== false;
        if (enrich) {
          await Promise.all(
            found.slice(0, ENRICH_MAX).map(async (c) => {
              const ref = String(c.candidate_ref).toLowerCase();
              if (details.has(ref)) return;
              const d = await run.get('hub.candidates.show', { path_params: { candidate_ref: c.candidate_ref } });
              if (d.ok) details.set(ref, d.data);
            }),
          );
        }

        const candidates = found.map((c) => {
          const detail = details.get(String(c.candidate_ref).toLowerCase());
          return {
            candidate_ref: c.candidate_ref,
            name: c.name,
            email: c.email,
            roles: c.roles,
            own_reference: c.candidate_reference,
            is_active: c.is_active,
            compliance_status: c.compliance_status,
            next_expiry_date: c.next_expiry_date,
            portals: detail ? servicesWithRecords(detail) : undefined,
          };
        });

        const lines: string[] = [];
        if (candidates.length === 0) {
          lines.push(`No candidate matches "${q}". Try fewer words, the email address, or the client's own reference. Never guess a candidate_ref.`);
        } else {
          lines.push(`${total} candidate(s) match "${q}"${total > candidates.length ? ` (showing ${candidates.length})` : ''}:`);
          lines.push('candidate_ref | name | email | status | next expiry | portals with a record');
          for (const c of candidates) {
            const portals = c.portals ? (c.portals.length ? c.portals.map((p) => `${p.label}: ${p.status}`).join('; ') : 'none') : 'not looked up';
            lines.push(`${c.candidate_ref} | ${c.name} | ${c.email ?? '-'} | ${c.compliance_status ?? '-'} | ${day(c.next_expiry_date)} | ${portals}`);
          }
          if (candidates.length > 1) lines.push('Several people match: ask the user which one before doing anything for them.');
          if (enrich && candidates.length > ENRICH_MAX) lines.push(`Portal records were looked up for the first ${ENRICH_MAX} only. Use hb_candidate_overview for the rest.`);
          lines.push('Next: hb_candidate_overview with the candidate_ref for a one-line-per-record summary.');
        }
        lines.push(`Operations called: ${run.operationsCalled().join(', ')}.`);
        return taskResult(ctx, run, { lines, data: { query: q, total, shown: candidates.length, candidates } });
      },
    },
  };
}

function taskFailure(ctx: AppContext, run: TaskRun, tool: string, r: CallOutcome) {
  const lines = [`${tool} could not finish: ${why(r)}.`];
  if (r.error && !r.skipped) lines.push(r.error);
  return taskResult(ctx, run, { lines, data: { problem: why(r) } }, true);
}

// ---------------------------------------------------------------------------------------- hb_candidate_overview

const overviewArgs = z.object({ candidate_ref: z.string(), portals: z.array(z.string()).optional() });

interface PortalProbe {
  toolset: string;
  label: string;
  op: string;
  args: (ref: string) => Json;
  /** Lines for the records found. Never includes names, contact details, notes or health content. */
  summarise: (r: CallOutcome) => string[];
}

const LIST = (extra: Json = {}) => (ref: string) => ({ query: { candidate_ref: ref, per_page: 5, ...extra } });

const PROBES: PortalProbe[] = [
  {
    toolset: 'online-training',
    label: 'Online training',
    op: 'online-training.candidates.show',
    args: (ref) => ({ path_params: { candidate_ref: ref } }),
    summarise: (r) => {
      const d = r.data ?? {};
      return [`account ${d.account_status ?? '-'}; training ${d.training_status ?? '-'}; ${d.courses_completed ?? '?'}/${d.courses_assigned ?? '?'} courses completed, ${d.courses_expired ?? 0} expired; renewal ${d.renewal_mode ?? '-'}; completed ${day(d.completed_at)}, expires ${day(d.expires_at)}`];
    },
  },
  {
    toolset: 'practical-training',
    label: 'Practical training',
    op: 'practical-training.bookings.list',
    args: LIST({ sort: '-start_date' }),
    summarise: (r) => rows(r).map((b) => `${b.course?.name ?? 'course'} at ${b.location?.name ?? '-'}: ${b.booking_status ?? '-'}${b.attendance ? `, attendance ${b.attendance}` : ''}, ${when(b.start_date)}`),
  },
  {
    toolset: 'virtual-bls-training',
    label: 'Virtual BLS',
    op: 'virtual-bls-training.bookings.list',
    args: LIST({ sort: '-start_date' }),
    summarise: (r) => rows(r).map((b) => `${b.course?.name ?? 'course'}: ${b.booking_status ?? '-'}${b.attendance ? `, attendance ${b.attendance}` : ''}, ${when(b.start_date)}`),
  },
  {
    toolset: 'references',
    label: 'References',
    op: 'references.requests.list',
    args: LIST({ sort: '-created_at' }),
    summarise: (r) => rows(r).map((q) => `request ${q.status_label ?? q.status ?? '-'}: ${q.references_completed ?? '?'}/${q.references_required ?? '?'} references in, expires ${day(q.expires_at)}${q.is_expired ? ' (expired)' : ''}`),
  },
  {
    toolset: 'dbs-rtw',
    label: 'DBS and right to work',
    op: 'dbs-rtw.workers.list',
    args: LIST(),
    summarise: (r) =>
      rows(r).map((w) => `DBS ${w.dbs?.status_label ?? w.dbs?.status ?? '-'} (checked ${day(w.dbs?.last_checked_at)}, next ${day(w.dbs?.next_check_due_at)}); right to work ${w.rtw?.status_label ?? w.rtw?.status ?? '-'} (expires ${day(w.rtw?.expiry_date)}); ${w.compliant ? 'compliant' : 'not compliant'}`),
  },
  {
    toolset: 'registration-monitoring',
    label: 'Registration monitoring',
    op: 'registration-monitoring.workers.list',
    args: LIST(),
    summarise: (r) =>
      rows(r).map((w) => `${String(w.regulator ?? '').toUpperCase() || 'regulator'} registration ${w.status_label ?? w.status ?? '-'}${w.has_warning ? ', warning' : ''}${w.has_condition ? ', conditions' : ''}; expires ${day(w.expiry_date)}; last checked ${day(w.last_checked_at)}, next ${day(w.next_check_due_at)}`),
  },
  {
    toolset: 'clinical-appraisals',
    label: 'Clinical appraisals',
    op: 'clinical-appraisals.bookings.list',
    args: LIST({ sort: '-created_at' }),
    summarise: (r) => rows(r).map((b) => `${b.appraisal_type?.name ?? 'appraisal'}: ${b.appraisal_status_label ?? b.appraisal_status ?? '-'}, booking ${b.booking_status ?? '-'}, ${when(b.start_date)}`),
  },
  {
    toolset: 'clinical-interviews',
    label: 'Clinical interviews',
    op: 'clinical-interviews.bookings.list',
    args: LIST({ sort: '-start_date' }),
    summarise: (r) => rows(r).map((b) => `${b.interview_type?.name ?? 'interview'}: ${b.interview_status ?? '-'}, booking ${b.booking_status ?? '-'}, ${when(b.start_date)}`),
  },
  {
    toolset: 'training-verification',
    label: 'Training verification',
    op: 'training-verification.verifications.list',
    args: LIST({ sort: '-created_at' }),
    // Linked through candidate_ref: status, type, reason code and dates only. No certificate, courses found, email or name.
    summarise: (r) => rows(r).map((v) => `verification #${v.id} (${v.request_type ?? '-'}): ${v.status ?? '-'}${v.result?.reason?.code ? `, reason ${v.result.reason.code}` : ''}${v.client_reference ? `, ref ${v.client_reference}` : ''}; created ${day(v.created_at)}, completed ${day(v.completed_at)}`),
  },
  {
    toolset: 'occupational-health',
    label: 'Occupational health',
    op: 'occupational-health.requests.list',
    args: LIST({ sort: '-submitted' }),
    // Statuses and dates only: no clearance type, form, outcome document, answers, name or email.
    summarise: (r) => rows(r).map((q) => `${q.request_type_label ?? q.request_type ?? 'request'}: ${q.status_label ?? q.status ?? '-'}; submitted ${day(q.submitted_at)}, completed ${day(q.completed_at)}, decided ${day(q.decided_at)}`),
  },
];

export function candidateOverviewTool(ctx: AppContext): TaskTool {
  return {
    availability: { allOf: ['hub'] },
    definition: {
      name: 'hb_candidate_overview',
      description:
        'One-call summary of a candidate across every portal the key can reach: online training, practical training, virtual BLS, references, DBS and right to work, registration monitoring, clinical appraisals, clinical interviews, certificate verifications (training verification, linked by candidate_ref) and occupational health. One line per record with status and dates. Checks the key\'s scopes first, calls only what is allowed, and says which portals were skipped and why. Occupational health is statuses and dates only (never answers, clearance detail or documents). Read-only. Needs hub:candidates:read plus the portal read scopes you want.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_ref: { type: 'string', description: 'The candidate_ref uuid (find it with hb_find_candidate).' },
          portals: { type: 'array', items: { type: 'string' }, description: 'Optional: only these portals (toolset names such as "practical-training"). Default all.' },
        },
        required: ['candidate_ref'],
        additionalProperties: false,
      },
      annotations: { title: 'Candidate overview', ...readOnlyHints() },
      handler: async (raw) => {
        const a = overviewArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const ref = a.data.candidate_ref.trim().toLowerCase();
        if (!UUID.test(ref)) return refusal('candidate_ref must be a uuid. Find the person first with hb_find_candidate; never guess a candidate_ref.');
        const wanted = a.data.portals?.map((p) => p.toLowerCase());
        const unknownPortals = wanted?.filter((p) => !PROBES.some((x) => x.toolset === p));
        if (unknownPortals?.length) return refusal(`Unknown portal(s): ${unknownPortals.join(', ')}. Valid: ${PROBES.map((p) => p.toolset).join(', ')}.`);

        const run = new TaskRun(ctx);
        await run.loadKey();
        const hub = await run.get('hub.candidates.show', { path_params: { candidate_ref: ref } });
        if (!hub.ok) return taskFailure(ctx, run, 'hb_candidate_overview', hub);
        const c = hub.data ?? {};

        const probes = PROBES.filter((p) => !wanted || wanted.includes(p.toolset));
        const results = await Promise.all(probes.map(async (p) => ({ p, r: await run.get(p.op, p.args(ref)) })));

        const lines: string[] = [];
        lines.push(`${c.name ?? 'Candidate'} (${ref})${c.is_active === false ? ' [inactive]' : ''}: compliance ${c.compliance_status ?? '-'}, next expiry ${day(c.next_expiry_date)}${Array.isArray(c.roles) && c.roles.length ? `, roles ${c.roles.join(', ')}` : ''}.`);
        if (c.compliance) lines.push(`Compliance items: ${c.compliance.compliant ?? 0} compliant, ${c.compliance.expiring_soon ?? 0} expiring soon, ${c.compliance.expired ?? 0} expired.`);

        const services = servicesWithRecords(c);
        if (services.length) {
          lines.push('Services (Hub): ' + services.map((s) => `${s.label} ${s.status}${s.management ? ` (${s.management} managed)` : ''}`).join('; ') + '.');
        }

        const records: Record<string, string[]> = {};
        const skipped: { portal: string; reason: string }[] = [];
        const noRecord: string[] = [];
        for (const { p, r } of results) {
          if (r.ok) {
            const found = p.summarise(r);
            if (found.length === 0) noRecord.push(p.label);
            else {
              records[p.toolset] = found;
              lines.push(`${p.label}:`);
              for (const line of found) lines.push(`  - ${line}`);
            }
          } else if (r.status === 404) {
            noRecord.push(p.label);
          } else if (isUnavailable(r)) {
            skipped.push({ portal: p.label, reason: why(r) });
          } else {
            skipped.push({ portal: p.label, reason: `could not read: ${why(r)}` });
          }
        }
        if (noRecord.length) lines.push(`No record: ${noRecord.join(', ')}.`);
        if (skipped.length) lines.push(`Skipped: ${skipped.map((s) => `${s.portal} (${s.reason})`).join('; ')}.`);
        if (results.some(({ p }) => p.toolset === 'occupational-health')) lines.push(PRIVACY_NOTE);
        lines.push(`Operations called: ${run.operationsCalled().join(', ')}.`);
        return taskResult(ctx, run, {
          lines,
          data: {
            candidate: { candidate_ref: ref, name: c.name, is_active: c.is_active, compliance_status: c.compliance_status, next_expiry_date: c.next_expiry_date, roles: c.roles },
            services,
            records,
            no_record: noRecord,
            skipped_portals: skipped,
            privacy: PRIVACY_NOTE,
          },
        });
      },
    },
  };
}

// ----------------------------------------------------------------------------------------- hb_account_summary

const CREDIT_PORTALS: { toolset: string; label: string; op: string }[] = [
  { toolset: 'online-training', label: 'Online training', op: 'online-training.credits.show' },
  { toolset: 'occupational-health', label: 'Occupational health', op: 'occupational-health.credits.show' },
  { toolset: 'practical-training', label: 'Practical training', op: 'practical-training.credits.show' },
  { toolset: 'virtual-bls-training', label: 'Virtual BLS', op: 'virtual-bls-training.credits.show' },
  { toolset: 'clinical-interviews', label: 'Clinical interviews', op: 'clinical-interviews.credits.show' },
  { toolset: 'clinical-appraisals', label: 'Clinical appraisals', op: 'clinical-appraisals.credits.show' },
  { toolset: 'training-verification', label: 'Training verification', op: 'training-verification.credits.show' },
];

const sum = (list: unknown): number => (Array.isArray(list) ? list.reduce((t: number, x: Json) => t + (Number(x?.credits) || 0), 0) : 0);

function creditLine(d: Json): string {
  const parts: string[] = [];
  if (typeof d.balance === 'number') parts.push(`balance ${d.balance} credits`);
  if (typeof d.used_this_month === 'number') parts.push(`used this month ${d.used_this_month}`);
  if (Array.isArray(d.booking_credits)) parts.push(`${sum(d.booking_credits)} booking credits`);
  if (Array.isArray(d.interview_type_group_credits) && d.interview_type_group_credits.length) parts.push(`${sum(d.interview_type_group_credits)} group credits`);
  const pence = d.booking_balance_pence ?? d.booking_money_balance_pence ?? d.money_pence;
  if (typeof pence === 'number') parts.push(`money balance ${money(pence, d.currency)}`);
  if (typeof d.auto_credits === 'number') parts.push(`${d.auto_credits} automated verification credit(s)`);
  if (typeof d.manual_credits === 'number') parts.push(`${d.manual_credits} manual verification credit(s)`);
  if (typeof d.legacy_balance_pence === 'number') parts.push(`older balance ${money(d.legacy_balance_pence, d.currency)}`);
  return parts.join(', ') || 'no balance information';
}

export type EndpointHealth = 'healthy' | 'failing' | 'disabled';

export function endpointHealth(e: Json): EndpointHealth {
  if (e.is_active === false) return 'disabled';
  return Number(e.consecutive_failures) > 0 ? 'failing' : 'healthy';
}

const DELIVERY_ENDPOINT_MAX = 5;

export function accountSummaryTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: ['account', 'online-training', 'occupational-health', 'practical-training', 'virtual-bls-training', 'clinical-interviews', 'clinical-appraisals', 'training-verification'] },
    definition: {
      name: 'hb_account_summary',
      description:
        'One compact answer about the account: the key (name, expiry, scopes), credit and balance figures for every portal the key can read, and the webhook endpoints with health (active, consecutive failures, last response) and the latest deliveries of up to 5 endpoints. Credits are units; money is shown as an amount in the currency. Read-only. Uses auth.me.show, each portal credits.show, webhooks.endpoints.list and webhooks.deliveries.list as the key allows. Webhook URLs are shown without query strings.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Account summary', ...readOnlyHints() },
      handler: async () => {
        const run = new TaskRun(ctx);
        const key = await run.loadKey();
        const lines: string[] = [`Environment: ${ctx.config.mode.toUpperCase()} (${ctx.config.baseUrl}).`];
        if (key) {
          lines.push(`Key: ${key.name ?? '-'} (${key.prefix ?? '-'}), expires ${key.expires_at ? day(key.expires_at) : 'never'}, ${(key.scopes ?? []).length} scope(s): ${(key.scopes ?? []).join(', ') || 'none'}.`);
        } else {
          lines.push('Key: could not be read (auth.me.show failed). Run hb_status.');
        }

        const credits = await Promise.all(
          CREDIT_PORTALS.map(async (p) => ({ p, r: await run.get(p.op, {}) })),
        );
        const creditData: Record<string, unknown> = {};
        const skipped: { what: string; reason: string }[] = [];
        for (const { p, r } of credits) {
          if (r.ok) {
            lines.push(`${p.label}: ${creditLine(r.data ?? {})}.`);
            creditData[p.toolset] = r.data;
          } else skipped.push({ what: `${p.label} credits`, reason: why(r) });
        }

        const hooks = await run.get('webhooks.endpoints.list', { query: { per_page: 100 } });
        let endpoints: Json[] = [];
        const deliveries: Record<string, Json[]> = {};
        if (hooks.ok) {
          endpoints = rows(hooks).map((e) => ({
            id: e.id, name: e.name, url: safeUrl(e.url), events: Array.isArray(e.events) ? e.events.length : 0, is_active: e.is_active,
            health: endpointHealth(e), consecutive_failures: e.consecutive_failures ?? 0, last_response_code: e.last_response_code ?? null, last_delivered_at: e.last_delivered_at ?? null,
          }));
          lines.push(endpoints.length ? `Webhook endpoints (${endpoints.length}):` : 'Webhook endpoints: none registered.');
          for (const e of endpoints) {
            lines.push(`  - #${e.id} ${e.name}: ${e.health}${e.consecutive_failures ? ` (${e.consecutive_failures} failed in a row)` : ''}, ${e.events} event(s), ${e.url}, last response ${e.last_response_code ?? '-'} at ${when(e.last_delivered_at)}`);
          }
          const shown = endpoints.slice(0, DELIVERY_ENDPOINT_MAX);
          const recent = await Promise.all(shown.map(async (e) => ({ e, r: await run.get('webhooks.deliveries.list', { path_params: { webhook: e.id }, query: { per_page: 5, sort: '-id' } }) })));
          for (const { e, r } of recent) {
            if (!r.ok) {
              skipped.push({ what: `deliveries of #${e.id}`, reason: why(r) });
              continue;
            }
            const list = rows(r).map((d) => ({ id: d.id, event_type: d.event_type, status: d.status, attempt: d.attempt, response_code: d.response_code, at: d.delivered_at ?? d.created_at }));
            deliveries[String(e.id)] = list;
            if (list.length) lines.push(`    recent for #${e.id}: ` + list.map((d) => `${d.event_type} ${d.status}${d.response_code ? ` ${d.response_code}` : ''}`).join('; '));
          }
          if (endpoints.length > DELIVERY_ENDPOINT_MAX) lines.push(`Deliveries shown for the first ${DELIVERY_ENDPOINT_MAX} endpoints only.`);
        } else skipped.push({ what: 'webhook endpoints', reason: why(hooks) });

        if (skipped.length) lines.push(`Skipped: ${skipped.map((s) => `${s.what} (${s.reason})`).join('; ')}.`);
        lines.push(`Operations called: ${run.operationsCalled().join(', ')}.`);
        return taskResult(ctx, run, {
          lines,
          data: { key: key ? { name: key.name, prefix: key.prefix, expires_at: key.expires_at ?? null, scopes: key.scopes } : null, credits: creditData, webhook_endpoints: endpoints, recent_deliveries: deliveries, skipped },
        });
      },
    },
  };
}

// ----------------------------------------------------------------------------------------- hb_needs_attention

const SAMPLE = 5;
const PENDING_STUCK_MS = 60 * 60 * 1000;

interface Finding {
  area: string;
  count: number;
  summary: string;
  action: string;
  examples: string[];
}

export function needsAttentionTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: ['account', 'online-training', 'occupational-health', 'practical-training', 'virtual-bls-training', 'clinical-interviews', 'clinical-appraisals', 'references', 'dbs-rtw', 'registration-monitoring', 'training-verification'] },
    definition: {
      name: 'hb_needs_attention',
      description:
        'What needs action right now, built only from what the API exposes and the key can read: failed or disabled webhook endpoints, unacknowledged DBS/RTW and registration alerts, bookings awaiting payment (practical, virtual BLS, clinical interviews, clinical appraisals), appraisals awaiting documents, expired or lapsing online training, expired reference requests, certificate verifications that failed or have been pending for over an hour (training verification), and occupational health counts (awaiting candidate, rejected or failed; counts only, no health detail). Read-only. Portals the key cannot read are listed as skipped.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'What needs attention', ...readOnlyHints() },
      handler: async () => {
        const run = new TaskRun(ctx);
        await run.loadKey();
        const findings: Finding[] = [];
        const skipped: { what: string; reason: string }[] = [];
        const checked: string[] = [];
        const note = (what: string, r: CallOutcome): void => {
          skipped.push({ what, reason: why(r) });
        };

        const jobs: Promise<void>[] = [];

        jobs.push((async () => {
          const r = await run.get('webhooks.endpoints.list', { query: { per_page: 100 } });
          if (!r.ok) return note('webhook endpoints', r);
          checked.push('webhooks');
          const bad = rows(r).filter((e) => endpointHealth(e) !== 'healthy');
          if (bad.length) {
            findings.push({
              area: 'webhooks', count: bad.length,
              summary: `${bad.length} webhook endpoint(s) are failing or switched off`,
              action: 'Fix the receiver, then switch the endpoint on (PUT with is_active true resets the failure count) and send a test event. Hub switches an endpoint off after 25 failures in a row.',
              examples: bad.slice(0, SAMPLE).map((e) => `#${e.id} ${e.name}: ${endpointHealth(e)}${e.consecutive_failures ? `, ${e.consecutive_failures} failed in a row` : ''}, last response ${e.last_response_code ?? '-'}`),
            });
          }
        })());

        const pending = (area: string, op: string, label: string, pick: (b: Json) => boolean, line: (b: Json) => string, action: string, extra: Json = {}) =>
          jobs.push((async () => {
            const r = await run.get(op, { query: { per_page: 25, ...extra } });
            if (!r.ok) return note(area, r);
            checked.push(area);
            const hit = rows(r).filter(pick);
            if (hit.length) findings.push({ area, count: hit.length, summary: `${hit.length} ${label}`, action, examples: hit.slice(0, SAMPLE).map(line) });
          })());

        pending('practical-training', 'practical-training.bookings.list', 'practical training booking(s) awaiting candidate payment', (b) => b.booking_status === 'pending',
          (b) => `#${b.id} ${b.candidate_name ?? b.candidate_ref}: ${b.course?.name ?? 'course'} on ${day(b.start_date)}`, 'The candidate has an emailed payment link; remind them. Until paid the booking holds no seat.', { status: 'pending' });
        pending('virtual-bls-training', 'virtual-bls-training.bookings.list', 'virtual BLS booking(s) awaiting payment', (b) => b.booking_status === 'pending',
          (b) => `#${b.id} ${b.candidate_name ?? b.candidate_ref}: ${b.course?.name ?? 'course'} on ${day(b.start_date)}`, 'Chase the candidate to pay.', { status: 'pending' });
        pending('clinical-interviews', 'clinical-interviews.bookings.list', 'clinical interview booking(s) awaiting payment', (b) => b.booking_status === 'pending',
          (b) => `#${b.id} ${b.candidate_name ?? b.candidate_ref}: ${b.interview_type?.name ?? 'interview'} on ${day(b.start_date)}`, 'Chase the candidate to pay.', { status: 'pending' });
        pending('clinical-appraisals (payment)', 'clinical-appraisals.bookings.list', 'clinical appraisal booking(s) awaiting payment', (b) => b.booking_status === 'pending',
          (b) => `#${b.id} ${b.candidate_name ?? b.candidate_ref}: ${b.appraisal_type?.name ?? 'appraisal'}`, 'Chase the candidate to pay (the booking has a payment_url).', { status: 'pending' });
        pending('clinical-appraisals (documents)', 'clinical-appraisals.bookings.list', 'clinical appraisal(s) awaiting documents', (b) => b.appraisal_status === 'pending_docs',
          (b) => `#${b.id} ${b.candidate_name ?? b.candidate_ref}: ${b.appraisal_type?.name ?? 'appraisal'}`, 'The candidate must submit documents before a slot can be booked.', { appraisal_status: 'pending_docs' });
        pending('training-verification (failed)', 'training-verification.verifications.list', 'certificate verification(s) failed', (v) => v.status === 'failed',
          (v) => `#${v.id} ${v.candidate_name ?? '-'} (${v.request_type}): failed${v.result?.reason?.code ? `, ${v.result.reason.code}` : ''}, ${day(v.created_at)}`, 'The automated check failed for a system reason. Submit the certificate again with hb_verify_certificate, or contact support with the verification id and request_id.', { status: 'failed', sort: '-created_at' });
        pending('training-verification (stuck pending)', 'training-verification.verifications.list', 'certificate verification(s) still pending after an hour', (v) => v.status === 'pending' && Date.now() - Date.parse(String(v.created_at)) > PENDING_STUCK_MS,
          (v) => `#${v.id} ${v.candidate_name ?? '-'} (${v.request_type}): pending since ${when(v.created_at)}`, 'A verification normally starts within minutes. Check it with hb_verification_status; if it stays pending, cancel it (hb_change_booking, portal training-verification, refunded) and submit again, or contact support.', { status: 'pending', sort: 'created_at' });
        pending('registration-monitoring', 'registration-monitoring.alerts.list', 'unacknowledged registration alert(s)', (x) => x.acknowledged === false,
          (x) => `#${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.worker?.name ?? 'worker'} (${day(x.created_at)})`, 'Review and acknowledge each alert.', { acknowledged: 'false', sort: '-severity' });
        pending('dbs-rtw', 'dbs-rtw.alerts.list', 'unacknowledged DBS or right to work alert(s)', (x) => x.acknowledged === false,
          (x) => `#${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.worker?.name ?? 'worker'} (${day(x.created_at)})`, 'Review and acknowledge each alert.', { acknowledged: 'false', sort: '-severity' });
        pending('references', 'references.requests.list', 'reference request(s) expired without all references', (x) => x.is_expired === true && x.is_fully_referenced !== true,
          (x) => `${x.uuid}: ${x.references_completed ?? '?'}/${x.references_required ?? '?'} references, expired ${day(x.expires_at)}`, 'Extend the request or cancel it.', { is_expired: 'true' });

        jobs.push((async () => {
          const r = await run.get('online-training.dashboard.show', {});
          if (!r.ok) return note('online-training', r);
          checked.push('online-training');
          const d = r.data ?? {};
          const items: Json[] = Array.isArray(d.needs_attention) ? d.needs_attention : [];
          if (items.length) {
            findings.push({
              area: 'online-training', count: items.length,
              summary: `${items.length} online training candidate(s) need attention (${d.tiles?.expired ?? 0} expired, ${d.tiles?.expiring_soon ?? 0} expiring soon)`,
              action: 'Remind the candidates or renew their courses.',
              examples: items.slice(0, SAMPLE).map((i) => `${i.name ?? i.candidate_ref}: ${i.detail ?? i.status}`),
            });
          }
        })());

        jobs.push((async () => {
          const r = await run.get('occupational-health.requests.stats', {});
          if (!r.ok) return note('occupational-health', r);
          checked.push('occupational-health');
          const s = r.data ?? {};
          const waiting = Number(s.awaiting_candidate) || 0;
          const bad = Number(s.rejected_or_fail) || 0;
          if (waiting + bad > 0) {
            findings.push({
              area: 'occupational-health', count: waiting + bad,
              summary: `Occupational health: ${waiting} awaiting the candidate, ${bad} rejected or failed (counts only)`,
              action: 'Open these in the Hub to chase candidates or decide next steps. Health detail is deliberately not fetched here.',
              examples: [],
            });
          }
        })());

        await Promise.all(jobs);
        findings.sort((x, y) => x.area.localeCompare(y.area));

        const lines: string[] = [];
        if (findings.length === 0) lines.push(`Nothing needs attention in what this key can see (checked: ${checked.join(', ') || 'nothing'}).`);
        else {
          lines.push(`${findings.length} area(s) need attention:`);
          for (const f of findings) {
            lines.push(`- ${f.summary}. ${f.action}`);
            for (const e of f.examples) lines.push(`    ${e}`);
            if (f.count > f.examples.length && f.examples.length) lines.push(`    …and ${f.count - f.examples.length} more`);
          }
        }
        if (skipped.length) lines.push(`Not checked: ${skipped.map((s) => `${s.what} (${s.reason})`).join('; ')}.`);
        lines.push(`Operations called: ${run.operationsCalled().join(', ')}.`);
        return taskResult(ctx, run, { lines, data: { checked, findings, not_checked: skipped } });
      },
    },
  };
}

// ----------------------------------------------------------------------------------------------- hb_go_live_check

const goLiveArgs = z.object({ portals: z.array(z.enum(TOOLSETS)).optional() });

type Level = 'OK' | 'WARN' | 'FAIL' | 'NOTE';

const LOCAL_HOST = /(^|\.)(localhost|local|test|invalid|example)$|^127\.|^10\.|^192\.168\.|ngrok|loca\.lt|trycloudflare|webhook\.site|requestbin/i;

export function goLiveCheckTool(ctx: AppContext): TaskTool {
  return {
    availability: {},
    definition: {
      name: 'hb_go_live_check',
      description:
        'Read-only go-live readiness report: environment, key scopes against the portals you say you need (optional `portals`), wildcard and expiry warnings, sandbox-versus-live mismatches, webhook endpoints present and healthy, the IP allowlist (the API does not show it: says so), and the remaining manual steps from the going-live guide (hb://guides/going-live). Sends only reads.',
      inputSchema: {
        type: 'object',
        properties: {
          portals: { type: 'array', items: { type: 'string', enum: [...TOOLSETS] }, description: 'Portals (toolsets) the integration needs, for example ["hub","practical-training","account"]. Webhook management is "account".' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Go-live check', ...readOnlyHints() },
      handler: async (raw) => {
        const a = goLiveArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        const key = await run.loadKey();
        const findings: { level: Level; text: string }[] = [];
        const add = (level: Level, text: string) => findings.push({ level, text });
        const c = ctx.config;

        add('NOTE', `Environment: ${c.mode.toUpperCase()} (${c.baseUrl}), detected from ${c.modeSource}.`);
        if (c.mode === 'sandbox') add('WARN', 'This server points at a SANDBOX, so this check describes the sandbox key. Going live needs a new live key, HB_BASE_URL set to https://hub.hbcompliance.co.uk (or removed), and new webhook endpoints with their own secrets.');
        if (c.modeSource === 'unrecognised-host') add('WARN', 'The base URL is not a known sandbox, so it is treated as LIVE. If it is a sandbox, set HB_ENV=sandbox.');
        if (c.mode === 'live' && c.readOnly) add('OK', 'The server is read-only (HB_READ_ONLY=true): keep it so until the owner is ready for live writes.');
        if (c.mode === 'live' && !c.readOnly) add(c.allowLiveWrites ? 'WARN' : 'NOTE', c.allowLiveWrites ? 'Live writes are ENABLED (HB_ALLOW_LIVE_WRITES=true). Every write still needs a plan and confirm=true.' : 'HB_READ_ONLY=false but live writes are not allowed (HB_ALLOW_LIVE_WRITES is not true).');

        const scopes = key?.scopes ?? [];
        if (!key) {
          add('FAIL', 'The key could not be read (auth.me.show failed). Run hb_status and fix the key first.');
        } else {
          const test = String(key.prefix ?? '').startsWith('hbk_test');
          if (test && c.mode === 'live') add('FAIL', 'Mismatch: a sandbox test key (hbk_test_) is configured against a URL treated as LIVE.');
          else if (!test && c.mode === 'sandbox') add('FAIL', 'Mismatch: a live key is configured against a URL treated as sandbox. Do not send a live key to a sandbox.');
          else add('OK', `The key type matches the environment (${test ? 'test key' : 'live key'}).`);

          const wild = scopes.filter((s) => s === '*' || s.endsWith(':*'));
          add(wild.length ? 'WARN' : 'OK', wild.length ? `The key has wildcard scope(s): ${wild.join(', ')}. Use exact scopes in production.` : 'No wildcard scopes.');
          add(key.expires_at ? 'OK' : 'WARN', key.expires_at ? `The key expires ${day(key.expires_at)}. Set a reminder to replace it before then.` : 'The key has no expiry date. Consider one.');

          const needed = a.data.portals;
          if (needed?.length) {
            const covers = (p: string) => scopes.includes('*') || scopes.some((s) => s.startsWith(`${p}:`));
            for (const p of needed) {
              if (covers(p)) {
                const own = scopes.filter((s) => s.startsWith(`${p}:`));
                add('OK', `${p}: the key has ${own.length ? own.join(', ') : '*'}.`);
              } else add('FAIL', `${p}: the key has no scope for this portal.`);
            }
            if (!scopes.includes('*')) {
              const extra = [...new Set(scopes.map((s) => s.split(':')[0] ?? ''))].filter((p) => p && !needed.includes(p as (typeof TOOLSETS)[number]));
              if (extra.length) add('WARN', `The key also reaches portals you did not list: ${extra.join(', ')}. Remove scopes it does not need (least privilege).`);
            }
          } else {
            add('NOTE', `Scopes held: ${scopes.join(', ') || 'none'}. Pass \`portals\` to compare them with what the integration needs.`);
          }
        }

        add('NOTE', 'IP allowlist: the API does not show it. Check it on the Developer page. With the stdio transport, calls leave from the machine running this server, so that machine\'s public IP is what the allowlist sees.');

        const tvScopes = scopes.filter((s) => s.startsWith('training-verification:'));
        if (key && (a.data.portals?.includes('training-verification') || tvScopes.length)) {
          const canWrite = scopes.includes('*') || tvScopes.some((s) => s === 'training-verification:write' || s === 'training-verification:*');
          add(canWrite ? 'OK' : 'NOTE', canWrite ? 'Training Verification: the key can submit and cancel certificate verifications (training-verification:write, which also reads).' : 'Training Verification: the key can only read. Submitting or cancelling a verification needs training-verification:write.');
          add('NOTE', 'Training Verification pricing: Automated is free for a regular account (one that also uses other Hub services) and charged for a verification-only account; Manual is charged for every account; only credits and the wallet pay (no card), and a shortfall is 402 insufficient_credits, so check the balance before going live. Webhooks: training-verification.submitted, .processing, .verified, .not_found, .rejected, .failed and .refunded, each once per verification.');
          if (run.blocker('training-verification.pricing.show') === undefined) {
            const price = await run.get('training-verification.pricing.show', {});
            if (price.ok) {
              const prices: Json[] = price.data?.prices ?? price.data?.request_types ?? [];
              add('NOTE', `Training Verification prices for this account (${price.data?.client_type ?? 'unknown'} account): ${Array.isArray(prices) && prices.length ? prices.map((p) => `${p.request_type} ${p.free ? 'free' : `${money(p.gross_pence, p.currency)} incl. VAT`}`).join(', ') : 'not listed'}.`);
            } else add('WARN', `Training Verification pricing could not be read (${why(price)}).`);
          }
        }

        const hooks = await run.get('webhooks.endpoints.list', { query: { per_page: 100 } });
        let endpoints: Json[] = [];
        if (hooks.ok) {
          endpoints = rows(hooks);
          if (endpoints.length === 0) add('WARN', 'No webhook endpoint is registered (fine if the integration does not use webhooks).');
          else if (!endpoints.some((e) => e.is_active)) add('FAIL', 'No active webhook endpoint.');
          else add('OK', 'At least one active webhook endpoint.');
          for (const e of endpoints) {
            const label = `#${e.id} ${e.name} (${safeUrl(e.url)})`;
            let host = '';
            try { host = new URL(String(e.url)).hostname; } catch { /* reported below */ }
            if (!String(e.url).startsWith('https://')) add('FAIL', `${label} does not use https.`);
            if (e.is_active === false) add('FAIL', `${label} is switched off.`);
            if (Number(e.consecutive_failures) > 0) add('WARN', `${label} has ${e.consecutive_failures} failed deliveries in a row (Hub switches an endpoint off at 25).`);
            if (c.mode === 'live' && host && LOCAL_HOST.test(host)) add('WARN', `${label} looks like a test address while this is LIVE.`);
            if (c.mode === 'sandbox' && host && !LOCAL_HOST.test(host)) add('NOTE', `${label} points at ${host}: when you go live register the production receiver as a new endpoint (a new secret).`);
          }
        } else add('WARN', `Webhook endpoints were not checked (${why(hooks)}).`);

        const remaining = [
          'Store the live key in a secret store or server environment variable, never in code or logs (guide step 3).',
          'Register the live webhook endpoint, keep its new signing secret, verify signatures on the raw body, answer 2xx quickly, dedupe on the event id, and send a test event (step 5; hb_setup_sandbox_webhook does this in a sandbox only).',
          'Send an Idempotency-Key on every create and reuse it on retry (step 6).',
          'Handle errors by code; retry only network failures, 429 after Retry-After and 5xx with backoff (step 7).',
          'Know the key\'s hourly limit (1,000 calls by default) and prefer webhooks to polling (step 8).',
          'Log request_id on every error and alert on rising 401/403/5xx, any 429 and failing webhooks (step 9).',
          'If you touch occupational health, clinical, reference or training certificate data (a Training Verification certificate carries the candidate\'s name and training record), check your own data protection handling (step 10; hb://guides/health-data-and-privacy).',
          'Decide who may create and rotate keys (the Developer role) and how to rotate a key and a secret without downtime (step 11).',
          'Full checklist: hb://guides/going-live.',
        ];

        const failures = findings.filter((f) => f.level === 'FAIL').length;
        const warnings = findings.filter((f) => f.level === 'WARN').length;
        const lines = [
          `Go-live readiness: ${failures} to fix, ${warnings} warning(s).`,
          ...findings.map((f) => `${f.level.padEnd(5)} ${f.text}`),
          'Remaining manual steps:',
          ...remaining.map((r, i) => `${i + 1}. ${r}`),
          `Operations called: ${run.operationsCalled().join(', ')}.`,
        ];
        return taskResult(ctx, run, { lines, data: { ready: failures === 0, failures, warnings, findings, remaining_steps: remaining } });
      },
    },
  };
}

export const READ_TASKS = [findCandidateTool, candidateOverviewTool, accountSummaryTool, needsAttentionTool, goLiveCheckTool];
export { isTaskAvailable };
