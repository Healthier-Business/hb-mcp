import { z } from 'zod';
import type { AppContext } from '../context.js';
import { endpointHealth } from './tasks-read.js';
import {
  UUID,
  day,
  isUnavailable,
  money,
  readOnlyHints,
  refusal,
  rows,
  safeUrl,
  taskResult,
  when,
  why,
  TaskRun,
  type CallOutcome,
  type Json,
  type TaskTool,
} from './task-support.js';

const PORTAL_LABELS: Record<string, string> = {
  'online-training': 'Online training',
  'practical-training': 'Practical training',
  'virtual-bls-training': 'Virtual BLS',
  'clinical-interviews': 'Clinical interviews',
  'clinical-appraisals': 'Clinical appraisals',
  'occupational-health': 'Occupational health',
  'dbs-rtw': 'DBS and right to work',
  'registration-monitoring': 'Registration monitoring',
};

function problem(ctx: AppContext, run: TaskRun, tool: string, r: CallOutcome) {
  return taskResult(ctx, run, { lines: [`${tool} could not finish: ${why(r)}.`, ...(r.error && !r.skipped ? [r.error] : [])], data: { problem: why(r) } }, true);
}

function skippedLine(skipped: { what: string; reason: string }[]): string[] {
  return skipped.length ? [`Skipped: ${skipped.map((s) => `${s.what} (${s.reason})`).join('; ')}.`] : [];
}

const done = (run: TaskRun): string => `Operations called: ${run.operationsCalled().join(', ')}.`;

// ------------------------------------------------------------------------------------- hb_training_progress

const progressArgs = z.object({
  candidate_ref: z.string(),
  course_id: z.number().int().optional(),
  include_modules: z.boolean().optional(),
  include_practical: z.boolean().optional(),
  available_courses: z.boolean().optional(),
  search: z.string().max(100).optional(),
});

export function trainingProgressTool(ctx: AppContext): TaskTool {
  return {
    availability: { allOf: ['online-training'] },
    definition: {
      name: 'hb_training_progress',
      description:
        'Online training for one candidate in one call: the account summary, every course with status, grade, dates and certificate availability, the modules (counted by status per course), and the practical results. `course_id` adds the full result of one course; `available_courses` lists the courses the account can assign. Read-only. Uses online-training.candidates.show, .results, .results.show, .modules, .practical-results and online-training.courses.list.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_ref: { type: 'string', description: 'The candidate_ref uuid (find it with hb_find_candidate).' },
          course_id: { type: 'integer', description: 'Show the full result of this course.' },
          include_modules: { type: 'boolean', description: 'Include module progress (default true).' },
          include_practical: { type: 'boolean', description: 'Include practical results (default true).' },
          available_courses: { type: 'boolean', description: 'Also list the course catalogue (courses.list).' },
          search: { type: 'string', description: 'With available_courses: part of a course name.' },
        },
        required: ['candidate_ref'],
        additionalProperties: false,
      },
      annotations: { title: 'Training progress', ...readOnlyHints() },
      handler: async (raw) => {
        const a = progressArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const ref = a.data.candidate_ref.trim().toLowerCase();
        if (!UUID.test(ref)) return refusal('candidate_ref must be a uuid. Find the person first with hb_find_candidate.');
        const run = new TaskRun(ctx);
        await run.loadKey();
        const p = { path_params: { candidate_ref: ref } };
        const [summary, results, modules, practical, detail, catalogue] = await Promise.all([
          run.get('online-training.candidates.show', p),
          run.get('online-training.candidates.results', { ...p, query: { per_page: 100, sort: 'course_name' } }),
          a.data.include_modules === false ? undefined : run.get('online-training.candidates.modules', { ...p, query: { per_page: 100 } }),
          a.data.include_practical === false ? undefined : run.get('online-training.candidates.practical-results', { ...p, query: { per_page: 50 } }),
          a.data.course_id === undefined ? undefined : run.get('online-training.candidates.results.show', { path_params: { candidate_ref: ref, course_id: a.data.course_id } }),
          a.data.available_courses ? run.get('online-training.courses.list', { query: { per_page: 100, ...(a.data.search ? { search: a.data.search } : {}) } }) : undefined,
        ]);
        if (!summary.ok && summary.status === 404) return taskResult(ctx, run, { lines: [`No online training record for ${ref}. Assign courses first (hb_assign_training).`, done(run)], data: { found: false } });
        if (!summary.ok && !results.ok) return problem(ctx, run, 'hb_training_progress', summary);

        const lines: string[] = [];
        const skipped: { what: string; reason: string }[] = [];
        const s = summary.data ?? {};
        if (summary.ok) {
          lines.push(`${s.first_name ?? ''} ${s.last_name ?? ''}: account ${s.account_status ?? '-'}, training ${s.training_status ?? '-'}, ${s.courses_completed ?? '?'}/${s.courses_assigned ?? '?'} courses completed, ${s.courses_expired ?? 0} expired; paid by ${s.paid_by ?? '-'}, renewal ${s.renewal_mode ?? '-'}; expires ${day(s.expires_at)}.`.trim());
          if (s.summary) lines.push(`Summary: ${s.summary.completed ?? 0} completed, ${s.summary.needs_renewal ?? 0} need renewal, ${s.summary.expiring_soon ?? 0} expiring soon, ${s.summary.not_started ?? 0} not started (of ${s.summary.total ?? '?'}).`);
        } else skipped.push({ what: 'account summary', reason: why(summary) });

        const courses = rows(results);
        if (results.ok) {
          lines.push(courses.length ? `Courses (${courses.length}):` : 'No courses assigned.');
          for (const r of courses) lines.push(`  - ${r.course_name} [${r.group ?? '-'}]: ${r.status ?? '-'}${typeof r.grade === 'number' ? `, grade ${r.grade}` : ''}, completed ${day(r.completed_at)}, expires ${day(r.expires_at)}${r.certificate_available ? ', certificate available' : ''}`);
        } else skipped.push({ what: 'course results', reason: why(results) });

        const modCounts: Record<string, Record<string, number>> = {};
        if (modules?.ok) {
          for (const m of rows(modules)) {
            const c = String(m.course_name ?? m.course_id);
            modCounts[c] ??= {};
            modCounts[c][String(m.status ?? 'unknown')] = (modCounts[c][String(m.status ?? 'unknown')] ?? 0) + 1;
          }
          const entries = Object.entries(modCounts);
          if (entries.length) {
            lines.push('Modules:');
            for (const [c, st] of entries) lines.push(`  - ${c}: ${Object.entries(st).map(([k, v]) => `${v} ${k}`).join(', ')}`);
          }
        } else if (modules) skipped.push({ what: 'modules', reason: why(modules) });

        if (practical?.ok) {
          const pr = rows(practical);
          if (pr.length) {
            lines.push('Practical results:');
            for (const r of pr) lines.push(`  - ${r.course_name}: ${r.status ?? '-'}${typeof r.grade === 'number' ? `, grade ${r.grade}` : ''}, completed ${day(r.completed_at)}, expires ${day(r.expires_at)}`);
          }
        } else if (practical) skipped.push({ what: 'practical results', reason: why(practical) });

        if (detail?.ok) {
          const d = detail.data ?? {};
          lines.push(`Course ${d.course_name ?? a.data.course_id}: ${d.status ?? '-'}${typeof d.grade === 'number' ? `, grade ${d.grade}` : ''}, assigned ${day(d.assigned_at)}, completed ${day(d.completed_at)}, expires ${day(d.expires_at)}${d.certificate_available ? ', certificate available (hb_get_report)' : ''}.`);
        } else if (detail) skipped.push({ what: `course ${a.data.course_id}`, reason: why(detail) });

        if (catalogue?.ok) {
          lines.push(`Courses the account can assign (${rows(catalogue).length}): ${rows(catalogue).map((c) => `${c.id} ${c.name}`).join('; ')}.`);
        } else if (catalogue) skipped.push({ what: 'course catalogue', reason: why(catalogue) });

        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { candidate_ref: ref, summary: summary.ok ? s : undefined, courses, module_counts: modCounts, practical: practical?.ok ? rows(practical) : undefined, course_detail: detail?.ok ? detail.data : undefined, skipped } });
      },
    },
  };
}

// -------------------------------------------------------------------------------------- hb_list_bookings

const BOOKING_PORTALS = ['practical-training', 'virtual-bls-training', 'clinical-interviews', 'clinical-appraisals'] as const;
const bookingsArgs = z.object({
  portals: z.array(z.enum(BOOKING_PORTALS)).optional(),
  candidate_ref: z.string().optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.string().max(30).optional(),
  include_no_shows: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const BOOKING_LISTS: Record<(typeof BOOKING_PORTALS)[number], { op: string; what: (b: Json) => string; start: (b: Json) => unknown; status: (b: Json) => string }> = {
  'practical-training': { op: 'practical-training.bookings.list', what: (b) => `${b.course?.name ?? 'course'} at ${b.location?.name ?? '-'}`, start: (b) => b.start_date, status: (b) => `${b.booking_status}${b.attendance ? `, ${b.attendance}` : ''}` },
  'virtual-bls-training': { op: 'virtual-bls-training.bookings.list', what: (b) => b.course?.name ?? 'course', start: (b) => b.start_date, status: (b) => `${b.booking_status}${b.attendance ? `, ${b.attendance}` : ''}` },
  'clinical-interviews': { op: 'clinical-interviews.bookings.list', what: (b) => b.interview_type?.name ?? 'interview', start: (b) => b.start_date, status: (b) => `${b.booking_status}, ${b.interview_status ?? '-'}` },
  'clinical-appraisals': { op: 'clinical-appraisals.bookings.list', what: (b) => b.appraisal_type?.name ?? 'appraisal', start: (b) => b.start_date ?? b.created_at, status: (b) => `${b.booking_status}, ${b.appraisal_status_label ?? b.appraisal_status ?? '-'}` },
};

export function listBookingsTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: [...BOOKING_PORTALS] },
    definition: {
      name: 'hb_list_bookings',
      description:
        'Bookings across practical training, virtual BLS, clinical interviews and clinical appraisals in one compact table (portal, id, candidate, what, start, status, payment). Filter by portals, candidate_ref, date range (clinical appraisals use the booking creation date) and status. Practical training no-shows are included unless include_no_shows is false. Read-only. No candidate contact details, NMC numbers, reports or links are returned.',
      inputSchema: {
        type: 'object',
        properties: {
          portals: { type: 'array', items: { type: 'string', enum: [...BOOKING_PORTALS] }, description: 'Default: all four.' },
          candidate_ref: { type: 'string', description: 'Only this candidate.' },
          date_from: { type: 'string', description: 'YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'YYYY-MM-DD.' },
          status: { type: 'string', description: 'Booking status, for example pending, booked, rescheduled, cancelled.' },
          include_no_shows: { type: 'boolean', description: 'Also list practical training no-shows (default true).' },
          limit: { type: 'integer', description: 'Rows per portal (default 25, max 100).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'List bookings', ...readOnlyHints() },
      handler: async (raw) => {
        const a = bookingsArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        if (a.data.candidate_ref && !UUID.test(a.data.candidate_ref)) return refusal('candidate_ref must be a uuid.');
        const run = new TaskRun(ctx);
        await run.loadKey();
        const portals = a.data.portals ?? [...BOOKING_PORTALS];
        const limit = a.data.limit ?? 25;
        const query = (portal: (typeof BOOKING_PORTALS)[number]): Json => ({
          per_page: limit,
          sort: portal === 'clinical-appraisals' ? '-created_at' : '-start_date',
          ...(a.data.candidate_ref ? { candidate_ref: a.data.candidate_ref } : {}),
          ...(a.data.status ? { status: a.data.status } : {}),
          ...(portal === 'clinical-appraisals'
            ? { ...(a.data.date_from ? { created_from: a.data.date_from } : {}), ...(a.data.date_to ? { created_to: a.data.date_to } : {}) }
            : { ...(a.data.date_from ? { start_date_from: a.data.date_from } : {}), ...(a.data.date_to ? { start_date_to: a.data.date_to } : {}) }),
        });
        const results = await Promise.all(portals.map(async (p) => ({ p, r: await run.get(BOOKING_LISTS[p].op, { query: query(p) }) })));
        const noShows = a.data.include_no_shows !== false && portals.includes('practical-training')
          ? await run.get('practical-training.bookings.no-shows', { query: { per_page: limit, ...(a.data.candidate_ref ? { candidate_ref: a.data.candidate_ref } : {}), ...(a.data.date_from ? { start_date_from: a.data.date_from } : {}), ...(a.data.date_to ? { start_date_to: a.data.date_to } : {}) } })
          : undefined;

        const lines: string[] = ['portal | id | candidate | what | start | status | payment'];
        const skipped: { what: string; reason: string }[] = [];
        const table: Json[] = [];
        const add = (portal: string, b: Json, spec: (typeof BOOKING_LISTS)[keyof typeof BOOKING_LISTS], tag = '') => {
          const row = { portal, id: b.id, candidate_ref: b.candidate_ref, candidate: b.candidate_name ?? b.candidate_ref, what: spec.what(b), start: b.start_date ?? b.created_at, status: `${spec.status(b)}${tag}`, payment: `${b.pay_status ?? '-'}${b.pay_option ? ` (${b.pay_option})` : ''}` };
          table.push(row);
          lines.push(`${portal} | ${row.id} | ${row.candidate} | ${row.what} | ${when(spec.start(b))} | ${row.status} | ${row.payment}`);
        };
        for (const { p, r } of results) {
          if (!r.ok) {
            skipped.push({ what: PORTAL_LABELS[p] ?? p, reason: why(r) });
            continue;
          }
          for (const b of rows(r)) add(p, b, BOOKING_LISTS[p]);
          if (Number(r.body?.meta?.total) > rows(r).length) lines.push(`(${PORTAL_LABELS[p]}: ${r.body.meta.total} in total, showing ${rows(r).length}; narrow the filters or raise limit)`);
        }
        if (noShows) {
          if (noShows.ok) for (const b of rows(noShows)) add('practical-training (no-show)', b, BOOKING_LISTS['practical-training'], ' [no-show]');
          else skipped.push({ what: 'practical no-shows', reason: why(noShows) });
        }
        if (table.length === 0) lines.splice(0, 1, 'No bookings match.');
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { count: table.length, bookings: table, skipped } });
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------- hb_credits

const CREDIT_OPS: { toolset: string; show: string; tx: string }[] = [
  { toolset: 'online-training', show: 'online-training.credits.show', tx: 'online-training.credits.transactions' },
  { toolset: 'occupational-health', show: 'occupational-health.credits.show', tx: 'occupational-health.credits.transactions' },
  { toolset: 'practical-training', show: 'practical-training.credits.show', tx: 'practical-training.credits.transactions' },
  { toolset: 'virtual-bls-training', show: 'virtual-bls-training.credits.show', tx: 'virtual-bls-training.credits.transactions' },
  { toolset: 'clinical-interviews', show: 'clinical-interviews.credits.show', tx: 'clinical-interviews.credits.transactions' },
  { toolset: 'clinical-appraisals', show: 'clinical-appraisals.credits.show', tx: 'clinical-appraisals.credits.transactions' },
];

const sumCredits = (list: unknown): number => (Array.isArray(list) ? list.reduce((t: number, x: Json) => t + (Number(x?.credits) || 0), 0) : 0);

function balanceLine(d: Json): string {
  const parts: string[] = [];
  if (typeof d.balance === 'number') parts.push(`balance ${d.balance} credits`);
  if (typeof d.used_this_month === 'number') parts.push(`used this month ${d.used_this_month}`);
  if (Array.isArray(d.booking_credits)) parts.push(`${sumCredits(d.booking_credits)} booking credits (${d.booking_credits.map((x: Json) => `${x.course_name ?? x.interview_type_name ?? x.appraisal_type_name ?? '?'}: ${x.credits}`).join(', ') || 'none'})`);
  if (Array.isArray(d.interview_type_group_credits) && d.interview_type_group_credits.length) parts.push(`group credits ${sumCredits(d.interview_type_group_credits)}`);
  if (typeof d.all_interview_types_credits === 'number') parts.push(`all-types credits ${d.all_interview_types_credits}`);
  const pence = d.booking_balance_pence ?? d.booking_money_balance_pence;
  if (typeof pence === 'number') parts.push(`money balance ${money(pence, d.currency)}`);
  if (typeof d.price_per_credit_pence === 'number') parts.push(`${money(d.price_per_credit_pence, d.currency)} per credit`);
  return parts.join('; ') || 'no balance information';
}

function txLine(t: Json): string {
  const amount = t.amount_pence != null ? money(t.amount_pence, t.currency) : t.amount != null ? `${t.is_credit === false ? '-' : t.is_credit === true ? '+' : ''}${t.amount} credit(s)` : t.credits != null ? `${t.credits} credit(s)` : '';
  const kind = t.type ?? (t.is_credit === true ? 'credit' : t.is_credit === false ? 'debit' : '');
  return `${day(t.created_at)} ${kind} ${amount}${t.description ? `: ${t.description}` : ''}${t.booking_id ? ` (booking #${t.booking_id})` : ''}`.replace(/\s+/g, ' ').trim();
}

const creditsArgs = z.object({ transactions: z.boolean().optional(), recent: z.number().int().min(1).max(25).optional() });

export function creditsTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: CREDIT_OPS.map((c) => c.toolset) },
    definition: {
      name: 'hb_credits',
      description:
        'Credit and balance figures for every portal the key can reach (online training, occupational health, practical training, virtual BLS, clinical interviews, clinical appraisals), with the most recent transactions, plus the occupational health credit packages. Credits are units; money is shown as an amount with its currency. Read-only. Portals the key cannot read are listed as skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          transactions: { type: 'boolean', description: 'Include recent transactions (default true).' },
          recent: { type: 'integer', description: 'Transactions per portal (default 5, max 25).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Credits and balances', ...readOnlyHints() },
      handler: async (raw) => {
        const a = creditsArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        const wantTx = a.data.transactions !== false;
        const recent = a.data.recent ?? 5;
        const out = await Promise.all(
          CREDIT_OPS.map(async (c) => ({
            c,
            show: await run.get(c.show, {}),
            tx: wantTx ? await run.get(c.tx, { query: { per_page: recent, ...(c.toolset === 'online-training' || c.toolset === 'occupational-health' ? {} : { sort: '-created_at' }) } }) : undefined,
          })),
        );
        const packages = await run.get('occupational-health.credits.packages', { query: { per_page: 25 } });
        const lines: string[] = [];
        const skipped: { what: string; reason: string }[] = [];
        const data: Record<string, unknown> = {};
        for (const { c, show, tx } of out) {
          const label = PORTAL_LABELS[c.toolset] ?? c.toolset;
          if (!show.ok) {
            skipped.push({ what: `${label} credits`, reason: why(show) });
            continue;
          }
          lines.push(`${label}: ${balanceLine(show.data ?? {})}.`);
          const t = tx?.ok ? rows(tx).slice(0, recent) : [];
          for (const x of t) lines.push(`    ${txLine(x)}`);
          if (tx && !tx.ok) skipped.push({ what: `${label} transactions`, reason: why(tx) });
          data[c.toolset] = { balance: show.data, recent_transactions: t };
        }
        if (packages.ok) {
          const list = rows(packages);
          if (list.length) lines.push('Occupational health credit packages: ' + list.map((p) => `${p.credits} credits for ${money(p.total_pence ?? p.price_pence, p.currency)} (${money(p.per_credit_pence, p.currency)} each)`).join('; ') + '.');
          data.occupational_health_packages = list;
        } else skipped.push({ what: 'occupational health packages', reason: why(packages) });
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { credits: data, skipped } });
      },
    },
  };
}

// ---------------------------------------------------------------------------------------- hb_webhook_health

const healthArgs = z.object({ endpoint_id: z.number().int().optional(), failed_limit: z.number().int().min(1).max(25).optional() });
const HEALTH_MAX_ENDPOINTS = 10;

export function webhookHealthTool(ctx: AppContext): TaskTool {
  return {
    availability: { allOf: ['account'] },
    definition: {
      name: 'hb_webhook_health',
      description:
        'Webhook endpoint health: active flag, consecutive failures (Hub switches an endpoint off at 25), last response code, and the recent failed deliveries of each endpoint with a summary of the response codes. The API gives status, attempts and HTTP code but not error text (that is on the Developer page). URLs are shown without query strings. Read-only. Uses webhooks.endpoints.list/.show and webhooks.deliveries.list.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint_id: { type: 'integer', description: 'Only this endpoint.' },
          failed_limit: { type: 'integer', description: 'Failed deliveries per endpoint (default 5, max 25).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Webhook health', ...readOnlyHints() },
      handler: async (raw) => {
        const a = healthArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        let endpoints: Json[] = [];
        if (a.data.endpoint_id !== undefined) {
          const r = await run.get('webhooks.endpoints.show', { path_params: { webhook: a.data.endpoint_id } });
          if (!r.ok) return problem(ctx, run, 'hb_webhook_health', r);
          endpoints = [r.body ?? {}];
        } else {
          const r = await run.get('webhooks.endpoints.list', { query: { per_page: 100 } });
          if (!r.ok) return problem(ctx, run, 'hb_webhook_health', r);
          endpoints = rows(r);
        }
        const shown = endpoints.slice(0, HEALTH_MAX_ENDPOINTS);
        const limit = a.data.failed_limit ?? 5;
        const fetched = await Promise.all(shown.map(async (e) => ({ e, d: await run.get('webhooks.deliveries.list', { path_params: { webhook: e.id }, query: { status: 'failed', per_page: limit, sort: '-id' } }) })));
        const lines: string[] = [];
        const out: Json[] = [];
        const skipped: { what: string; reason: string }[] = [];
        if (shown.length === 0) lines.push('No webhook endpoints are registered.');
        for (const { e, d } of fetched) {
          const health = endpointHealth(e);
          const failedList = d.ok ? rows(d).filter((x) => x.status === 'failed') : [];
          const codes: Record<string, number> = {};
          for (const f of failedList) codes[f.response_code ? String(f.response_code) : 'no response'] = (codes[f.response_code ? String(f.response_code) : 'no response'] ?? 0) + 1;
          lines.push(`#${e.id} ${e.name}: ${health}${e.consecutive_failures ? `, ${e.consecutive_failures} failed in a row` : ''}; ${safeUrl(e.url)}; ${Array.isArray(e.events) ? e.events.length : 0} event(s); last response ${e.last_response_code ?? '-'} at ${when(e.last_delivered_at)}.`);
          if (health === 'disabled') lines.push('    Switched off. Fix the receiver, then switch it on (resets the failure count) and use hb_redeliver_webhooks for what you need.');
          if (d.ok) {
            if (failedList.length) {
              lines.push(`    ${failedList.length} recent failed delivery(ies): ${Object.entries(codes).map(([k, v]) => `${v} x ${k}`).join(', ')}`);
              for (const f of failedList) lines.push(`      #${f.id} ${f.event_type}: attempt ${f.attempt ?? '-'}, ${f.response_code ?? 'no response'}, ${when(f.created_at)}`);
            } else lines.push('    No recent failed deliveries.');
          } else skipped.push({ what: `deliveries of #${e.id}`, reason: why(d) });
          out.push({ id: e.id, name: e.name, url: safeUrl(e.url), health, is_active: e.is_active, consecutive_failures: e.consecutive_failures ?? 0, last_response_code: e.last_response_code ?? null, failed_deliveries: failedList.map((f) => ({ id: f.id, event_type: f.event_type, attempt: f.attempt, response_code: f.response_code ?? null, created_at: f.created_at })), response_code_summary: codes });
        }
        if (out.some((o) => (o.failed_deliveries as Json[]).length)) lines.push('The API gives status, attempts and the HTTP code of each delivery, not the error text (that is on the Developer page), so the response codes above are the error summary.');
        if (endpoints.length > HEALTH_MAX_ENDPOINTS) lines.push(`Deliveries were read for the first ${HEALTH_MAX_ENDPOINTS} endpoints only; use endpoint_id for the others.`);
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { endpoints: out, skipped } });
      },
    },
  };
}

// ------------------------------------------------------------------------------------ hb_monitoring_alerts

const ALERT_PORTALS = ['dbs-rtw', 'registration-monitoring', 'occupational-health'] as const;
const alertsArgs = z.object({
  portals: z.array(z.enum(ALERT_PORTALS)).optional(),
  acknowledged: z.boolean().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  type: z.string().max(100).optional(),
  alert_id: z.number().int().optional(),
  portal: z.enum(['dbs-rtw', 'registration-monitoring']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function monitoringAlertsTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: [...ALERT_PORTALS] },
    definition: {
      name: 'hb_monitoring_alerts',
      description:
        'Alerts from DBS and right to work, registration monitoring and occupational health in one list. Filters: portals, acknowledged (true or false), severity, type, limit. `alert_id` with `portal` shows one DBS/RTW or registration alert in full. Occupational health alerts are statuses only (type, severity, status, date, candidate_ref): never names, reasons, clearance or documents. Read-only. Uses dbs-rtw.alerts.list/.show, registration-monitoring.alerts.list/.show and occupational-health.alerts.list.',
      inputSchema: {
        type: 'object',
        properties: {
          portals: { type: 'array', items: { type: 'string', enum: [...ALERT_PORTALS] }, description: 'Default: all three.' },
          acknowledged: { type: 'boolean', description: 'DBS/RTW and registration alerts only: true for acknowledged, false for open.' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          type: { type: 'string', description: 'Alert type (OH: rejected or not_fit).' },
          alert_id: { type: 'integer', description: 'Show one alert (needs `portal`).' },
          portal: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring'], description: 'With alert_id.' },
          limit: { type: 'integer', description: 'Alerts per portal (default 25, max 100).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Monitoring alerts', ...readOnlyHints() },
      handler: async (raw) => {
        const a = alertsArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        if (a.data.alert_id !== undefined) {
          if (!a.data.portal) return refusal('alert_id needs `portal` (dbs-rtw or registration-monitoring).');
          const r = await run.get(`${a.data.portal}.alerts.show`, { path_params: { alert: a.data.alert_id } });
          if (!r.ok) return problem(ctx, run, 'hb_monitoring_alerts', r);
          const x = r.data ?? {};
          const lines = [`Alert #${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.title ?? '-'}; ${x.previous_status ?? '-'} -> ${x.new_status ?? '-'}; ${x.acknowledged ? `acknowledged ${day(x.acknowledged_at)}` : 'open'}; raised ${when(x.created_at)}. ${x.description ?? ''}`.trim(), done(run)];
          return taskResult(ctx, run, { lines, data: { alert: x } });
        }
        const portals = a.data.portals ?? [...ALERT_PORTALS];
        const limit = a.data.limit ?? 25;
        const common: Json = { per_page: limit, ...(a.data.severity ? { severity: a.data.severity } : {}), ...(a.data.type ? { type: a.data.type } : {}) };
        const jobs = portals.map(async (p) => {
          if (p === 'occupational-health') return { p, r: await run.get('occupational-health.alerts.list', { query: { per_page: limit, ...(a.data.type ? { type: a.data.type } : {}) } }) };
          return { p, r: await run.get(`${p}.alerts.list`, { query: { ...common, sort: '-created_at', ...(a.data.acknowledged !== undefined ? { acknowledged: String(a.data.acknowledged) } : {}) } }) };
        });
        const results = await Promise.all(jobs);
        const lines: string[] = [];
        const skipped: { what: string; reason: string }[] = [];
        const out: Json[] = [];
        for (const { p, r } of results) {
          const label = PORTAL_LABELS[p] ?? p;
          if (!r.ok) {
            skipped.push({ what: label, reason: why(r) });
            continue;
          }
          let list = rows(r);
          if (p !== 'occupational-health' && a.data.acknowledged !== undefined) list = list.filter((x) => x.acknowledged === a.data.acknowledged);
          if (p === 'occupational-health' && a.data.severity) list = list.filter((x) => x.severity === a.data.severity);
          lines.push(`${label}: ${list.length} alert(s)${Number(r.body?.meta?.total) > list.length ? ` (of ${r.body.meta.total})` : ''}.`);
          for (const x of list) {
            if (p === 'occupational-health') {
              out.push({ portal: p, key: x.key, type: x.type, severity: x.severity, status: x.status_label, at: x.at, candidate_ref: x.candidate_ref });
              lines.push(`  - ${x.key}: ${x.type} [${x.severity}] ${x.status_label ?? ''}, ${when(x.at)}, candidate ${x.candidate_ref ?? '-'}`);
            } else {
              out.push({ portal: p, id: x.id, type: x.type, severity: x.severity, acknowledged: x.acknowledged, created_at: x.created_at, worker: x.worker?.name });
              lines.push(`  - #${x.id} [${x.severity}] ${x.type_label ?? x.type}: ${x.worker?.name ?? 'worker'}${x.worker?.regulator ? ` (${x.worker.regulator})` : ''}, ${x.acknowledged ? 'acknowledged' : 'open'}, ${when(x.created_at)}`);
            }
          }
        }
        if (results.some(({ p }) => p === 'occupational-health')) lines.push('Occupational health alerts are shown as statuses only; reasons and clearance detail are not fetched.');
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { alerts: out, skipped } });
      },
    },
  };
}

// ---------------------------------------------------------------------------------------- hb_worker_status

const workerArgs = z.object({
  portal: z.enum(['dbs-rtw', 'registration-monitoring']),
  worker_id: z.number().int().optional(),
  search: z.string().max(100).optional(),
  candidate_ref: z.string().optional(),
});

function workerLine(portal: string, w: Json): string[] {
  const head = `#${w.id} ${w.first_name ?? ''} ${w.last_name ?? ''}${w.profession ? ` (${w.profession})` : ''}${w.is_active === false ? ' [inactive]' : ''}`.replace(/\s+/g, ' ');
  if (portal === 'dbs-rtw') {
    return [
      head,
      `    DBS: ${w.dbs?.status_label ?? w.dbs?.status ?? 'not enrolled'}${w.dbs ? `, certificate ${w.dbs.certificate_number ?? '-'}, last checked ${day(w.dbs.last_checked_at)}, next ${day(w.dbs.next_check_due_at)}` : ''}`,
      `    Right to work: ${w.rtw?.status_label ?? w.rtw?.status ?? 'not enrolled'}${w.rtw ? `, expires ${day(w.rtw.expiry_date)}, last checked ${day(w.rtw.last_checked_at)}, next ${day(w.rtw.next_check_due_at)}${w.rtw.share_code_stale ? ', share code stale' : ''}` : ''}; ${w.compliant ? 'compliant' : 'not compliant'}`,
    ];
  }
  return [head, `    ${String(w.regulator ?? '').toUpperCase()} registration ${w.status_label ?? w.status ?? '-'}${w.has_warning ? ', warning' : ''}${w.has_condition ? ', conditions' : ''}; expires ${day(w.expiry_date)}; last checked ${day(w.last_checked_at)}, next ${day(w.next_check_due_at)}`];
}

export function workerStatusTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: ['dbs-rtw', 'registration-monitoring'] },
    definition: {
      name: 'hb_worker_status',
      description:
        'Look up a DBS/right to work or registration monitoring worker (by worker_id, search text or candidate_ref) and show the current result, the latest verification history and the evidence metadata (type, date, size). Certificate numbers appear only in the masked form the API returns; date of birth, contact details, registration numbers and the evidence files themselves are never returned. Read-only. Uses {portal}.workers.show/.list/.verification/.evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          portal: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring'] },
          worker_id: { type: 'integer', description: 'The worker id.' },
          search: { type: 'string', description: 'Part of the name or email.' },
          candidate_ref: { type: 'string', description: 'The linked candidate.' },
        },
        required: ['portal'],
        additionalProperties: false,
      },
      annotations: { title: 'Worker status', ...readOnlyHints() },
      handler: async (raw) => {
        const a = workerArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const { portal } = a.data;
        if (a.data.worker_id === undefined && !a.data.search && !a.data.candidate_ref) return refusal('Give worker_id, search or candidate_ref.');
        if (a.data.candidate_ref && !UUID.test(a.data.candidate_ref)) return refusal('candidate_ref must be a uuid.');
        const run = new TaskRun(ctx);
        await run.loadKey();
        let workers: Json[];
        if (a.data.worker_id !== undefined) {
          const r = await run.get(`${portal}.workers.show`, { path_params: { worker: a.data.worker_id } });
          if (!r.ok) return problem(ctx, run, 'hb_worker_status', r);
          workers = [r.data];
        } else {
          const r = await run.get(`${portal}.workers.list`, { query: { per_page: 5, ...(a.data.search ? { search: a.data.search } : {}), ...(a.data.candidate_ref ? { candidate_ref: a.data.candidate_ref } : {}) } });
          if (!r.ok) return problem(ctx, run, 'hb_worker_status', r);
          workers = rows(r).slice(0, 5);
        }
        const detailed = await Promise.all(
          workers.slice(0, 3).map(async (w) => ({
            w,
            v: await run.get(`${portal}.workers.verification`, { path_params: { worker: w.id }, query: { per_page: 3, sort: '-checked_at' } }),
            e: await run.get(`${portal}.workers.evidence`, { path_params: { worker: w.id }, query: { per_page: 5, sort: portal === 'dbs-rtw' ? '-checked_at' : '-captured_at' } }),
          })),
        );
        const lines: string[] = [workers.length ? `${workers.length} worker(s):` : 'No worker matches.'];
        const skipped: { what: string; reason: string }[] = [];
        const out: Json[] = [];
        for (const w of workers) {
          lines.push(...workerLine(portal, w));
          const d = detailed.find((x) => x.w === w);
          const verification = d?.v.ok ? rows(d.v).map((x) => ({ id: x.id, checked_at: x.checked_at, status: x.status_label ?? x.status, result: x.result, status_changed: x.status_changed })) : [];
          const evidence = d?.e.ok ? rows(d.e).map((x) => ({ type: x.type, checked_at: x.checked_at ?? x.captured_at, mime_type: x.mime_type, size: x.file_size, download_url: x.download_url })) : [];
          if (d) {
            if (d.v.ok) for (const x of verification) lines.push(`    check ${day(x.checked_at)}: ${x.status ?? '-'} (${x.result ?? '-'})${x.status_changed ? ', status changed' : ''}`);
            else skipped.push({ what: `verification of #${w.id}`, reason: why(d.v) });
            if (d.e.ok) for (const x of evidence) lines.push(`    evidence ${x.type} ${day(x.checked_at)}${x.size ? `, ${x.size} bytes` : ''} (download through the API with the evidence scope; not fetched here)`);
            else skipped.push({ what: `evidence of #${w.id}`, reason: why(d.e) });
          }
          out.push({ id: w.id, candidate_ref: w.candidate_ref, name: `${w.first_name ?? ''} ${w.last_name ?? ''}`.trim(), is_active: w.is_active, compliant: w.compliant, dbs: w.dbs ? { status: w.dbs.status_label ?? w.dbs.status, certificate: w.dbs.certificate_number, last_checked_at: w.dbs.last_checked_at, next_check_due_at: w.dbs.next_check_due_at } : undefined, rtw: w.rtw ? { status: w.rtw.status_label ?? w.rtw.status, expiry_date: w.rtw.expiry_date } : undefined, registration: portal === 'registration-monitoring' ? { regulator: w.regulator, status: w.status_label ?? w.status, expiry_date: w.expiry_date } : undefined, verification, evidence });
        }
        if (workers.length > 3) lines.push('History and evidence were read for the first 3 workers only; use worker_id for the others.');
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { workers: out, skipped } });
      },
    },
  };
}

// ------------------------------------------------------------------------------------ hb_billing_summary

const billingArgs = z.object({ portals: z.array(z.enum(['dbs-rtw', 'registration-monitoring'])).optional(), bills: z.number().int().min(1).max(25).optional() });

export function billingSummaryTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: ['dbs-rtw', 'registration-monitoring'] },
    definition: {
      name: 'hb_billing_summary',
      description:
        'Usage and bills for DBS and right to work and for registration monitoring: trial status, billing type, this month\'s estimate (active workers and amounts) and the latest bills with status and due date. Money is shown as an amount with its currency. Read-only. Uses {portal}.billing.usage and .billing.bills. Invoices (PDF) are not fetched.',
      inputSchema: {
        type: 'object',
        properties: {
          portals: { type: 'array', items: { type: 'string', enum: ['dbs-rtw', 'registration-monitoring'] }, description: 'Default: both.' },
          bills: { type: 'integer', description: 'Bills per portal (default 5, max 25).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Billing summary', ...readOnlyHints() },
      handler: async (raw) => {
        const a = billingArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const run = new TaskRun(ctx);
        await run.loadKey();
        const portals = a.data.portals ?? ['dbs-rtw', 'registration-monitoring'];
        const results = await Promise.all(portals.map(async (p) => ({ p, usage: await run.get(`${p}.billing.usage`, {}), bills: await run.get(`${p}.billing.bills`, { query: { per_page: a.data.bills ?? 5, sort: '-period_start' } }) })));
        const lines: string[] = [];
        const skipped: { what: string; reason: string }[] = [];
        const data: Record<string, unknown> = {};
        for (const { p, usage, bills } of results) {
          const label = PORTAL_LABELS[p] ?? p;
          if (usage.ok) {
            const u = usage.data ?? {};
            const est = u.estimate ?? {};
            const picked = est.options?.[est.selected] ?? {};
            lines.push(`${label}: billing ${u.billing_type ?? '-'}${u.trial?.on_trial ? `, free trial until ${day(u.trial.expires_at)} (${u.trial.days_left} day(s) left)` : u.trial?.expired ? ', trial ended' : ''}${u.trial?.restricted ? ', RESTRICTED' : ''}; Direct Debit ${u.direct_debit?.mandate_status ?? 'not set up'}.`);
            lines.push(`    ${est.month ?? 'This month'}: ${est.active_workers ?? '?'} active worker(s)${picked.total_amount_pence != null ? `, estimate ${money(picked.total_amount_pence, picked.currency ?? u.currency)} incl. VAT (${est.vat_rate_percent ?? '?'}%)` : ''}.`);
          } else skipped.push({ what: `${label} usage`, reason: why(usage) });
          if (bills.ok) {
            const list = rows(bills);
            for (const b of list) lines.push(`    bill ${b.bill_number ?? b.id} ${b.period ?? ''}: ${b.active_workers ?? '?'} workers, ${money(b.total_amount_pence, b.currency)}, ${b.status_label ?? b.status}, due ${day(b.due_at)}${b.paid_at ? `, paid ${day(b.paid_at)}` : ''}`);
            data[p] = { usage: usage.ok ? usage.data : undefined, bills: list };
          } else skipped.push({ what: `${label} bills`, reason: why(bills) });
        }
        lines.push(...skippedLine(skipped), done(run));
        return taskResult(ctx, run, { lines, data: { billing: data, skipped } });
      },
    },
  };
}

// ------------------------------------------------------------------------------------------ hb_get_report

const REPORT_KINDS = ['practical_certificate', 'virtual_bls_certificate', 'online_training_certificate', 'interview_report', 'appraisal_report', 'occupational_health_reports'] as const;
const reportArgs = z.object({
  kind: z.enum(REPORT_KINDS),
  booking_id: z.number().int().optional(),
  candidate_ref: z.string().optional(),
  certificate_type: z.string().max(20).optional(),
  course_id: z.number().int().optional(),
  check_download: z.boolean().optional(),
});

const REPORT_SPEC: Record<(typeof REPORT_KINDS)[number], { toolset: string; show?: string; flag?: string; download?: string; path?: string; label: string; health?: boolean }> = {
  practical_certificate: { toolset: 'practical-training', show: 'practical-training.bookings.show', flag: 'certificate_available', download: 'practical-training.bookings.certificate', path: '/practical-training/bookings/{id}/certificate', label: 'Practical training attendance certificate' },
  virtual_bls_certificate: { toolset: 'virtual-bls-training', show: 'virtual-bls-training.bookings.show', flag: 'certificate_available', download: 'virtual-bls-training.bookings.certificate', path: '/virtual-bls-training/bookings/{id}/certificate', label: 'Virtual BLS certificate' },
  online_training_certificate: { toolset: 'online-training', download: 'online-training.candidates.certificate', path: '/online-training/candidates/{ref}/certificate', label: 'Online training certificate' },
  interview_report: { toolset: 'clinical-interviews', show: 'clinical-interviews.bookings.show', flag: 'interview_report_available', download: 'clinical-interviews.bookings.interview-report', path: '/clinical-interviews/bookings/{id}/interview-report', label: 'Clinical interview report', health: true },
  appraisal_report: { toolset: 'clinical-appraisals', show: 'clinical-appraisals.bookings.show', flag: 'evaluation_report_available', download: 'clinical-appraisals.bookings.evaluation-report', path: '/clinical-appraisals/bookings/{id}/evaluation-report', label: 'Clinical appraisal evaluation report', health: true },
  occupational_health_reports: { toolset: 'occupational-health', label: 'Occupational health reports' },
};

export function getReportTool(ctx: AppContext): TaskTool {
  return {
    availability: { anyOf: ['practical-training', 'virtual-bls-training', 'online-training', 'clinical-interviews', 'clinical-appraisals', 'occupational-health'] },
    definition: {
      name: 'hb_get_report',
      description:
        'Certificate and report details with how to download them: practical training, virtual BLS and online training certificates, clinical interview report, clinical appraisal evaluation report, and the occupational health reports list. Returns whether the file exists, its metadata and the exact API address and instructions to download it. File bytes are never returned in the answer: with check_download=true the server fetches the file only to report its type and size, then discards it. Interview and appraisal reports are health data: use only what the task needs. Read-only. Uses the booking show operations, the certificate/report download operations and occupational-health.reports.list.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...REPORT_KINDS] },
          booking_id: { type: 'integer', description: 'For booking based kinds.' },
          candidate_ref: { type: 'string', description: 'For online_training_certificate.' },
          certificate_type: { type: 'string', description: 'Online training: current (default), assigned, all, excl-expired, incl-expired, range, course, care, cstf.' },
          course_id: { type: 'integer', description: 'Online training type=course.' },
          check_download: { type: 'boolean', description: 'Fetch the file once to report its content type and size (bytes are discarded).' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      annotations: { title: 'Get report details', ...readOnlyHints() },
      handler: async (raw) => {
        const a = reportArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const spec = REPORT_SPEC[a.data.kind];
        const run = new TaskRun(ctx);
        await run.loadKey();
        const base = ctx.config.baseUrl;

        if (a.data.kind === 'occupational_health_reports') {
          const r = await run.get('occupational-health.reports.list', { query: { per_page: 25 } });
          if (!r.ok) return problem(ctx, run, 'hb_get_report', r);
          const list = rows(r);
          const lines = [list.length ? 'Occupational health reports:' : 'No reports have been generated.', ...list.map((x) => `  - ${x.type}: ${x.title} (${x.format}), ${x.status}${typeof x.percent === 'number' ? ` ${x.percent}%` : ''}, ${x.count ?? '?'} row(s), generated ${when(x.generated_at)}`), 'Download: GET {base}/api/v2/occupational-health/reports/{type}/{format} with a bearer token (needs occupational-health:reports:read). Generating a new report is a write (POST .../reports/{type}/generate). The report is health data: it is not fetched here.'.replace('{base}', base), done(run)];
          return taskResult(ctx, run, { lines, data: { reports: list, download_pattern: `${base}/api/v2/occupational-health/reports/{type}/{format}` } });
        }

        let path = spec.path ?? '';
        const args: Json = {};
        let flag: boolean | undefined;
        let metadata: Json = {};
        if (a.data.kind === 'online_training_certificate') {
          const ref = (a.data.candidate_ref ?? '').toLowerCase();
          if (!UUID.test(ref)) return refusal('candidate_ref (uuid) is needed for the online training certificate.');
          path = path.replace('{ref}', ref);
          args.path_params = { candidate_ref: ref };
          const q: Json = {};
          if (a.data.certificate_type) q.type = a.data.certificate_type;
          if (a.data.course_id !== undefined) q.course_id = a.data.course_id;
          if (Object.keys(q).length) args.query = q;
          const res = await run.get('online-training.candidates.results', { path_params: { candidate_ref: ref }, query: { per_page: 100 } });
          if (res.ok) metadata = { completed_courses: rows(res).filter((x) => x.status === 'completed').length, certificates_available: rows(res).filter((x) => x.certificate_available).length };
        } else {
          if (a.data.booking_id === undefined) return refusal('booking_id is needed for this kind of report.');
          path = path.replace('{id}', String(a.data.booking_id));
          args.path_params = { booking: a.data.booking_id };
          const show = await run.get(spec.show as string, args);
          if (!show.ok) return problem(ctx, run, 'hb_get_report', show);
          const b = show.data ?? {};
          flag = Boolean(b[spec.flag as string]);
          metadata = { booking_id: b.id, candidate_ref: b.candidate_ref, status: b.booking_status, start_date: b.start_date, [spec.flag as string]: flag };
        }

        let download: Json | undefined;
        if (a.data.check_download && flag !== false) {
          const r = await run.get(spec.download as string, args);
          if (r.ok) download = { content_type: r.body?.content_type, size_bytes: r.body?.size_bytes };
          else download = { problem: why(r) };
        }
        const url = `${base}/api/v2${path}`;
        const lines = [
          `${spec.label}${flag === undefined ? '' : flag ? ': available' : ': not available yet'}.`,
          ...(Object.keys(metadata).length ? [`Details: ${Object.entries(metadata).map(([k, v]) => `${k}=${v}`).join(', ')}.`] : []),
          ...(download ? [download.problem ? `Download check: ${download.problem}.` : `Download check: ${download.content_type ?? 'file'}, ${download.size_bytes ?? '?'} bytes (not included here).`] : []),
          `Download: GET ${url}${args.query ? `?${new URLSearchParams(args.query as Record<string, string>).toString()}` : ''} with the header Authorization: Bearer <access token> (exchange the key with POST /api/v2/auth/token; never paste the key or token in chat), for example with curl --output. The response is a PDF file, not JSON.`,
          ...(spec.health ? ['This report is health data (special category): download it only if the task needs it and keep it out of tickets, chat and logs.'] : []),
          done(run),
        ];
        return taskResult(ctx, run, { lines, data: { kind: a.data.kind, available: flag, metadata, download_check: download, download_url: url, download_method: 'GET', content_type: 'application/pdf', health_data: spec.health === true } });
      },
    },
  };
}

export const READ_TASKS_MORE = [trainingProgressTool, listBookingsTool, creditsTool, webhookHealthTool, monitoringAlertsTool, workerStatusTool, billingSummaryTool, getReportTool];
export { isUnavailable };
