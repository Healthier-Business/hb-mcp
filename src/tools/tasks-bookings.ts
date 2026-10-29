import { z } from 'zod';
import {
  UUID,
  day,
  emailNote,
  money,
  rows,
  when,
  why,
  type CallOutcome,
  type Json,
} from './task-support.js';
import { done, failed, keyFor, payExplained, send, writeBase, writeTask, type WriteCtx } from './task-kit.js';

const PAY = z.enum(['credits', 'balance', 'invoice', 'candidate_pays']);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TIME = z.string().regex(/^\d{2}:\d{2}$/);

function candidateProblems(c: Json, needPhone = false): string[] {
  const out: string[] = [];
  if (!c.first_name) out.push('the candidate has no first name (add it with hb_save_candidate).');
  if (!c.email) out.push('the candidate has no email address (add it with hb_save_candidate).');
  if (needPhone && !c.phone) out.push('the candidate has no phone number (add it with hb_save_candidate).');
  return out;
}

const hoursUntil = (start: unknown): number | undefined => {
  const t = typeof start === 'string' ? Date.parse(start) : NaN;
  return Number.isNaN(t) ? undefined : (t - Date.now()) / 3_600_000;
};

// ------------------------------------------------------------------------------------------- hb_book_slot

const SLOT_PORTALS = {
  'virtual-bls-training': {
    label: 'virtual BLS', typeKey: 'course_id', typeList: 'virtual-bls-training.courses.list', slots: 'virtual-bls-training.timeslots.list',
    hold: 'virtual-bls-training.timeslots.hold', release: 'virtual-bls-training.timeslots.release', create: 'virtual-bls-training.bookings.create', credits: 'virtual-bls-training.credits.show',
  },
  'clinical-interviews': {
    label: 'clinical interview', typeKey: 'interview_type_id', typeList: 'clinical-interviews.interview-types.list', slots: 'clinical-interviews.timeslots.list',
    hold: 'clinical-interviews.timeslots.hold', release: 'clinical-interviews.timeslots.release', create: 'clinical-interviews.bookings.create', credits: 'clinical-interviews.credits.show',
  },
  'clinical-appraisals': {
    label: 'clinical appraisal', typeKey: 'appraisal_type_id', typeList: 'clinical-appraisals.appraisal-types.list', slots: undefined,
    hold: undefined, release: undefined, create: 'clinical-appraisals.bookings.create', credits: 'clinical-appraisals.credits.show',
  },
} as const;

const slotArgs = z.object({
  portal: z.enum(['virtual-bls-training', 'clinical-interviews', 'clinical-appraisals']),
  candidate_ref: z.string(),
  course_id: z.number().int().optional(),
  interview_type_id: z.number().int().optional(),
  appraisal_type_id: z.number().int().optional(),
  date: DATE.optional(),
  time: TIME.optional(),
  months_ahead: z.number().int().min(1).max(12).optional(),
  pay_option: PAY.optional(),
  agency_contact_name: z.string().max(150).optional(),
  agency_contact_email: z.string().email().max(255).optional(),
  agency_email: z.string().email().max(255).optional(),
  address: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  postcode: z.string().max(20).optional(),
  phone: z.string().max(30).optional(),
  job_role: z.string().max(100).optional(),
  nmc_number: z.string().max(20).optional(),
  nursing_band: z.string().max(30).optional(),
  video_call_awareness: z.boolean().optional(),
  photo_id_awareness: z.boolean().optional(),
  ...writeBase,
});

const typeIdOf = (a: z.infer<typeof slotArgs>): number | undefined => (a.portal === 'virtual-bls-training' ? a.course_id : a.portal === 'clinical-interviews' ? a.interview_type_id : a.appraisal_type_id);

export const bookSlotTool = writeTask({
  name: 'hb_book_slot',
  title: 'Book a timeslot or appraisal',
  description:
    'Guided booking in two calls for a virtual BLS timeslot, a clinical interview timeslot, or a clinical appraisal (param `portal`). CALL 1 (no confirm): lists the course or type choices, then the free timeslots, checks the candidate and the credits, and returns the plan; nothing is changed. CALL 2 with confirm=true after the user approved: holds the slot, creates the booking (idempotency keys) and releases its own hold if the booking is rejected. Appraisals have no slot: they need video_call_awareness and photo_id_awareness set to true by the user. Virtual BLS needs the candidate\'s address, city and postcode. Uses the portal\'s catalogue, timeslots.list/.hold/.release, bookings.create, credits.show and hub.candidates.show. Uses credits or balance; on live the candidate and agency are emailed.',
  properties: {
    portal: { type: 'string', enum: ['virtual-bls-training', 'clinical-interviews', 'clinical-appraisals'] },
    candidate_ref: { type: 'string', description: 'The candidate_ref uuid.' },
    course_id: { type: 'integer', description: 'Virtual BLS course id.' },
    interview_type_id: { type: 'integer', description: 'Clinical interview type id.' },
    appraisal_type_id: { type: 'integer', description: 'Clinical appraisal type id.' },
    date: { type: 'string', description: 'Chosen (or searched) day, YYYY-MM-DD, UK local.' },
    time: { type: 'string', description: 'Chosen start time HH:MM, UK local, from the options.' },
    months_ahead: { type: 'integer', description: 'How far ahead to look for slots.' },
    pay_option: { type: 'string', enum: ['credits', 'balance', 'invoice', 'candidate_pays'] },
    agency_contact_name: { type: 'string' },
    agency_contact_email: { type: 'string' },
    agency_email: { type: 'string', description: 'Optional address for the agency confirmation.' },
    address: { type: 'string', description: 'Virtual BLS: candidate address.' },
    city: { type: 'string', description: 'Virtual BLS: candidate city.' },
    postcode: { type: 'string', description: 'Virtual BLS: candidate postcode.' },
    phone: { type: 'string', description: 'Interviews and appraisals: candidate phone (optional).' },
    job_role: { type: 'string' },
    nmc_number: { type: 'string' },
    nursing_band: { type: 'string', description: 'Interviews: optional.' },
    video_call_awareness: { type: 'boolean', description: 'Appraisals: the user confirmed the candidate knows the appraisal is a video call.' },
    photo_id_awareness: { type: 'boolean', description: 'Appraisals: the user confirmed the candidate knows to bring photo ID.' },
  },
  required: ['portal', 'candidate_ref'],
  schema: slotArgs,
  availability: { allOf: ['hub'], anyOf: ['virtual-bls-training', 'clinical-interviews', 'clinical-appraisals'] },
  ops: (a) => {
    const p = SLOT_PORTALS[a.portal];
    return ['hub.candidates.show', p.typeList, ...(p.slots ? [p.slots, p.hold!, p.release!] : []), p.create, p.credits];
  },
  plan: async (c) => {
    const { run, args } = c;
    const p = SLOT_PORTALS[args.portal];
    const ref = args.candidate_ref.trim().toLowerCase();
    if (!UUID.test(ref)) return { lines: [], problems: ['candidate_ref must be a uuid (hb_find_candidate).'] };
    const lines: string[] = [];
    const problems: string[] = [];
    const cand = await run.get('hub.candidates.show', { path_params: { candidate_ref: ref } });
    if (!cand.ok) return { lines: [`The candidate could not be read: ${why(cand)}.`], problems: ['the candidate could not be read.'] };
    const cd = cand.data ?? {};
    problems.push(...candidateProblems(cd, false));
    lines.push(`Booking a ${p.label} for ${cd.name ?? ref}${cd.email ? ` (${cd.email})` : ''}.`);

    const typeId = typeIdOf(args);
    const types = await run.get(p.typeList, { query: { per_page: 50 } });
    const typeRows = rows(types);
    if (typeId === undefined) {
      lines.push(`Choose a ${args.portal === 'virtual-bls-training' ? 'course' : 'type'} (${p.typeKey}):`);
      for (const t of typeRows) lines.push(`  - ${t.id} ${t.name}${t.client_rate_pence != null ? `, ${money(t.client_rate_pence, t.currency)}` : t.price_inc_vat_pence != null ? `, ${money(t.price_inc_vat_pence, t.currency)}` : ''}`);
      problems.push(`${p.typeKey} is needed.`);
      return { lines, problems, data: { stage: 'choose_type', types: typeRows.map((t) => ({ id: t.id, name: t.name })) } };
    }
    const chosenType = typeRows.find((t) => Number(t.id) === typeId);
    const unit = chosenType?.client_rate_pence ?? chosenType?.price_inc_vat_pence;
    lines.push(`${chosenType?.name ?? `${p.typeKey} ${typeId}`}${unit != null ? `, price ${money(unit, chosenType?.currency)}` : ''}.`);

    let slotOptions: Json[] = [];
    if (p.slots) {
      const slots = await run.get(p.slots, { query: { [p.typeKey]: typeId, per_page: 25, sort: 'date', ...(args.date ? { date: args.date } : {}), ...(args.months_ahead ? { months_ahead: args.months_ahead } : {}) } });
      if (!slots.ok) {
        problems.push(`timeslots could not be listed (${why(slots)}).`);
      } else {
        slotOptions = rows(slots);
        lines.push(slotOptions.length ? `Free timeslots (UK local time):` : 'No free timeslots match. Widen the date or months_ahead.');
        for (const s of slotOptions.slice(0, 15)) lines.push(`  - ${s.date} ${s.time}`);
        if (args.date && args.time) {
          if (!slotOptions.some((s) => s.date === args.date && s.time === args.time)) problems.push(`${args.date} ${args.time} is not a free timeslot.`);
        } else problems.push('choose a date and time from the options.');
      }
    }

    const credits = await run.get(p.credits, {});
    if (credits.ok) {
      const d = credits.data ?? {};
      const list: Json[] = Array.isArray(d.booking_credits) ? d.booking_credits : [];
      const mine = list.find((x) => Number(x.course_id ?? x.interview_type_id ?? x.appraisal_type_id) === typeId);
      lines.push(`Credits for this ${p.label}: ${mine?.credits ?? 0}; money balance ${money(d.booking_balance_pence ?? d.booking_money_balance_pence, d.currency)}.`);
    } else lines.push(`Credits were not checked (${why(credits)}).`);

    if (!args.pay_option) problems.push('pay_option is needed (credits, balance, invoice or candidate_pays).');
    else lines.push(`Pay option ${args.pay_option}: ${payExplained(args.pay_option)}.`);
    if (!args.agency_contact_name || !args.agency_contact_email) problems.push('agency_contact_name and agency_contact_email are needed.');
    if (args.portal === 'virtual-bls-training' && (!args.address || !args.city || !args.postcode)) problems.push("the candidate's address, city and postcode are needed for virtual BLS.");
    if (args.portal === 'clinical-appraisals' && (args.video_call_awareness !== true || args.photo_id_awareness !== true)) problems.push('the user must confirm that the candidate knows the appraisal is a video call (video_call_awareness=true) and needs photo ID (photo_id_awareness=true).');
    lines.push(c.live ? 'On confirm the candidate and the agency are emailed (real people on live) and credits or balance are taken.' : 'On confirm the booking is made in the sandbox (emails go to the sandbox inbox).');
    if (p.hold) lines.push(`Steps on confirm: hold the slot (${p.hold}, no charge), then create the booking (${p.create}); the hold is released if the booking is rejected.`);
    return { lines, problems, data: { stage: 'plan', portal: args.portal, candidate: { candidate_ref: ref, name: cd.name }, type_id: typeId, slots: slotOptions.slice(0, 25), pay_option: args.pay_option } };
  },
  execute: async (c) => {
    const { args, run } = c;
    const p = SLOT_PORTALS[args.portal];
    const ref = args.candidate_ref.trim().toLowerCase();
    const typeId = typeIdOf(args) as number;
    const agency = { pay_option: args.pay_option, agency_contact_name: args.agency_contact_name, agency_contact_email: args.agency_contact_email, ...(args.agency_email ? { agency_email: args.agency_email } : {}) };
    let hash: string | undefined;
    if (p.hold) {
      const hold = await send(c as WriteCtx<unknown>, p.hold, { body: { [p.typeKey]: typeId, date: args.date, time: args.time } }, 'hold');
      if (!hold.ok) return failed(c, `The slot could not be held, nothing was booked.${hold.status === 409 ? ' The account may already hold a slot; wait for it to expire.' : ''}`, hold);
      hash = hold.data?.hold_hash;
      if (!hash) return failed(c, 'The hold answer had no hold_hash, nothing was booked', hold);
    }
    const body: Json =
      args.portal === 'virtual-bls-training'
        ? { hold_hash: hash, candidate_ref: ref, address: args.address, city: args.city, postcode: args.postcode, ...agency }
        : args.portal === 'clinical-interviews'
          ? { hold_hash: hash, candidate_ref: ref, ...agency, ...(args.phone ? { phone: args.phone } : {}), ...(args.job_role ? { job_role: args.job_role } : {}), ...(args.nmc_number ? { nmc_number: args.nmc_number } : {}), ...(args.nursing_band ? { nursing_band: args.nursing_band } : {}) }
          : { appraisal_type_id: typeId, candidate_ref: ref, ...agency, video_call_awareness: args.video_call_awareness, photo_id_awareness: args.photo_id_awareness, ...(args.phone ? { phone: args.phone } : {}), ...(args.job_role ? { job_role: args.job_role } : {}), ...(args.nmc_number ? { nmc_number: args.nmc_number } : {}) };
    const book = await send(c as WriteCtx<unknown>, p.create, { body }, 'book');
    if (!book.ok) {
      let tail = '';
      const unknown = (book.status === undefined && /No answer from the Hub/.test(book.error ?? '')) || (book.status ?? 0) >= 500;
      if (hash && p.release && !unknown) {
        const rel = await run.call(p.release, { path_params: { hash } }, { noPrecheck: true });
        tail = rel.ok ? 'The held slot was released.' : 'The held slot may still be held for a few minutes.';
      }
      return failed(c, 'The booking was not made', book, tail || undefined);
    }
    const b = book.data ?? {};
    return done(c, [`Booked ${p.label} #${b.id ?? '?'} for ${b.candidate_name ?? ref}: ${b.booking_status ?? '-'}, payment ${b.pay_status ?? '-'} (${b.pay_option ?? args.pay_option}), ${b.start_date ? when(b.start_date) : 'time to be arranged'}.`, ...(args.pay_option === 'candidate_pays' ? ['The candidate was emailed a payment link.'] : [])], {
      booking: { id: b.id, booking_status: b.booking_status, pay_status: b.pay_status, pay_option: b.pay_option, start_date: b.start_date },
    });
  },
});

// ------------------------------------------------------------------------------------- hb_change_booking

const CHANGE = {
  'practical-training': { label: 'practical training', show: 'practical-training.bookings.show', cancel: 'practical-training.bookings.cancel', reschedule: undefined, slots: undefined, typeKey: undefined, windowHours: 48 },
  'virtual-bls-training': { label: 'virtual BLS', show: 'virtual-bls-training.bookings.show', cancel: 'virtual-bls-training.bookings.cancel', reschedule: 'virtual-bls-training.bookings.reschedule', slots: 'virtual-bls-training.timeslots.list', typeKey: 'course_id', windowHours: 120 },
  'clinical-interviews': { label: 'clinical interview', show: 'clinical-interviews.bookings.show', cancel: 'clinical-interviews.bookings.cancel', reschedule: 'clinical-interviews.bookings.reschedule', slots: 'clinical-interviews.timeslots.list', typeKey: 'interview_type_id', windowHours: 24 },
} as const;

const REFUND_RULES: Record<string, string> = {
  'practical-training': 'Cancelling: a booking paid with credits or balance gets it back when the session is 48 hours or more away (or inside 48 hours if the account still has a free cancellation this month); card payments are refunded in full outside 48 hours, 20% if the candidate already used the online training, nothing inside 48 hours; invoiced bookings are not charged. The candidate is emailed.',
  'virtual-bls-training': 'Cancelling: more than 120 hours (5 days) before the start the booking is refund eligible and refunded automatically to credits, balance or card; inside 120 hours nothing is refunded. The trainer and the Zoom meeting are released and the candidate is emailed. Rescheduling inside 120 hours needs a flat fee paid first (the call answers 402 payment_required with a payment_url).',
  'clinical-interviews': 'Cancelling: 24 hours or more before the start is free (credit, money or card is given back, invoiced interviews are left off the invoice); under 24 hours is a late cancellation with nothing given back. Rescheduling: free with 24 hours notice; under 24 hours it counts as a late cancellation plus a new booking (credits get one free late reschedule, then a new credit is taken). The candidate, agency contact and interviewer are emailed.',
};

const changeArgs = z.object({
  portal: z.enum(['practical-training', 'virtual-bls-training', 'clinical-interviews']),
  booking_id: z.number().int(),
  action: z.enum(['cancel', 'reschedule']),
  date: DATE.optional(),
  time: TIME.optional(),
  ...writeBase,
});

export const changeBookingTool = writeTask({
  name: 'hb_change_booking',
  title: 'Cancel or reschedule a booking',
  description:
    'Cancel (practical training, virtual BLS, clinical interviews) or reschedule (virtual BLS and clinical interviews only: the API has no reschedule for practical training) a booking, in two calls. CALL 1 shows the booking, whether it can be changed, how far away it is and the refund or fee rules of that portal (what is paid back, or whether a late cancellation applies), and for a reschedule checks the new slot is free; nothing is changed. CALL 2 with confirm=true does it and reports the refund or fee fields the API returns. The candidate is emailed (a real person on live). Cancelling is hard to undo. Uses the portal\'s bookings.show/.cancel/.reschedule and timeslots.list.',
  properties: {
    portal: { type: 'string', enum: ['practical-training', 'virtual-bls-training', 'clinical-interviews'] },
    booking_id: { type: 'integer' },
    action: { type: 'string', enum: ['cancel', 'reschedule'] },
    date: { type: 'string', description: 'Reschedule: new day YYYY-MM-DD (UK local).' },
    time: { type: 'string', description: 'Reschedule: new start time HH:MM (UK local).' },
  },
  required: ['portal', 'booking_id', 'action'],
  schema: changeArgs,
  availability: { anyOf: ['practical-training', 'virtual-bls-training', 'clinical-interviews'] },
  destructive: true,
  idempotent: false,
  ops: (a) => {
    const p = CHANGE[a.portal];
    return a.action === 'cancel' ? [p.show, p.cancel] : p.reschedule ? [p.show, p.reschedule, p.slots!] : [p.show];
  },
  plan: async (c) => {
    const { run, args } = c;
    const p = CHANGE[args.portal];
    const problems: string[] = [];
    if (args.action === 'reschedule' && !p.reschedule) return { lines: [`The API has no reschedule for ${p.label} bookings. Cancel and book again (hb_book_practical_training) instead.`], problems: ['reschedule is not available for this portal.'] };
    const show = await run.get(p.show, { path_params: { booking: args.booking_id } });
    if (!show.ok) return { lines: [`The booking could not be read: ${why(show)}.`], problems: ['the booking could not be read.'] };
    const b = show.data ?? {};
    const lines = [`${p.label} booking #${b.id}: ${b.candidate_name ?? b.candidate_ref}, ${b.course?.name ?? b.interview_type?.name ?? ''}, ${when(b.start_date)}, status ${b.booking_status}, payment ${b.pay_status ?? '-'} (${b.pay_option ?? '-'}), cost ${money(b.cost_pence, b.currency)}.`];
    const hours = hoursUntil(b.start_date);
    if (hours !== undefined) {
      lines.push(hours < 0 ? 'The session has already started.' : `The session starts in about ${Math.round(hours)} hour(s): ${hours >= p.windowHours ? `outside the ${p.windowHours}-hour window` : `INSIDE the ${p.windowHours}-hour window (late change)`}.`);
      if (hours < 0) problems.push('the session has already started.');
    }
    lines.push(REFUND_RULES[args.portal] as string);
    if (b.refund_eligible != null) lines.push(`The API reports refund_eligible=${b.refund_eligible}.`);
    if (!['booked', 'rescheduled'].includes(String(b.booking_status))) problems.push(`the booking is ${b.booking_status}; only booked or rescheduled bookings can be changed.`);
    if (args.action === 'cancel' && b.can_cancel === false) problems.push('the API says this booking cannot be cancelled (can_cancel is false).');
    if (args.action === 'reschedule') {
      if (b.can_reschedule === false) problems.push('the API says this booking cannot be rescheduled.');
      if (!args.date || !args.time) problems.push('date and time of the new slot are needed.');
      else if (p.slots) {
        const typeId = b.course?.id ?? b.interview_type?.id;
        const slots = await run.get(p.slots, { query: { [p.typeKey as string]: typeId, date: args.date, per_page: 50 } });
        if (!slots.ok) problems.push(`the new slot could not be checked (${why(slots)}).`);
        else if (!rows(slots).some((s) => s.date === args.date && s.time === args.time)) problems.push(`${args.date} ${args.time} is not a free slot.`);
        else lines.push(`The new slot ${args.date} ${args.time} is free.`);
      }
    }
    lines.push(`${args.action === 'cancel' ? 'Cancelling' : 'Rescheduling'} emails the candidate${c.live ? ' (a real person on LIVE)' : ' (sandbox inbox)'}.`);
    return { lines, problems, data: { booking: { id: b.id, status: b.booking_status, start_date: b.start_date, hours_until_start: hours === undefined ? undefined : Math.round(hours) } } };
  },
  execute: async (c) => {
    const { args } = c;
    const p = CHANGE[args.portal];
    if (args.action === 'cancel') {
      const r = await send(c as WriteCtx<unknown>, p.cancel, { path_params: { booking: args.booking_id } }, 'cancel');
      if (!r.ok) return failed(c, 'The booking was not cancelled', r);
      const b = r.data ?? {};
      const refund = b.refund ? `refund: ${b.refund.method ?? '-'}${b.refund.amount_pence != null ? ` ${money(b.refund.amount_pence, b.refund.currency)}` : ''}${b.refund.credits ? `, ${b.refund.credits} credit(s)` : ''}` : b.refund_eligible != null ? `refund_eligible=${b.refund_eligible}${b.late_cancellation != null ? `, late_cancellation=${b.late_cancellation}` : ''}` : 'no refund information returned';
      return done(c, [`Cancelled ${p.label} booking #${b.id ?? args.booking_id}: status ${b.booking_status ?? '-'}; ${refund}.`], { booking: { id: b.id, status: b.booking_status, refund: b.refund, refund_eligible: b.refund_eligible, late_cancellation: b.late_cancellation } });
    }
    const r = await send(c as WriteCtx<unknown>, p.reschedule as string, { path_params: { booking: args.booking_id }, body: { date: args.date, time: args.time } }, 'reschedule');
    if (!r.ok) return failed(c, 'The booking was not rescheduled', r, r.code === 'payment_required' ? 'A late-change fee must be paid first: the candidate pays on the payment_url in the error, then repeat this call.' : undefined);
    const b = r.data ?? {};
    return done(c, [`Rescheduled ${p.label} booking #${b.id ?? args.booking_id} to ${when(b.start_date)}: status ${b.booking_status ?? '-'}.`], { booking: { id: b.id, status: b.booking_status, start_date: b.start_date } });
  },
});

// ------------------------------------------------------------------------------------ hb_invite_to_practical

const inviteArgs = z.object({
  action: z.enum(['create', 'list', 'delete']),
  candidate_ref: z.string().optional(),
  invite_id: z.number().int().optional(),
  state: z.enum(['unsent', 'waiting', 'used']).optional(),
  contact_name: z.string().max(150).optional(),
  contact_email: z.string().email().max(255).optional(),
  ...writeBase,
});

export const inviteToPracticalTool = writeTask({
  name: 'hb_invite_to_practical',
  title: 'Practical training invitations',
  description:
    'Practical training booking invitations: `action` create (email a candidate a one-time link, valid 8 weeks, to choose their own session; nothing is charged until they book), list (invitations and the account booking link; read-only, no confirm), or delete (withdraw an unused invitation). Create and delete are two calls: the first returns the plan and sends nothing, the second needs confirm=true. The candidate is emailed on create (a real person on live). The invitation\'s one-time link is not shown. Needs booking invitations switched on for the account (otherwise 403 invites_not_enabled). Uses practical-training.booking-invites.create/.list/.show/.delete, .booking-link.show and hub.candidates.show.',
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'delete'] },
    candidate_ref: { type: 'string', description: 'create: the person to invite; list: filter.' },
    invite_id: { type: 'integer', description: 'delete: the invitation id.' },
    state: { type: 'string', enum: ['unsent', 'waiting', 'used'], description: 'list: filter by state.' },
    contact_name: { type: 'string', description: 'create: person copied in (optional).' },
    contact_email: { type: 'string', description: 'create: their email (optional).' },
  },
  required: ['action'],
  schema: inviteArgs,
  availability: { allOf: ['practical-training'] },
  destructive: true,
  idempotent: false,
  ops: (a) => (a.action === 'create' ? ['hub.candidates.show', 'practical-training.booking-invites.create'] : a.action === 'delete' ? ['practical-training.booking-invites.show', 'practical-training.booking-invites.delete'] : []),
  plan: async (c) => {
    const { run, args } = c;
    if (args.action === 'list') {
      if (args.candidate_ref && !UUID.test(args.candidate_ref)) return { lines: ['candidate_ref must be a uuid.'], readOnlyAction: true };
      const [list, link] = await Promise.all([
        run.get('practical-training.booking-invites.list', { query: { per_page: 25, ...(args.candidate_ref ? { candidate_ref: args.candidate_ref } : {}), ...(args.state ? { state: args.state } : {}) } }),
        run.get('practical-training.booking-link.show', {}),
      ]);
      const lines: string[] = [];
      if (list.ok) {
        const inv = rows(list);
        lines.push(inv.length ? `${inv.length} invitation(s):` : 'No invitations.');
        for (const i of inv) lines.push(`  - #${i.id} ${i.candidate_name ?? i.candidate_ref}: ${i.status}, expires ${day(i.expires_at)}${i.booking_id ? `, booking #${i.booking_id}` : ''}`);
        lines.push("The invitations' one-time links are not shown here (they were emailed to the candidates).");
      } else lines.push(`Invitations could not be listed: ${why(list)}${list.code === 'invites_not_enabled' ? ' (booking invitations are not switched on for this account)' : ''}.`);
      if (link.ok) lines.push(`Account booking link: ${link.data?.booking_url ?? '-'}`);
      return { lines, readOnlyAction: true, data: { invitations: list.ok ? rows(list).map((i) => ({ id: i.id, candidate_ref: i.candidate_ref, status: i.status, expires_at: i.expires_at, booking_id: i.booking_id })) : [], booking_url: link.ok ? link.data?.booking_url : undefined } };
    }
    if (args.action === 'create') {
      const ref = (args.candidate_ref ?? '').toLowerCase();
      if (!UUID.test(ref)) return { lines: [], problems: ['candidate_ref (uuid) is needed.'] };
      const cand = await run.get('hub.candidates.show', { path_params: { candidate_ref: ref } });
      if (!cand.ok) return { lines: [], problems: [`the candidate could not be read (${why(cand)}).`] };
      const cd = cand.data ?? {};
      const problems = cd.email ? [] : ['the candidate has no email address (hb_save_candidate).'];
      const link = await run.get('practical-training.booking-link.show', {});
      return {
        lines: [`Invite ${cd.name ?? ref}: ${emailNote(c.ctx, `${cd.email ?? 'the candidate'}`)} The link is valid for 8 weeks and lets them choose a session; the account pays when they book (this call only checks the account can pay).${args.contact_email ? ` ${args.contact_name ?? args.contact_email} is copied in.` : ''}`, ...(link.ok ? [`Account booking link (generic): ${link.data?.booking_url}`] : [])],
        problems,
        data: { candidate: { candidate_ref: ref, name: cd.name } },
      };
    }
    if (args.invite_id === undefined) return { lines: [], problems: ['invite_id is needed.'] };
    const show = await run.get('practical-training.booking-invites.show', { path_params: { invite: args.invite_id } });
    if (!show.ok) return { lines: [], problems: [`the invitation could not be read (${why(show)}).`] };
    const i = show.data ?? {};
    return { lines: [`Withdraw invitation #${i.id} for ${i.candidate_name ?? i.candidate_ref} (${i.status}, expires ${day(i.expires_at)}). Its link stops working. Withdrawing is hard to undo.`], problems: i.status === 'used' ? ['the invitation was already used to make booking #' + i.booking_id + '; cancel the booking with hb_change_booking instead.'] : [], data: { invitation: { id: i.id, status: i.status } } };
  },
  execute: async (c) => {
    const { args } = c;
    if (args.action === 'create') {
      const body: Json = { candidate_ref: (args.candidate_ref as string).toLowerCase(), ...(args.contact_name ? { contact_name: args.contact_name } : {}), ...(args.contact_email ? { contact_email: args.contact_email } : {}) };
      const r = await send(c as WriteCtx<unknown>, 'practical-training.booking-invites.create', { body }, 'invite');
      if (!r.ok) return failed(c, 'The invitation was not sent', r);
      return done(c, [`Invitation #${r.data?.id ?? '?'} sent: ${r.data?.status ?? 'waiting'}, valid until ${day(r.data?.expires_at)}.`], { invitation: { id: r.data?.id, status: r.data?.status, expires_at: r.data?.expires_at } });
    }
    const r = await send(c as WriteCtx<unknown>, 'practical-training.booking-invites.delete', { path_params: { invite: args.invite_id } }, 'delete');
    if (!r.ok) return failed(c, 'The invitation was not withdrawn', r);
    return done(c, [`Invitation #${args.invite_id} withdrawn.`], { withdrawn: true });
  },
});

export { keyFor };
export type { CallOutcome };
