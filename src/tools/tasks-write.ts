import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopeAllowed, type AppContext } from '../context.js';
import { SafetyRefusal } from '../errors.js';
import { redactor } from '../redact.js';
import {
  UUID,
  assertWritable,
  fail,
  saveSecretFile,
  day,
  missingScopes,
  money,
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
import { TV_EVENTS } from './tasks-verification.js';

const WRITE_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// ------------------------------------------------------------------------------------ hb_book_practical_training

const bookArgs = z.object({
  candidate_ref: z.string(),
  invite: z.boolean().optional(),
  course_id: z.number().int().optional(),
  location_id: z.number().int().optional(),
  location: z.string().max(100).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  event_id: z.number().int().optional(),
  pay_option: z.enum(['credits', 'balance', 'invoice', 'candidate_pays']).optional(),
  agency_contact_name: z.string().max(150).optional(),
  agency_contact_email: z.string().email().max(255).optional(),
  agency_email: z.string().email().max(255).optional(),
  confirm: z.boolean().optional(),
  idempotency_key: z.string().max(200).optional(),
});

const PAY_EXPLAINED: Record<string, string> = {
  credits: 'takes one booking credit for the course now; the booking is confirmed at once',
  balance: 'takes the session price from the booking balance now; the booking is confirmed at once',
  invoice: 'confirms the booking at once and invoices it (only if invoicing is switched on for the account and the price is within the credit limit)',
  candidate_pays: 'leaves the booking pending and emails the candidate a payment link; the seat is taken when they pay',
};

const OPTION_MAX = 10;

export function bookPracticalTrainingTool(ctx: AppContext): TaskTool {
  const live = ctx.config.mode === 'live';
  return {
    availability: { writes: true, allOf: ['hub', 'practical-training'] },
    definition: {
      name: 'hb_book_practical_training',
      description:
        `${live ? '[LIVE Hub]' : '[SANDBOX]'} Guided practical training booking in two calls. CALL 1 (no confirm): give candidate_ref and, optionally, course_id, location_id or location (name), date_from/date_to; it finds sessions with free places, checks the candidate and the credits, and returns the options and the exact plan. Nothing is sent. CALL 2: repeat with event_id (the chosen session), pay_option, agency_contact_name, agency_contact_email and confirm=true after the user approved: it holds the place, books it and reports the booking. ` +
        'Set invite=true instead to email the candidate an invitation to choose their own session (nothing is charged until they book). Uses an Idempotency-Key (reuse the one returned to retry safely). Writes: confirm=true is required in every environment, and on LIVE the server must also allow live writes. Uses practical-training.events.list, .credits.show, .events.hold, .bookings.create, .booking-invites.create and hub.candidates.show. Credits are units; money is shown as an amount.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_ref: { type: 'string', description: 'The candidate_ref uuid (find it with hb_find_candidate).' },
          invite: { type: 'boolean', description: 'Invite the candidate to book (they pick the session) instead of booking a session now.' },
          course_id: { type: 'integer', description: 'Course id (practical-training.courses.list). Optional.' },
          location_id: { type: 'integer', description: 'Location id. Optional; or use `location`.' },
          location: { type: 'string', description: 'Part of a location name, resolved to location ids. Optional.' },
          date_from: { type: 'string', description: 'Earliest session day, YYYY-MM-DD (UK day). Optional.' },
          date_to: { type: 'string', description: 'Latest session day, YYYY-MM-DD. Optional.' },
          event_id: { type: 'integer', description: 'The chosen session id from the options of call 1.' },
          pay_option: { type: 'string', enum: ['credits', 'balance', 'invoice', 'candidate_pays'], description: 'How the place is paid for.' },
          agency_contact_name: { type: 'string', description: 'Person at the account responsible for the booking (invite: optional contact copied in).' },
          agency_contact_email: { type: 'string', description: 'Their email address.' },
          agency_email: { type: 'string', description: 'Address for the agency confirmation email. Optional.' },
          confirm: { type: 'boolean', description: 'true only after the user approved the plan from call 1. Without it nothing is sent.' },
          idempotency_key: { type: 'string', description: 'Reuse the key returned by an earlier call to repeat the booking safely.' },
        },
        required: ['candidate_ref'],
        additionalProperties: false,
      },
      annotations: { title: 'Book practical training', ...WRITE_HINTS },
      handler: async (raw) => {
        const a = bookArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        const args = a.data;
        const ref = args.candidate_ref.trim().toLowerCase();
        if (!UUID.test(ref)) return refusal('candidate_ref must be a uuid. Find the person with hb_find_candidate first; never guess one.');
        const run = new TaskRun(ctx);
        try {
          assertWritable(ctx, args.invite ? ['practical-training.booking-invites.create'] : ['practical-training.events.hold', 'practical-training.bookings.create']);
        } catch (e) {
          if (e instanceof SafetyRefusal) return refusal(`${e.message} Nothing was sent.`);
          throw e;
        }
        await run.loadKey();
        const needOps = args.invite
          ? ['hub.candidates.show', 'practical-training.booking-invites.create']
          : ['hub.candidates.show', 'practical-training.events.list', 'practical-training.events.hold', 'practical-training.bookings.create'];
        const lacking = missingScopes(ctx, needOps, run);
        if (lacking.length) return refusal(`The key lacks the scope(s) ${lacking.join(', ')}, so this booking cannot be made. Ask the user to add them to the key on the Hub Developer page. Nothing was sent.`);

        const cand = await run.get('hub.candidates.show', { path_params: { candidate_ref: ref } });
        if (!cand.ok) return fail(ctx, run, 'The candidate could not be read', cand);
        const c = cand.data ?? {};
        const missing: string[] = [];
        if (!c.first_name) missing.push('first name');
        if (!c.email) missing.push('email address');
        if (!args.invite && !c.phone) missing.push('phone number');
        const environmentLine = live ? 'LIVE Hub: real people, real credits and real emails.' : 'SANDBOX: synthetic data.';
        const key = args.idempotency_key ?? randomUUID();

        // ---------- invitation
        if (args.invite) {
          const body: Json = { candidate_ref: ref, ...(args.agency_contact_name ? { contact_name: args.agency_contact_name } : {}), ...(args.agency_contact_email ? { contact_email: args.agency_contact_email } : {}) };
          if (args.confirm !== true) {
            const lines = [
              environmentLine,
              `PLAN (nothing sent): invite ${c.name ?? ref} (${c.email ?? 'no email'}) to book a practical training place. They get an email with a one-time link valid for 8 weeks and choose the session. Nothing is charged by the invitation; the place is paid when they book (the call only checks the account can pay).`,
              ...(missing.length ? [`Cannot proceed yet: the candidate has no ${missing.join(', ')}. Add it with hub.candidates.update first.`] : []),
              'To send it, call again with the same arguments, confirm=true' + (args.agency_contact_email ? '' : ' (agency_contact_name and agency_contact_email are optional: the person copied in)') + `, idempotency_key "${key}", after the user agrees.`,
            ];
            return taskResult(ctx, run, { lines, data: { executed: false, stage: 'plan', mode: 'invite', candidate: { candidate_ref: ref, name: c.name }, missing_details: missing, idempotency_key: key, request_body: body } });
          }
          if (missing.length) return refusal(`The candidate has no ${missing.join(', ')}, so the invitation cannot be sent. Nothing was sent.`);
          const r = await run.call('practical-training.booking-invites.create', { body, confirm: true, idempotency_key: key }, { noPrecheck: true });
          if (!r.ok) return fail(ctx, run, 'The invitation was not sent', r, key);
          const d = r.data ?? {};
          const lines = [environmentLine, `Invitation sent to ${c.name ?? ref}: invite #${d.id ?? '?'} (${d.status ?? 'waiting'}), valid until ${day(d.expires_at)}. The candidate chooses the session and pays when they book.`, `Idempotency key: ${key}.`, `Operations called: ${run.operationsCalled().join(', ')}.`];
          return taskResult(ctx, run, { lines, data: { executed: true, mode: 'invite', invite: { id: d.id, status: d.status, expires_at: d.expires_at }, idempotency_key: key } });
        }

        // ---------- find sessions
        let locationIds: number[] | undefined;
        if (args.location_id === undefined && args.location) {
          const l = await run.get('practical-training.locations.list', { query: { search: args.location, per_page: 25 } });
          if (!l.ok) return fail(ctx, run, 'Locations could not be searched', l);
          locationIds = (Array.isArray(l.data) ? l.data : []).map((x: Json) => Number(x.id));
          if (locationIds!.length === 0) return taskResult(ctx, run, { lines: [`No training location matches "${args.location}". Try part of the name, or omit location.`], data: { executed: false, stage: 'options', options: [] } });
        }
        const baseQuery: Json = {
          available_only: true,
          per_page: OPTION_MAX,
          sort: 'start_date',
          ...(args.course_id !== undefined ? { course_id: args.course_id } : {}),
          ...(args.date_from ? { start_date_from: args.date_from } : {}),
          ...(args.date_to ? { start_date_to: args.date_to } : {}),
        };
        const locs: (number | undefined)[] = args.location_id !== undefined ? [args.location_id] : locationIds && locationIds.length <= 3 ? locationIds : [undefined];
        const lists = await Promise.all(locs.map((id) => run.get('practical-training.events.list', { query: { ...baseQuery, ...(id !== undefined ? { location_id: id } : {}) } })));
        const bad = lists.find((l) => !l.ok);
        if (bad) return fail(ctx, run, 'Sessions could not be listed', bad);
        let events: Json[] = lists.flatMap((l) => (Array.isArray(l.data) ? l.data : []));
        if (locationIds && locs[0] === undefined) events = events.filter((e) => locationIds!.includes(Number(e.location?.id)));
        events = events.filter((e) => Number(e.remaining_slots) > 0).sort((x, y) => String(x.start_date).localeCompare(String(y.start_date))).slice(0, OPTION_MAX);

        const credits = await run.get('practical-training.credits.show', {});
        const creditData = credits.ok ? credits.data ?? {} : undefined;
        const creditsFor = (courseId: unknown): number | undefined => {
          const list: Json[] = Array.isArray(creditData?.booking_credits) ? creditData.booking_credits : [];
          const hit = list.find((x) => Number(x.course_id) === Number(courseId));
          return creditData ? Number(hit?.credits ?? 0) : undefined;
        };

        const options = events.map((e, i) => ({
          option: i + 1, event_id: e.id, course: e.course?.name, course_id: e.course?.id, location: e.location?.name, address: e.location?.address,
          start_date: e.start_date, end_date: e.end_date, remaining_slots: e.remaining_slots, price: money(e.cost_inc_vat_pence, e.currency), booking_credits_for_course: creditsFor(e.course?.id),
        }));

        // ---------- plan for a chosen session
        if (args.event_id !== undefined) {
          const chosen = events.find((e) => Number(e.id) === args.event_id);
          let session = chosen;
          if (!session) {
            const s = await run.get('practical-training.events.show', { path_params: { event: args.event_id } });
            if (!s.ok) return fail(ctx, run, `Session ${args.event_id} could not be read`, s);
            session = s.data;
          }
          const sess = session as Json;
          const need: string[] = [];
          if (!args.pay_option) need.push('pay_option (credits, balance, invoice or candidate_pays)');
          if (!args.agency_contact_name) need.push('agency_contact_name');
          if (!args.agency_contact_email) need.push('agency_contact_email');
          const body: Json | undefined = need.length
            ? undefined
            : { candidate_ref: ref, pay_option: args.pay_option, agency_contact_name: args.agency_contact_name, agency_contact_email: args.agency_contact_email, ...(args.agency_email ? { agency_email: args.agency_email } : {}) };
          const price = money(sess.cost_inc_vat_pence, sess.currency);
          const have = creditsFor(sess.course?.id);
          const cost = args.pay_option ? `Pay option ${args.pay_option}: ${PAY_EXPLAINED[args.pay_option]}.` : 'Choose a pay option.';
          const balanceLine = creditData ? ` Booking credits for this course: ${have}; booking balance ${money(creditData.booking_balance_pence, creditData.currency)}.` : ' Credits could not be checked.';
          if (args.confirm !== true) {
            const lines = [
              environmentLine,
              `PLAN (nothing sent): book ${c.name ?? ref} on ${sess.course?.name ?? 'course'} at ${sess.location?.name ?? '-'}, ${when(sess.start_date)} to ${when(sess.end_date)}, ${sess.remaining_slots ?? '?'} place(s) left, price ${price}. ${cost}${balanceLine}`,
              ...(missing.length ? [`Cannot proceed yet: the candidate has no ${missing.join(', ')}. Add it with hub.candidates.update first.`] : []),
              ...(need.length ? [`Still needed: ${need.join(', ')}.`] : []),
              `Steps on confirm: hold the place (${'practical-training.events.hold'}, takes no seat and no credit), then book it (${'practical-training.bookings.create'}).`,
              `To book, call again with the same arguments plus confirm=true and idempotency_key "${key}", after the user agrees.`,
            ];
            return taskResult(ctx, run, { lines, data: { executed: false, stage: 'plan', candidate: { candidate_ref: ref, name: c.name }, session: { event_id: sess.id, course: sess.course?.name, location: sess.location?.name, start_date: sess.start_date, remaining_slots: sess.remaining_slots, price }, pay_option: args.pay_option, missing_details: missing, still_needed: need, idempotency_key: key, request_body: body } });
          }

          // ---------- confirmed: hold, then book
          if (need.length) return refusal(`Cannot book yet. Still needed: ${need.join(', ')}. Nothing was sent.`);
          if (missing.length) return refusal(`The candidate has no ${missing.join(', ')}; the Hub would reject the booking. Add it with hub.candidates.update. Nothing was sent.`);
          if (Number(sess.remaining_slots) <= 0) return refusal('That session has no free places left. Run the first call again to see other options. Nothing was sent.');

          const hold = await run.call('practical-training.events.hold', { path_params: { event: args.event_id }, confirm: true, idempotency_key: `${key}-hold` }, { noPrecheck: true });
          if (!hold.ok) {
            const extra = hold.status === 409 ? ' The account may hold only one place at a time and already has a live hold (30 minutes). Wait for it to expire, or release it with hb_call_operation practical-training.events.release.' : '';
            return fail(ctx, run, `The place could not be held, nothing was booked.${extra}`, hold, key);
          }
          const hash: string | undefined = hold.data?.hold_hash;
          if (!hash) return fail(ctx, run, 'The hold answer had no hold_hash, nothing was booked', hold, key);
          redactor.add(hash);
          const book = await run.call('practical-training.bookings.create', { body: { hold_hash: hash, ...body }, confirm: true, idempotency_key: `${key}-book` }, { noPrecheck: true });
          if (!book.ok) {
            const unknownOutcome = book.status === undefined && /No answer from the Hub/.test(book.error ?? '') || (book.status ?? 0) >= 500;
            let released = false;
            if (!unknownOutcome) {
              const rel = await run.call('practical-training.events.release', { path_params: { hash } }, { noPrecheck: true });
              released = rel.ok;
            }
            const tail = unknownOutcome
              ? 'The outcome is unknown: do not repeat blindly. Check hb_candidate_overview, or repeat with the same idempotency_key.'
              : released
                ? 'The held place was released. Fix the problem and start again.'
                : 'The held place may still be held for up to 30 minutes.';
            return fail(ctx, run, `The booking was not made. ${tail}`, book, key);
          }
          const b = book.data ?? {};
          const lines = [
            environmentLine,
            `Booked: booking #${b.id ?? '?'} for ${b.candidate_name ?? c.name ?? ref} on ${b.course?.name ?? sess.course?.name ?? 'course'} at ${b.location?.name ?? sess.location?.name ?? '-'}, ${when(b.start_date ?? sess.start_date)}. Status ${b.booking_status ?? '-'}, payment ${b.pay_status ?? '-'} (${b.pay_option ?? args.pay_option}), cost ${money(b.cost_pence, b.currency)}.`,
            ...(args.pay_option === 'candidate_pays' ? ['The candidate was emailed a payment link; the seat is taken when they pay.'] : []),
            `Idempotency key: ${key} (the hold used ${key}-hold and the booking ${key}-book).`,
            `Operations called: ${run.operationsCalled().join(', ')}.`,
          ];
          return taskResult(ctx, run, { lines, data: { executed: true, booking: { id: b.id, booking_status: b.booking_status, pay_status: b.pay_status, pay_option: b.pay_option, start_date: b.start_date, course: b.course, location: b.location, cost_pence: b.cost_pence, currency: b.currency, training_event_id: b.training_event_id }, idempotency_key: key } });
        }

        // ---------- options only
        const lines: string[] = [environmentLine];
        lines.push(`${c.name ?? ref}${c.email ? ` (${c.email})` : ''}.${missing.length ? ` WARNING: no ${missing.join(', ')} on the candidate, so a booking would be rejected until it is added (hub.candidates.update).` : ''}`);
        if (options.length === 0) lines.push('No sessions with free places match. Widen the dates, remove the course or location filter, or use invite=true.');
        else {
          lines.push(`${options.length} session(s) with free places (nothing sent):`);
          lines.push('option | event_id | course | location | start | places | price | your credits for the course');
          for (const o of options) lines.push(`${o.option} | ${o.event_id} | ${o.course} | ${o.location} | ${when(o.start_date)} | ${o.remaining_slots} | ${o.price} | ${o.booking_credits_for_course ?? 'unknown'}`);
        }
        if (creditData) lines.push(`Booking balance ${money(creditData.booking_balance_pence, creditData.currency)}.`);
        else lines.push(`Credits were not checked (${why(credits)}).`);
        if (options.length) lines.push('Next: ask the user which session and how to pay (credits, balance, invoice or candidate_pays), plus the agency contact name and email. Then call again with event_id and those values (still without confirm) to get the plan, and with confirm=true once they agree.');
        lines.push(`Operations called: ${run.operationsCalled().join(', ')}.`);
        return taskResult(ctx, run, { lines, data: { executed: false, stage: 'options', candidate: { candidate_ref: ref, name: c.name }, missing_details: missing, options, booking_balance_pence: creditData?.booking_balance_pence, idempotency_key: key } });
      },
    },
  };
}

// -------------------------------------------------------------------------------- hb_setup_sandbox_webhook

const DEFAULT_EVENTS = [
  'online-training.course.completed',
  'online-training.training.expiring',
  'practical-training.booking.created',
  'practical-training.booking.confirmed',
  'occupational-health.request.submitted',
  'occupational-health.request.full_clearance',
];

const webhookArgs = z.object({
  url: z.string().url().max(2048),
  name: z.string().min(1).max(100).optional(),
  events: z.array(z.string()).min(1).optional(),
  save_secret_to: z.string().optional(),
});

export function setupSandboxWebhookTool(ctx: AppContext): TaskTool {
  return {
    availability: { writes: true, allOf: ['account'] },
    definition: {
      name: 'hb_setup_sandbox_webhook',
      description:
        '[SANDBOX ONLY] Create a webhook endpoint for an https URL with chosen events (default: a sensible set), send a test event and report the delivery result. Refuses on the LIVE Hub. The signing secret is shown only once by the Hub: this tool NEVER returns it in the answer (it is withheld and scrubbed). To keep it, pass `save_secret_to` (an absolute path to a NEW file, written with owner-only permissions on the machine running this server), then put its content in HB_WEBHOOK_SECRET for hb_verify_webhook_signature; otherwise rotate the secret later in the Hub or developer portal. Does not create a second endpoint for a URL that is already registered. Uses webhooks.events.list, webhooks.endpoints.list/.create/.test and webhooks.deliveries.list.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public https URL that receives events (no credentials in it).' },
          name: { type: 'string', description: 'Endpoint name (default "MCP sandbox webhook").' },
          events: { type: 'array', items: { type: 'string' }, description: 'Event names from hb_list_events. Default: course completed, training expiring, booking created and confirmed, OH request submitted and full clearance, plus the seven training-verification events when the key has a training-verification scope.' },
          save_secret_to: { type: 'string', description: 'Absolute path of a new file to write the signing secret to (owner-only). Optional.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { title: 'Set up a sandbox webhook', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (raw) => {
        const a = webhookArgs.safeParse(raw);
        if (!a.success) return refusal(`Invalid arguments: ${a.error.message}`);
        if (ctx.config.mode === 'live') {
          return refusal('hb_setup_sandbox_webhook works on a SANDBOX only, and this server points at the LIVE Hub. Nothing was sent. Register live endpoints deliberately: use hb_call_operation (webhooks.endpoints.create, with its plan and confirm step) or the Hub Developer page, and follow hb://guides/going-live.');
        }
        const run = new TaskRun(ctx);
        try {
          assertWritable(ctx, ['webhooks.endpoints.create', 'webhooks.endpoints.test']);
        } catch (e) {
          if (e instanceof SafetyRefusal) return refusal(`${e.message} Nothing was sent.`);
          throw e;
        }
        await run.loadKey();
        const lacking = missingScopes(ctx, ['webhooks.endpoints.create', 'webhooks.endpoints.test', 'webhooks.deliveries.list'], run);
        if (lacking.length) return refusal(`The key lacks the scope ${lacking.join(', ')}. Ask the user to add it to the key. Nothing was sent.`);
        const u = new URL(a.data.url);
        if (u.protocol !== 'https:' || u.username || u.password) return refusal('The URL must be https with no username or password. Hub refuses http, credentials and private network addresses. Nothing was sent.');

        const known = await run.get('webhooks.events.list', { query: { per_page: 100 } });
        const allowed = new Set<string>(known.ok && Array.isArray(known.data) ? known.data.flatMap((g: Json) => (g.events ?? []).map((e: Json) => String(e.event))) : ctx.catalogue.events.map((e) => e.type));
        const withVerification = ctx.config.toolsets.includes('training-verification') && scopeAllowed(ctx.keyScopes, 'training-verification:read') === true;
        const wanted = a.data.events ?? [...DEFAULT_EVENTS, ...(withVerification ? TV_EVENTS : [])].filter((e) => allowed.has(e));
        const unknown = wanted.filter((e) => !allowed.has(e));
        if (unknown.length) return refusal(`Unknown event(s): ${unknown.join(', ')}. Use hb_list_events for valid names. Nothing was sent.`);
        if (wanted.length === 0) return refusal('No events to subscribe to. Pass `events` (see hb_list_events). Nothing was sent.');

        const existing = await run.get('webhooks.endpoints.list', { query: { per_page: 100 } });
        if (existing.ok) {
          const dup = (Array.isArray(existing.data) ? existing.data : []).find((e: Json) => e.url === a.data.url);
          if (dup) {
            const lines = [
              `An endpoint for this URL already exists: #${dup.id} ${dup.name} (${dup.is_active ? 'active' : 'switched off'}, ${dup.consecutive_failures ?? 0} failures in a row). No second endpoint was created and nothing was sent.`,
              'Its signing secret cannot be read again. To get a new one, rotate it (webhooks.endpoints.rotate-secret via hb_call_operation, or the Hub). To test it, use webhooks.endpoints.test.',
              `Operations called: ${run.operationsCalled().join(', ')}.`,
            ];
            return taskResult(ctx, run, { lines, data: { created: false, existing_endpoint: { id: dup.id, name: dup.name, is_active: dup.is_active } } });
          }
        }

        let secret: string | undefined;
        const created = await run.call('webhooks.endpoints.create', {
          body: { name: a.data.name ?? 'MCP sandbox webhook', url: a.data.url, events: wanted, is_active: true, timeout_seconds: 10 },
          confirm: true,
          onResponse: (json) => {
            const s = (json as Json)?.signing_secret;
            if (typeof s === 'string') {
              secret = s;
              redactor.add(s);
            }
          },
        }, { noPrecheck: true });
        if (!created.ok) {
          const lines = ['The endpoint was not created.', created.error ?? why(created), `Operations called: ${run.operationsCalled().join(', ')}.`];
          return taskResult(ctx, run, { lines, data: { created: false, problem: why(created) } }, true);
        }
        const ep = created.data ?? {};

        let secretLine: string;
        let secretSaved = false;
        if (secret && a.data.save_secret_to) {
          const problem = await saveSecretFile(a.data.save_secret_to, secret);
          secretSaved = problem === undefined;
          secretLine = secretSaved
            ? `The signing secret was saved to ${a.data.save_secret_to} (owner-only). It is not shown here. Put its content in HB_WEBHOOK_SECRET on the receiver and for hb_verify_webhook_signature.`
            : `The signing secret could NOT be saved (${problem}) and was withheld from this answer. Rotate it to get a new one (webhooks.endpoints.rotate-secret) and save it with a valid path.`;
        } else {
          secretLine = 'The signing secret was created and is withheld from this answer (the Hub shows it only once). You did not ask for it to be saved, so rotate it to get a new one when you need it: webhooks.endpoints.rotate-secret, or the Hub Developer page or developer portal. Never paste it in chat.';
        }

        const test = await run.call('webhooks.endpoints.test', { path_params: { webhook: ep.id }, confirm: true }, { noPrecheck: true });
        let deliveryLine: string;
        let delivery: Json | undefined;
        if (!test.ok) {
          deliveryLine = `The test event could not be queued: ${why(test)}.`;
        } else {
          const id = test.data?.delivery_id;
          for (let i = 0; i < 3 && !delivery; i++) {
            if (i > 0) await ctx.sleep(1500);
            const list = await run.call('webhooks.deliveries.list', { path_params: { webhook: ep.id }, query: { per_page: 10, sort: '-id' } }, { noPrecheck: true });
            if (!list.ok) break;
            const hit = (Array.isArray(list.data) ? list.data : []).find((d: Json) => d.id === id);
            if (hit && !['pending', 'queued', 'retrying'].includes(String(hit.status))) delivery = hit;
            else if (hit) delivery = undefined;
          }
          deliveryLine = delivery
            ? `Test event delivery #${delivery.id}: ${delivery.status}${delivery.response_code ? `, your server answered ${delivery.response_code}` : ''}, attempt ${delivery.attempt ?? 1}.${delivery.status === 'delivered' ? '' : ' Check that the URL is public https, answers 2xx quickly and does not redirect.'}`
            : `Test event #${id} was queued; its outcome is not available yet. Check webhooks.deliveries.list for endpoint ${ep.id} in a moment.`;
        }

        const lines = [
          `SANDBOX endpoint created: #${ep.id} ${ep.name}, ${safeUrl(ep.url)}, ${wanted.length} event(s): ${wanted.join(', ')}.`,
          secretLine,
          deliveryLine,
          'Verify deliveries with hb_verify_webhook_signature (raw body, X-Hub-Timestamp, X-Hub-Signature; 300 second window) and dedupe on X-Hub-Event-Id.',
          `Operations called: ${run.operationsCalled().join(', ')}.`,
        ];
        return taskResult(ctx, run, {
          lines,
          data: {
            created: true,
            endpoint: { id: ep.id, name: ep.name, url: safeUrl(ep.url), events: wanted, is_active: ep.is_active, secret_prefix: ep.secret_prefix },
            signing_secret: 'withheld',
            secret_saved_to_file: secretSaved,
            test_event: { queued: test.ok, delivery_id: test.data?.delivery_id, delivery: delivery ? { id: delivery.id, status: delivery.status, response_code: delivery.response_code, attempt: delivery.attempt } : null },
          },
        });
      },
    },
  };
}

export const WRITE_TASKS = [bookPracticalTrainingTool, setupSandboxWebhookTool];
