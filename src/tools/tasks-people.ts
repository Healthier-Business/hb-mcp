import { z } from 'zod';
import { UUID, day, emailNote, money, rows, when, why, type Json } from './task-support.js';
import { done, failed, send, writeBase, writeTask, type WriteCtx } from './task-kit.js';

const ref = (v: string | undefined): string => (v ?? '').trim().toLowerCase();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(Array.isArray(a) ? [...a].sort() : a ?? null) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b ?? null);

// ------------------------------------------------------------------------------------- hb_save_candidate

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'roles', 'specialties', 'candidate_reference', 'compliance_officer', 'is_active'] as const;

const saveArgs = z.object({
  candidate_ref: z.string().optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(30).optional(),
  roles: z.array(z.string()).max(10).optional(),
  specialties: z.array(z.string()).max(10).optional(),
  candidate_reference: z.string().max(100).optional(),
  compliance_officer: z.string().max(150).optional(),
  is_active: z.boolean().optional(),
  allow_duplicate: z.boolean().optional(),
  ...writeBase,
});

const fieldsOf = (a: z.infer<typeof saveArgs>): Record<string, unknown> => Object.fromEntries(FIELDS.filter((f) => a[f] !== undefined).map((f) => [f, a[f]]));

export const saveCandidateTool = writeTask({
  name: 'hb_save_candidate',
  title: 'Create or update a candidate',
  description:
    'Create a new candidate, or update an existing one (pass candidate_ref), in two calls. Creating first searches for an existing candidate with the same email or name and REFUSES to create a duplicate unless allow_duplicate=true. Updating shows a field-by-field before and after in the plan. CALL 1 sends nothing; CALL 2 needs confirm=true. Creating emails the candidate an activation link unless is_active is false (a real person on live). Uses hub.candidates.list, .show, .create and .update (create takes an idempotency key).',
  properties: {
    candidate_ref: { type: 'string', description: 'Update this candidate. Omit to create.' },
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' }, description: 'Up to 10 role names.' },
    specialties: { type: 'array', items: { type: 'string' }, description: 'Up to 10.' },
    candidate_reference: { type: 'string', description: "The client's own reference for the person." },
    compliance_officer: { type: 'string' },
    is_active: { type: 'boolean', description: 'false creates the candidate without sending an activation email.' },
    allow_duplicate: { type: 'boolean', description: 'Create even though a candidate with the same email or name exists (the Hub still refuses a repeated email).' },
  },
  schema: saveArgs,
  availability: { allOf: ['hub'] },
  ops: (a) => (a.candidate_ref ? ['hub.candidates.show', 'hub.candidates.update'] : ['hub.candidates.list', 'hub.candidates.create']),
  plan: async (c) => {
    const { run, args } = c;
    const wanted = fieldsOf(args);
    if (args.candidate_ref) {
      const r = ref(args.candidate_ref);
      if (!UUID.test(r)) return { lines: [], problems: ['candidate_ref must be a uuid.'] };
      const show = await run.get('hub.candidates.show', { path_params: { candidate_ref: r } });
      if (!show.ok) return { lines: [], problems: [`the candidate could not be read (${why(show)}).`] };
      const cur = show.data ?? {};
      const diff = Object.entries(wanted).filter(([k, v]) => !same(cur[k], v));
      const lines = [`Update ${cur.name ?? r}:`];
      for (const [k, v] of diff) lines.push(`  - ${k}: ${JSON.stringify(cur[k] ?? null)} -> ${JSON.stringify(v)}`);
      const unchanged = Object.keys(wanted).filter((k) => same(cur[k], wanted[k]));
      if (unchanged.length) lines.push(`  (already as asked: ${unchanged.join(', ')})`);
      if (diff.some(([k]) => k === 'email')) lines.push('Changing the email changes where the candidate\'s emails go.');
      return { lines, problems: diff.length ? [] : ['nothing would change.'], data: { mode: 'update', candidate_ref: r, changes: diff.map(([k, v]) => ({ field: k, from: cur[k] ?? null, to: v })) } };
    }
    const problems: string[] = [];
    for (const f of ['first_name', 'last_name', 'email'] as const) if (!args[f]) problems.push(`${f} is needed to create a candidate.`);
    const lines = [`Create candidate ${args.first_name ?? ''} ${args.last_name ?? ''} <${args.email ?? '?'}>${args.roles?.length ? `, roles ${args.roles.join(', ')}` : ''}.`];
    let matches: Json[] = [];
    if (args.email) {
      const byEmail = await run.get('hub.candidates.list', { query: { search: args.email, per_page: 10 } });
      if (byEmail.ok) matches = rows(byEmail).filter((x) => String(x.email ?? '').toLowerCase() === args.email!.toLowerCase());
      else problems.push(`the duplicate check failed (${why(byEmail)}).`);
    }
    let nameMatches: Json[] = [];
    if (args.first_name && args.last_name) {
      const byName = await run.get('hub.candidates.list', { query: { search: `${args.first_name} ${args.last_name}`, per_page: 10 } });
      if (byName.ok) nameMatches = rows(byName).filter((x) => String(x.name ?? '').toLowerCase() === `${args.first_name} ${args.last_name}`.toLowerCase());
    }
    const all = [...matches, ...nameMatches.filter((n) => !matches.some((m) => m.candidate_ref === n.candidate_ref))];
    if (all.length) {
      lines.push('Possible duplicate(s) already exist:');
      for (const m of all) lines.push(`  - ${m.candidate_ref}: ${m.name}, ${m.email}${matches.includes(m) ? ' (same email)' : ' (same name)'}`);
      if (args.allow_duplicate !== true) problems.push('a candidate like this already exists. Use that candidate_ref to update them, or pass allow_duplicate=true to create anyway (the Hub still refuses an email it already has).');
    }
    lines.push(args.is_active === false ? 'No activation email is sent (is_active false).' : emailNote(c.ctx, `${args.email ?? 'the candidate'}`).replace('An email', 'An activation email').replace('will be sent', 'will be sent unless the account activates candidates by hand'));
    return { lines, problems, data: { mode: 'create', duplicates: all.map((m) => ({ candidate_ref: m.candidate_ref, name: m.name })) } };
  },
  execute: async (c) => {
    const { args, run } = c;
    const wanted = fieldsOf(args);
    if (args.candidate_ref) {
      const r = ref(args.candidate_ref);
      const show = await run.get('hub.candidates.show', { path_params: { candidate_ref: r } });
      const cur = show.data ?? {};
      const body = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => !same(cur[k], v)));
      const u = await send(c as WriteCtx<unknown>, 'hub.candidates.update', { path_params: { candidate_ref: r }, body }, 'update');
      if (!u.ok) return failed(c, 'The candidate was not updated', u);
      return done(c, [`Updated ${u.data?.name ?? r}: ${Object.keys(body).join(', ')}.`], { candidate: { candidate_ref: r, name: u.data?.name } });
    }
    const cr = await send(c as WriteCtx<unknown>, 'hub.candidates.create', { body: wanted }, 'create');
    if (!cr.ok) return failed(c, 'The candidate was not created', cr);
    return done(c, [`Created ${cr.data?.name ?? 'candidate'}: candidate_ref ${cr.data?.candidate_ref}.`], { candidate: { candidate_ref: cr.data?.candidate_ref, name: cr.data?.name, is_active: cr.data?.is_active } });
  },
});

// ------------------------------------------------------------------------------------ hb_assign_training

const assignArgs = z.object({
  candidate_ref: z.string(),
  course_ids: z.array(z.number().int()).min(1),
  remove_course_ids: z.array(z.number().int()).optional(),
  training_charge: z.enum(['client', 'candidate']).optional(),
  renewal_mode: z.enum(['auto', 'manual']).optional(),
  send_reminders: z.boolean().optional(),
  send_activation_email: z.boolean().optional(),
  send_email: z.enum(['training_reminder', 'course_completion_reminder']).optional(),
  ...writeBase,
});

export const assignTrainingTool = writeTask({
  name: 'hb_assign_training',
  title: 'Assign online courses',
  description:
    'Assign online training courses to a candidate, in two calls. The Hub sets the EXACT course list, so this tool reads the courses the candidate already has and sends existing + course_ids - remove_course_ids: nothing is removed unless you name it. CALL 1 shows which courses are added, kept and removed (names resolved from the catalogue), the credits balance, and who will be emailed; it sends nothing. CALL 2 with confirm=true assigns (credits may be used when the account pays), then optionally sends a reminder email (send_email). On live the candidate is emailed about the added courses: a real person. Uses online-training.candidates.results, .courses.list, .credits.show, .candidates.courses and .candidates.emails.',
  properties: {
    candidate_ref: { type: 'string' },
    course_ids: { type: 'array', items: { type: 'integer' }, description: 'Course ids to add (online-training.courses.list; hb_training_progress with available_courses lists them).' },
    remove_course_ids: { type: 'array', items: { type: 'integer' }, description: 'Course ids to remove (history is kept, no credits refunded). Default none.' },
    training_charge: { type: 'string', enum: ['client', 'candidate'], description: 'Who pays. Omitted: current or account default.' },
    renewal_mode: { type: 'string', enum: ['auto', 'manual'] },
    send_reminders: { type: 'boolean' },
    send_activation_email: { type: 'boolean', description: 'false suppresses the activation email for a new login.' },
    send_email: { type: 'string', enum: ['training_reminder', 'course_completion_reminder'], description: 'Also send this reminder email afterwards.' },
  },
  required: ['candidate_ref', 'course_ids'],
  schema: assignArgs,
  availability: { allOf: ['online-training'] },
  ops: (a) => ['online-training.candidates.results', 'online-training.courses.list', 'online-training.candidates.courses', ...(a.send_email ? ['online-training.candidates.emails'] : [])],
  plan: async (c) => {
    const { run, args } = c;
    const r = ref(args.candidate_ref);
    if (!UUID.test(r)) return { lines: [], problems: ['candidate_ref must be a uuid.'] };
    const [summary, assigned, catalogue, credits] = await Promise.all([
      run.get('online-training.candidates.show', { path_params: { candidate_ref: r } }),
      run.get('online-training.candidates.results', { path_params: { candidate_ref: r }, query: { scope: 'assigned', per_page: 100 } }),
      run.get('online-training.courses.list', { query: { per_page: 100 } }),
      run.get('online-training.credits.show', {}),
    ]);
    const problems: string[] = [];
    if (!catalogue.ok) return { lines: [], problems: [`the course catalogue could not be read (${why(catalogue)}).`] };
    let current: number[] = [];
    if (assigned.ok) current = rows(assigned).map((x) => Number(x.course_id));
    else if (assigned.status !== 404) return { lines: [], problems: [`the candidate's current courses could not be read (${why(assigned)}), and the Hub would replace the whole list.`] };
    const names = new Map<number, string>(rows(catalogue).map((x) => [Number(x.id), String(x.name)]));
    const remove = args.remove_course_ids ?? [];
    const unknown = [...args.course_ids, ...remove].filter((id) => !names.has(id) && !current.includes(id));
    if (unknown.length) problems.push(`course id(s) ${unknown.join(', ')} are not in the catalogue.`);
    const adds = args.course_ids.filter((id) => !current.includes(id));
    const removes = remove.filter((id) => current.includes(id));
    const finalList = [...new Set([...current, ...args.course_ids])].filter((id) => !remove.includes(id));
    const label = (id: number) => `${id} ${names.get(id) ?? ''}`.trim();
    const lines = [`Candidate ${r}${summary.ok ? ` (${summary.data?.first_name ?? ''} ${summary.data?.last_name ?? ''})` : ' (no online training record yet: one will be created)'}.`];
    lines.push(adds.length ? `Add: ${adds.map(label).join('; ')}.` : 'Add: nothing new.');
    lines.push(removes.length ? `Remove: ${removes.map(label).join('; ')} (results and history are kept; no credits are refunded).` : 'Remove: nothing.');
    const kept = current.filter((id) => !removes.includes(id));
    lines.push(`Kept as they are: ${kept.length ? kept.map(label).join('; ') : 'none'}.`);
    if (!adds.length && !removes.length) problems.push('the candidate already has exactly these courses.');
    if (credits.ok) lines.push(`Credits: balance ${credits.data?.balance ?? '?'}; adding courses may take credits when the account pays (training_charge ${args.training_charge ?? 'current setting'}).`);
    const emailLines = [emailNote(c.ctx, summary.ok ? `${summary.data?.email ?? 'the candidate'}` : 'the candidate').replace('An email', 'The candidate is emailed about the added courses, and an email')];
    if (args.send_activation_email === false) emailLines.push('The activation email for a new login is suppressed.');
    if (args.send_email) emailLines.push(`Then a ${args.send_email} reminder email is sent as well.`);
    lines.push(...emailLines);
    return { lines, problems, data: { candidate_ref: r, add: adds, remove: removes, final_course_ids: finalList } };
  },
  execute: async (c, plan) => {
    const { args } = c;
    const r = ref(args.candidate_ref);
    const finalList = (plan.data?.final_course_ids as number[]) ?? [];
    const body: Json = { course_ids: finalList, ...(args.training_charge ? { training_charge: args.training_charge } : {}), ...(args.renewal_mode ? { renewal_mode: args.renewal_mode } : {}), ...(args.send_reminders !== undefined ? { send_reminders: args.send_reminders } : {}), ...(args.send_activation_email !== undefined ? { send_activation_email: args.send_activation_email } : {}) };
    const put = await send(c as WriteCtx<unknown>, 'online-training.candidates.courses', { path_params: { candidate_ref: r }, body }, 'assign');
    if (!put.ok) return failed(c, 'The courses were not assigned', put);
    const lines = [`Assigned: added ${JSON.stringify(put.data?.added_course_ids ?? [])}, removed ${JSON.stringify(put.data?.removed_course_ids ?? [])}, credits charged ${put.data?.credits_charged ?? 0}.`];
    if (args.send_email) {
      const em = await send(c as WriteCtx<unknown>, 'online-training.candidates.emails', { path_params: { candidate_ref: r }, body: { email_type: args.send_email } }, 'email');
      lines.push(em.ok ? `Reminder email sent (${args.send_email}).` : `The courses were assigned but the reminder email failed: ${why(em)}.`);
    }
    return done(c, lines, { added_course_ids: put.data?.added_course_ids, removed_course_ids: put.data?.removed_course_ids, credits_charged: put.data?.credits_charged });
  },
});

// ---------------------------------------------------------------------------------- hb_request_references

const refereeSchema = z.object({
  name: z.string().max(150),
  email: z.string().email().max(255),
  organisation: z.string().max(150),
  position: z.string().max(150),
  phone: z.string().max(30).optional(),
  relationship_to_candidate: z.string().max(150).optional(),
});

const refArgs = z.object({
  candidate_ref: z.string().optional(),
  request_uuid: z.string().optional(),
  collection_mode: z.enum(['client_adds', 'candidate_provides']).optional(),
  template_id: z.number().int().optional(),
  references_required: z.number().int().min(1).optional(),
  expiry_days: z.number().int().min(1).max(365).optional(),
  notes: z.string().max(1000).optional(),
  referees: z.array(refereeSchema).optional(),
  ...writeBase,
});

const refereeBody = (r: z.infer<typeof refereeSchema>): Json => ({ referee_name: r.name, referee_email: r.email, referee_organisation: r.organisation, referee_position: r.position, ...(r.phone ? { referee_phone: r.phone } : {}), ...(r.relationship_to_candidate ? { relationship_to_candidate: r.relationship_to_candidate } : {}) });

export const requestReferencesTool = writeTask({
  name: 'hb_request_references',
  title: 'Request references',
  description:
    'Ask for references for a candidate, in two calls. Create a request with collection_mode client_adds (you give the referees; each is emailed their private link at once) or candidate_provides (the candidate is emailed a page to enter referees), or add one referee to an existing request (request_uuid). CALL 1 lists the templates, shows any existing requests for the candidate and exactly who will be emailed (names and addresses); it sends nothing. CALL 2 with confirm=true sends. The emails go to real people on live. A duplicate request is not refused by the Hub, so the plan warns. Uses references.templates.list, .requests.list/.show/.create and .requests.referees.create.',
  properties: {
    candidate_ref: { type: 'string', description: 'Create: the candidate.' },
    request_uuid: { type: 'string', description: 'Add a referee to this existing request instead of creating one.' },
    collection_mode: { type: 'string', enum: ['client_adds', 'candidate_provides'] },
    template_id: { type: 'integer', description: 'Reference form (default: the account default).' },
    references_required: { type: 'integer' },
    expiry_days: { type: 'integer', description: '1 to 365 (account default if omitted).' },
    notes: { type: 'string' },
    referees: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, organisation: { type: 'string' }, position: { type: 'string' }, phone: { type: 'string' }, relationship_to_candidate: { type: 'string' } }, required: ['name', 'email', 'organisation', 'position'] }, description: 'client_adds: the referees (name, email, organisation, position required). With request_uuid: exactly one.' },
  },
  schema: refArgs,
  availability: { allOf: ['references'] },
  ops: (a) => (a.request_uuid ? ['references.requests.show', 'references.requests.referees.create'] : ['hub.candidates.show', 'references.templates.list', 'references.requests.create']),
  plan: async (c) => {
    const { run, args } = c;
    const problems: string[] = [];
    if (args.request_uuid) {
      const show = await run.get('references.requests.show', { path_params: { uuid: args.request_uuid } });
      if (!show.ok) return { lines: [], problems: [`the request could not be read (${why(show)}).`] };
      const q = show.data ?? {};
      if (args.referees?.length !== 1) problems.push('give exactly one referee to add.');
      if (['cancelled', 'expired', 'completed'].includes(String(q.status))) problems.push(`the request is ${q.status}; it takes no more referees.`);
      const x = args.referees?.[0];
      return { lines: [`Add a referee to the request for ${q.candidate_name ?? q.candidate_ref} (${q.status_label}, ${q.references_completed}/${q.references_required} references, ${(q.referees ?? []).length} referee(s) so far).`, ...(x ? [`${emailNote(c.ctx, `${x.name} <${x.email}> (${x.position}, ${x.organisation})`)} They get their private link to the form.`] : [])], problems, data: { mode: 'add_referee', request_uuid: args.request_uuid } };
    }
    const r = ref(args.candidate_ref);
    if (!UUID.test(r)) return { lines: [], problems: ['candidate_ref (uuid) is needed.'] };
    if (!args.collection_mode) problems.push('collection_mode is needed: client_adds (you give the referees) or candidate_provides.');
    const [cand, templates, existing] = await Promise.all([
      run.get('hub.candidates.show', { path_params: { candidate_ref: r } }),
      run.get('references.templates.list', { query: { per_page: 50 } }),
      run.get('references.requests.list', { query: { candidate_ref: r, per_page: 5, sort: '-created_at' } }),
    ]);
    if (!cand.ok) return { lines: [], problems: [`the candidate could not be read (${why(cand)}).`] };
    const cd = cand.data ?? {};
    const lines = [`References for ${cd.name ?? r}.`];
    const tpls = rows(templates);
    const tpl = tpls.find((t) => Number(t.id) === args.template_id) ?? tpls.find((t) => t.is_default);
    if (templates.ok) lines.push(`Form: ${tpl ? `${tpl.name} (id ${tpl.id})` : 'account default'}${args.template_id && !tpls.some((t) => Number(t.id) === args.template_id) ? ' - WARNING: that template id is not in the list' : ''}.`);
    if (args.template_id && templates.ok && !tpls.some((t) => Number(t.id) === args.template_id)) problems.push(`template ${args.template_id} is not available.`);
    const open = existing.ok ? rows(existing).filter((x) => ['pending', 'in_progress'].includes(String(x.status))) : [];
    if (open.length) lines.push(`WARNING: ${open.length} request(s) for this candidate are already open (${open.map((x) => `${x.uuid} ${x.status_label}`).join('; ')}). The Hub does not refuse a duplicate.`);
    if (args.collection_mode === 'client_adds') {
      const refs = args.referees ?? [];
      if (refs.length === 0) problems.push('client_adds needs at least one referee.');
      const emails = refs.map((x) => x.email.toLowerCase());
      if (new Set(emails).size !== emails.length) problems.push('two referees have the same email address.');
      for (const x of refs) lines.push(emailNote(c.ctx, `${x.name} <${x.email}> (${x.position}, ${x.organisation})`) + ' They get their private link to the form at once.');
    } else if (args.collection_mode === 'candidate_provides') {
      if ((args.referees ?? []).length) problems.push('candidate_provides takes no referees: the candidate enters them.');
      lines.push(cd.email ? `${emailNote(c.ctx, `the candidate ${cd.name ?? ''} <${cd.email}>`)} They get a page to enter their referees; each referee is then emailed automatically.` : 'The candidate has no email address, so nobody is emailed; you must give them the submission link yourself.');
    }
    lines.push(`References required: ${args.references_required ?? 'account minimum'}; expires in ${args.expiry_days ?? 'the account default'} day(s).`);
    return { lines, problems, data: { mode: 'create', candidate_ref: r, existing_open: open.map((x) => x.uuid) } };
  },
  execute: async (c) => {
    const { args } = c;
    if (args.request_uuid) {
      const x = (args.referees as z.infer<typeof refereeSchema>[])[0] as z.infer<typeof refereeSchema>;
      const r = await send(c as WriteCtx<unknown>, 'references.requests.referees.create', { path_params: { uuid: args.request_uuid }, body: refereeBody(x) }, 'referee');
      if (!r.ok) return failed(c, 'The referee was not added', r);
      return done(c, [`Referee added: ${r.data?.name ?? x.name} (${r.data?.status_label ?? '-'}).`], { referee: { uuid: r.data?.uuid, status: r.data?.status } });
    }
    const body: Json = { candidate_ref: ref(args.candidate_ref), collection_mode: args.collection_mode, ...(args.template_id ? { template_id: args.template_id } : {}), ...(args.references_required ? { references_required: args.references_required } : {}), ...(args.expiry_days ? { expiry_days: args.expiry_days } : {}), ...(args.notes ? { notes: args.notes } : {}), ...(args.collection_mode === 'client_adds' ? { referees: (args.referees ?? []).map(refereeBody) } : {}) };
    const r = await send(c as WriteCtx<unknown>, 'references.requests.create', { body }, 'request');
    if (!r.ok) return failed(c, 'The request was not created', r);
    const q = r.data ?? {};
    const noEmail = args.collection_mode === 'candidate_provides' && !q.candidate_email;
    return done(c, [`Reference request ${q.uuid}: ${q.status_label ?? q.status}, ${q.references_required} required, expires ${day(q.expires_at)}.`, ...(noEmail ? [`The candidate has no email: give them this link yourself: ${q.submission_url}`] : [])], { request: { uuid: q.uuid, status: q.status, references_required: q.references_required, expires_at: q.expires_at, referees: (q.referees ?? []).length } });
  },
});

// ------------------------------------------------------------------------ hb_request_occupational_health

const ohArgs = z.object({
  candidate_ref: z.string(),
  request_type: z.enum(['new_starter', 'renewal']).optional(),
  clearance_type_id: z.number().int().optional(),
  scope: z.enum(['full', 'temporary']).optional(),
  hq_method: z.enum(['online', 'paper']).optional(),
  imms_method: z.enum(['agency', 'candidate']).optional(),
  notify_candidate: z.boolean().optional(),
  ...writeBase,
});

export const requestOccupationalHealthTool = writeTask({
  name: 'hb_request_occupational_health',
  title: 'Request occupational health clearance',
  description:
    'Create an occupational health request for a candidate, in two calls. CALL 1 reads the request options and clearance types (and the credits), validates your choices against them and returns the plan; nothing is sent. CALL 2 with confirm=true creates the request (uses credits; idempotency key). No health answers are handled: with the online questionnaire the candidate completes it themselves and is emailed (a real person on live; notify_candidate=false skips that email). Paper questionnaires and file uploads are not supported by this tool. Uses occupational-health.request-options.show, .clearance-types.list, .credits.show, .requests.create and hub.candidates.show.',
  properties: {
    candidate_ref: { type: 'string' },
    request_type: { type: 'string', enum: ['new_starter', 'renewal'] },
    clearance_type_id: { type: 'integer', description: 'From the clearance types listed by call 1.' },
    scope: { type: 'string', enum: ['full', 'temporary'], description: 'Only for new starters whose clearance type needs immunisations.' },
    hq_method: { type: 'string', enum: ['online', 'paper'], description: 'Default online (paper needs uploads: unsupported here).' },
    imms_method: { type: 'string', enum: ['agency', 'candidate'] },
    notify_candidate: { type: 'boolean', description: 'false: do not email the candidate the questionnaire link.' },
  },
  required: ['candidate_ref'],
  schema: ohArgs,
  availability: { allOf: ['hub', 'occupational-health'] },
  ops: () => ['hub.candidates.show', 'occupational-health.request-options.show', 'occupational-health.clearance-types.list', 'occupational-health.requests.create'],
  plan: async (c) => {
    const { run, args } = c;
    const r = ref(args.candidate_ref);
    if (!UUID.test(r)) return { lines: [], problems: ['candidate_ref must be a uuid.'] };
    const [cand, options, types, credits] = await Promise.all([
      run.get('hub.candidates.show', { path_params: { candidate_ref: r } }),
      run.get('occupational-health.request-options.show', {}),
      run.get('occupational-health.clearance-types.list', { query: { per_page: 100 } }),
      run.get('occupational-health.credits.show', {}),
    ]);
    if (!cand.ok) return { lines: [], problems: [`the candidate could not be read (${why(cand)}).`] };
    if (!options.ok || !types.ok) return { lines: [], problems: [`the request options could not be read (${why(options.ok ? types : options)}).`] };
    const o = options.data ?? {};
    const problems: string[] = [];
    const lines = [`Occupational health request for ${cand.data?.name ?? r}.`];
    const values = (k: string): string[] => (Array.isArray(o[k]) ? o[k].map((x: Json) => String(x.value)) : []);
    if (!args.request_type) problems.push(`request_type is needed (${values('request_types').join(' or ')}).`);
    else if (!values('request_types').includes(args.request_type)) problems.push(`request_type ${args.request_type} is not offered.`);
    const method = args.hq_method ?? 'online';
    if (method === 'paper') problems.push('paper questionnaires need file uploads, which this tool does not send. Use the online questionnaire.');
    else if (values('hq_methods').length && !values('hq_methods').includes(method)) problems.push(`hq_method ${method} is not offered.`);
    const list = rows(types);
    const chosen = list.find((t) => Number(t.id) === args.clearance_type_id);
    if (args.clearance_type_id === undefined) {
      lines.push('Clearance types:');
      for (const t of list) lines.push(`  - ${t.id} ${t.name}${t.needs_immunisations ? ' (needs immunisations)' : ''}${t.has_scope_choice ? ' (full or temporary)' : ''}`);
      problems.push('clearance_type_id is needed.');
    } else if (!chosen) problems.push(`clearance type ${args.clearance_type_id} does not exist.`);
    else {
      lines.push(`Clearance: ${chosen.name}.`);
      if (chosen.needs_immunisations && args.request_type === 'new_starter' && (!args.scope || !args.imms_method)) problems.push('this clearance type needs scope (full or temporary) and imms_method (agency or candidate) for a new starter.');
      if (chosen.needs_immunisations && args.imms_method === 'agency') lines.push('Immunisation evidence uploaded by the agency is not supported by this tool; the candidate-upload method is the one that works without files.');
    }
    if (credits.ok) lines.push(`Credits: balance ${credits.data?.balance ?? '?'}; ${credits.data?.credits_per_new_starter ?? '?'} per new starter; ${money(credits.data?.price_per_credit_pence, credits.data?.currency)} per credit. The request uses credits.`);
    lines.push(args.notify_candidate === false ? 'The candidate is not emailed (notify_candidate false): someone must answer for them or tell them.' : emailNote(c.ctx, `${cand.data?.email ?? 'the candidate'}`).replace('An email', 'An email with the health questionnaire link'));
    lines.push('No health answers are handled by this tool: the candidate completes the questionnaire themselves. Health data is special category data.');
    return { lines, problems, data: { candidate_ref: r, request_types: o.request_types, clearance_types: list.map((t) => ({ id: t.id, name: t.name })) } };
  },
  execute: async (c) => {
    const { args } = c;
    const body: Json = { candidate_ref: ref(args.candidate_ref), request_type: args.request_type, clearance_type_id: args.clearance_type_id, hq_method: args.hq_method ?? 'online', ...(args.scope ? { scope: args.scope } : {}), ...(args.imms_method ? { imms_method: args.imms_method } : {}), ...(args.notify_candidate !== undefined ? { notify_candidate: args.notify_candidate } : {}) };
    const r = await send(c as WriteCtx<unknown>, 'occupational-health.requests.create', { body }, 'request');
    if (!r.ok) return failed(c, 'The request was not created', r);
    const q = r.data ?? {};
    return done(c, [`Occupational health request ${q.reference ?? q.id}: ${q.status_label ?? q.status}${q.duplicate ? ' (the Hub marks it as a duplicate)' : ''}, submitted ${when(q.submitted_at)}.`], { request: { id: q.id, reference: q.reference, status: q.status, duplicate: q.duplicate } });
  },
});

// -------------------------------------------------------------------------------- hb_chase_outstanding

const KINDS = ['references_reminders', 'references_referee_reminder', 'references_extend', 'references_cancel', 'occupational_health_reminder', 'training_email'] as const;
const chaseArgs = z.object({
  kind: z.enum(KINDS),
  request_uuid: z.string().optional(),
  referee_uuid: z.string().optional(),
  candidate_ref: z.string().optional(),
  days: z.number().int().min(1).max(365).optional(),
  email_type: z.enum(['training_reminder', 'course_completion_reminder']).optional(),
  ...writeBase,
});

export const chaseOutstandingTool = writeTask({
  name: 'hb_chase_outstanding',
  title: 'Chase outstanding items',
  description:
    'Send reminders for outstanding items, in two calls. `kind`: references_reminders (remind every referee of a request who is due), references_referee_reminder (one referee), references_extend (give a request more days), references_cancel (cancel a request: final), occupational_health_reminder (remind a candidate to complete the health questionnaire), training_email (remind a candidate about online training). CALL 1 lists exactly who will be contacted (names and addresses) and sends nothing; CALL 2 with confirm=true sends. Reminders are real emails to real people on live; repeat calls send repeat emails, so do not loop. Uses references.requests.show/.reminders/.extend/.cancel, references.referees.reminder, occupational-health.candidates.show/.reminder and online-training.candidates.show/.emails.',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    request_uuid: { type: 'string', description: 'References kinds: the request.' },
    referee_uuid: { type: 'string', description: 'references_referee_reminder: the referee.' },
    candidate_ref: { type: 'string', description: 'occupational_health_reminder and training_email.' },
    days: { type: 'integer', description: 'references_extend: days to add.' },
    email_type: { type: 'string', enum: ['training_reminder', 'course_completion_reminder'], description: 'training_email: which reminder.' },
  },
  required: ['kind'],
  schema: chaseArgs,
  availability: { anyOf: ['references', 'occupational-health', 'online-training'] },
  destructive: true,
  idempotent: false,
  ops: (a) => {
    switch (a.kind) {
      case 'references_reminders': return ['references.requests.show', 'references.requests.reminders'];
      case 'references_referee_reminder': return ['references.requests.show', 'references.referees.reminder'];
      case 'references_extend': return ['references.requests.show', 'references.requests.extend'];
      case 'references_cancel': return ['references.requests.show', 'references.requests.cancel'];
      case 'occupational_health_reminder': return ['occupational-health.candidates.show', 'occupational-health.candidates.reminder'];
      default: return ['online-training.candidates.show', 'online-training.candidates.emails'];
    }
  },
  plan: async (c) => {
    const { run, args } = c;
    const problems: string[] = [];
    if (args.kind.startsWith('references')) {
      if (!args.request_uuid) return { lines: [], problems: ['request_uuid is needed.'] };
      const show = await run.get('references.requests.show', { path_params: { uuid: args.request_uuid } });
      if (!show.ok) return { lines: [], problems: [`the request could not be read (${why(show)}).`] };
      const q = show.data ?? {};
      const referees: Json[] = Array.isArray(q.referees) ? q.referees : [];
      const waiting = referees.filter((x) => ['pending', 'sent', 'opened', 'in_progress'].includes(String(x.status)));
      const lines = [`Request for ${q.candidate_name ?? q.candidate_ref}: ${q.status_label}, ${q.references_completed}/${q.references_required} references, expires ${day(q.expires_at)}.`];
      if (['cancelled', 'expired', 'completed'].includes(String(q.status))) problems.push(`the request is ${q.status}.`);
      if (args.kind === 'references_reminders') {
        lines.push(waiting.length ? `Referees still outstanding (reminded if due; Hub skips those not yet due):` : 'No referee is outstanding.');
        for (const x of waiting) lines.push(`  - ${x.name} <${x.email}> (${x.status_label}, ${x.reminder_count ?? 0} reminder(s) so far)`);
        if (waiting.length) lines.push(emailNote(c.ctx, `${waiting.length} referee(s)`));
        else problems.push('nobody to remind.');
      } else if (args.kind === 'references_referee_reminder') {
        const x = referees.find((r) => r.uuid === args.referee_uuid);
        if (!args.referee_uuid || !x) problems.push('referee_uuid must be a referee of this request.');
        else {
          lines.push(`Remind ${x.name} <${x.email}> (${x.status_label}, ${x.reminder_count ?? 0} reminder(s) so far). ${emailNote(c.ctx, x.email)}`);
          if (!waiting.includes(x)) problems.push(`the referee is ${x.status}; no reminder is due.`);
        }
      } else if (args.kind === 'references_extend') {
        if (!args.days) problems.push('days is needed.');
        else lines.push(`Extend the expiry (${day(q.expires_at)}) by ${args.days} day(s). Nobody is emailed by this call.`);
      } else {
        lines.push(`CANCEL the request: it becomes cancelled for good (create a new one to start again). ${waiting.length} outstanding referee(s) become expired and can no longer answer: ${waiting.map((x) => x.name).join(', ') || 'none'}. Referees are not emailed about the cancellation.`);
      }
      return { lines, problems, data: { request_uuid: args.request_uuid, outstanding: waiting.map((x) => ({ uuid: x.uuid, name: x.name, status: x.status })) } };
    }
    const r = ref(args.candidate_ref);
    if (!UUID.test(r)) return { lines: [], problems: ['candidate_ref (uuid) is needed.'] };
    if (args.kind === 'occupational_health_reminder') {
      const show = await run.get('occupational-health.candidates.show', { path_params: { candidate_ref: r } });
      if (!show.ok) return { lines: [], problems: [`the candidate could not be read (${why(show)}).`] };
      const d = show.data ?? {};
      if (d.has_forms === false) problems.push('the candidate has no health forms to complete.');
      return { lines: [`Remind ${d.name ?? r} to complete the health questionnaire (forms: ${d.forms ?? '?'}, status ${d.status ?? '-'}). ${emailNote(c.ctx, `${d.email ?? 'the candidate'}`)} Every call sends one email.`], problems, data: { candidate_ref: r } };
    }
    if (!args.email_type) problems.push('email_type is needed (training_reminder or course_completion_reminder).');
    const show = await run.get('online-training.candidates.show', { path_params: { candidate_ref: r } });
    if (!show.ok) return { lines: [], problems: [`the candidate could not be read (${why(show)}).`] };
    const d = show.data ?? {};
    return { lines: [`Send a ${args.email_type ?? 'training'} email to ${d.first_name ?? ''} ${d.last_name ?? ''}: ${d.courses_completed ?? '?'}/${d.courses_assigned ?? '?'} courses completed, status ${d.training_status ?? '-'}. ${emailNote(c.ctx, `${d.email ?? 'the candidate'}`)}`], problems, data: { candidate_ref: r } };
  },
  execute: async (c) => {
    const { args } = c;
    const uuid = args.request_uuid as string;
    switch (args.kind) {
      case 'references_reminders': {
        const r = await send(c as WriteCtx<unknown>, 'references.requests.reminders', { path_params: { uuid } }, 'remind');
        if (!r.ok) return failed(c, 'The reminders were not sent', r);
        return done(c, [`Reminders sent: ${r.data?.reminders_sent ?? 0}.${(r.data?.skipped ?? []).length ? ` Skipped: ${(r.data.skipped as Json[]).map((s) => `${s.referee} (${s.reason})`).join('; ')}.` : ''}`], { reminders_sent: r.data?.reminders_sent, skipped: r.data?.skipped });
      }
      case 'references_referee_reminder': {
        const r = await send(c as WriteCtx<unknown>, 'references.referees.reminder', { path_params: { uuid: args.referee_uuid } }, 'remind');
        if (!r.ok) return failed(c, 'The reminder was not sent', r);
        return done(c, [`Reminder sent (reminder ${r.data?.reminder_count ?? '?'}).`], { sent: r.data?.sent });
      }
      case 'references_extend': {
        const r = await send(c as WriteCtx<unknown>, 'references.requests.extend', { path_params: { uuid }, body: { days: args.days } }, 'extend');
        if (!r.ok) return failed(c, 'The request was not extended', r);
        return done(c, [`Request extended by ${args.days} day(s).`], { extended_days: args.days });
      }
      case 'references_cancel': {
        const r = await send(c as WriteCtx<unknown>, 'references.requests.cancel', { path_params: { uuid } }, 'cancel');
        if (!r.ok) return failed(c, 'The request was not cancelled', r);
        return done(c, ['Request cancelled.'], { cancelled: true });
      }
      case 'occupational_health_reminder': {
        const r = await send(c as WriteCtx<unknown>, 'occupational-health.candidates.reminder', { path_params: { candidate_ref: ref(args.candidate_ref) } }, 'remind');
        if (!r.ok) return failed(c, 'The reminder was not sent', r);
        return done(c, ['Health questionnaire reminder queued for the candidate.'], { sent: r.data?.sent });
      }
      default: {
        const r = await send(c as WriteCtx<unknown>, 'online-training.candidates.emails', { path_params: { candidate_ref: ref(args.candidate_ref) }, body: { email_type: args.email_type } }, 'email');
        if (!r.ok) return failed(c, 'The email was not sent', r);
        return done(c, [`${r.data?.message ?? 'Reminder sent.'}${r.data?.incomplete_courses != null ? ` Incomplete courses listed: ${r.data.incomplete_courses}.` : ''}`], { email_type: r.data?.email_type });
      }
    }
  },
});
