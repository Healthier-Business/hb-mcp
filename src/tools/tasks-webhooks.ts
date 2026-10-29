import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { redactor } from './../redact.js';
import { safeUrl, rows, saveSecretFile, when, why, type Json } from './task-support.js';
import { done, failed, send, writeBase, writeTask, type WriteCtx } from './task-kit.js';

// ----------------------------------------------------------------------------- hb_redeliver_webhooks

const redeliverArgs = z.object({
  endpoint_id: z.number().int(),
  delivery_ids: z.array(z.number().int()).max(50).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  ...writeBase,
});

export const redeliverWebhooksTool = writeTask({
  name: 'hb_redeliver_webhooks',
  title: 'Redeliver failed webhooks',
  description:
    'Send failed webhook deliveries again to the same endpoint, in two calls. CALL 1 shows the endpoint (active or switched off) and exactly which deliveries will be redelivered (the failed ones, newest first, or the delivery_ids you give) and sends nothing. CALL 2 with confirm=true redelivers them one by one. The same event_id is kept, so a receiver that ignores event ids it has handled stays correct. Each call queues a new series of up to 5 attempts and the Hub has no idempotency key here, so do not repeat it blindly. An endpoint that is switched off must be switched on first (the plan says so). Uses webhooks.endpoints.show, .deliveries.list and .deliveries.redeliver.',
  properties: {
    endpoint_id: { type: 'integer', description: 'The webhook endpoint id.' },
    delivery_ids: { type: 'array', items: { type: 'integer' }, description: 'Redeliver exactly these deliveries (default: the failed ones).' },
    limit: { type: 'integer', description: 'How many failed deliveries to redeliver (default 10, max 20).' },
  },
  required: ['endpoint_id'],
  schema: redeliverArgs,
  availability: { allOf: ['account'] },
  idempotent: false,
  ops: () => ['webhooks.endpoints.show', 'webhooks.deliveries.list', 'webhooks.deliveries.redeliver'],
  plan: async (c) => {
    const { run, args } = c;
    const show = await run.get('webhooks.endpoints.show', { path_params: { webhook: args.endpoint_id } });
    if (!show.ok) return { lines: [], problems: [`the endpoint could not be read (${why(show)}).`] };
    const e = show.body ?? {};
    const problems: string[] = [];
    const lines = [`Endpoint #${e.id} ${e.name}: ${e.is_active ? 'active' : 'SWITCHED OFF'}, ${safeUrl(e.url)}, ${e.consecutive_failures ?? 0} failed in a row, last response ${e.last_response_code ?? '-'}.`];
    if (e.is_active === false) problems.push('the endpoint is switched off, so a redelivery would fail at once. Fix the receiver and switch it on first (webhooks.endpoints.update with is_active true).');
    const limit = args.limit ?? 10;
    const list = await run.get('webhooks.deliveries.list', { path_params: { webhook: args.endpoint_id }, query: { per_page: args.delivery_ids?.length ? 100 : limit, ...(args.delivery_ids?.length ? {} : { status: 'failed' }), sort: '-id' } });
    if (!list.ok) return { lines, problems: [...problems, `the deliveries could not be read (${why(list)}).`] };
    let chosen = rows(list);
    if (args.delivery_ids?.length) {
      const missing = args.delivery_ids.filter((id) => !chosen.some((d) => Number(d.id) === id));
      if (missing.length) problems.push(`delivery id(s) ${missing.join(', ')} were not found among the latest 100 deliveries of this endpoint.`);
      chosen = chosen.filter((d) => args.delivery_ids!.includes(Number(d.id)));
    } else chosen = chosen.filter((d) => d.status === 'failed').slice(0, limit);
    if (!chosen.length) problems.push('there is nothing to redeliver.');
    lines.push(`${chosen.length} delivery(ies) will be sent again (a new series of up to 5 attempts each, same event ids):`);
    for (const d of chosen) lines.push(`  - #${d.id} ${d.event_type}: ${d.status}, attempt ${d.attempt ?? '-'}, ${d.response_code ?? 'no response'}, ${when(d.created_at)}`);
    if (chosen.some((d) => d.status === 'delivered')) lines.push('Some of these were already delivered: the receiver will get the event a second time.');
    return { lines, problems, data: { endpoint_id: e.id, deliveries: chosen.map((d) => ({ id: d.id, event_type: d.event_type, status: d.status })) } };
  },
  execute: async (c, plan) => {
    const { args } = c;
    const ids = ((plan.data?.deliveries as Json[]) ?? []).map((d) => Number(d.id));
    const queued: number[] = [];
    const failures: string[] = [];
    for (const id of ids) {
      const r = await send(c as WriteCtx<unknown>, 'webhooks.deliveries.redeliver', { path_params: { webhook: args.endpoint_id, delivery: id } }, `redeliver-${id}`);
      if (r.ok) queued.push(id);
      else {
        failures.push(`#${id}: ${why(r)}`);
        if (r.status === undefined || (r.status ?? 0) >= 500) break;
      }
    }
    if (!queued.length) return failed(c, 'Nothing was redelivered', { op: 'webhooks.deliveries.redeliver', ok: false, error: failures.join('\n') });
    return done(c, [`Queued ${queued.length} redelivery(ies): ${queued.map((i) => `#${i}`).join(', ')}.`, ...(failures.length ? [`Not queued: ${failures.join('; ')}.`] : []), 'Check the outcome with hb_webhook_health in a moment.'], { queued, failures });
  },
});

// -------------------------------------------------------------------------- hb_rotate_webhook_secret

const rotateArgs = z.object({ endpoint_id: z.number().int(), save_secret_to: z.string().optional(), ...writeBase });

export const rotateWebhookSecretTool = writeTask({
  name: 'hb_rotate_webhook_secret',
  title: 'Rotate a webhook signing secret',
  description:
    'Create a new signing secret for a webhook endpoint, in two calls. CALL 1 shows the endpoint and warns what rotation does: the old secret stops working at once, every delivery from then on (including queued retries for up to about 80 minutes) is signed with the new one, and a receiver that still holds the old secret will reject them until it is updated. Nothing is changed. CALL 2 with confirm=true rotates it, on sandbox and live alike. The new secret is NEVER returned in the answer (withheld and scrubbed, as in hb_setup_sandbox_webhook): pass save_secret_to (an absolute path to a NEW file, owner-only, on the machine running this server) to keep it, then put its content in the receiver and in HB_WEBHOOK_SECRET. If you do not save it, you must rotate again to get one. Not idempotent: do not repeat after a lost answer. Uses webhooks.endpoints.show and webhooks.endpoints.rotate-secret.',
  properties: {
    endpoint_id: { type: 'integer', description: 'The webhook endpoint id.' },
    save_secret_to: { type: 'string', description: 'Absolute path of a new file to write the new signing secret to (owner-only). Strongly recommended.' },
  },
  required: ['endpoint_id'],
  schema: rotateArgs,
  availability: { allOf: ['account'] },
  destructive: true,
  idempotent: false,
  ops: () => ['webhooks.endpoints.show', 'webhooks.endpoints.rotate-secret'],
  plan: async (c) => {
    const { run, args } = c;
    const show = await run.get('webhooks.endpoints.show', { path_params: { webhook: args.endpoint_id } });
    if (!show.ok) return { lines: [], problems: [`the endpoint could not be read (${why(show)}).`] };
    const e = show.body ?? {};
    const problems: string[] = [];
    const lines = [
      `Rotate the signing secret of endpoint #${e.id} ${e.name} (${e.is_active ? 'active' : 'switched off'}, ${safeUrl(e.url)}), current secret ${e.secret_prefix ?? '-'}.`,
      'WARNING: the old secret stops being valid at once. Every delivery from now on, including retries already queued (up to about 80 minutes), is signed with the NEW secret, so your receiver will reject deliveries until you give it the new secret. Update the receiver at the same moment.',
      c.live ? 'This is the LIVE Hub: real events to your production receiver will fail verification until it is updated.' : 'This is a sandbox endpoint.',
      'The new secret is never shown in the answer.',
    ];
    if (args.save_secret_to) {
      if (!isAbsolute(args.save_secret_to)) problems.push('save_secret_to must be an absolute path.');
      else if (!existsSync(dirname(args.save_secret_to))) problems.push('the folder for save_secret_to does not exist.');
      else if (existsSync(args.save_secret_to)) problems.push('save_secret_to already exists; the server never overwrites files.');
      else lines.push(`The new secret will be saved to ${args.save_secret_to} (owner-only).`);
    } else lines.push('WARNING: no save_secret_to, so the new secret would be lost and you would have to rotate again to get one. Pass save_secret_to (a new file path) unless you only want to invalidate the old secret.');
    return { lines, problems, data: { endpoint: { id: e.id, name: e.name, url: safeUrl(e.url) } } };
  },
  execute: async (c) => {
    const { args } = c;
    let secret: string | undefined;
    const r = await send(c as WriteCtx<unknown>, 'webhooks.endpoints.rotate-secret', {
      path_params: { webhook: args.endpoint_id },
      onResponse: (json: unknown) => {
        const s = (json as Json)?.signing_secret;
        if (typeof s === 'string') {
          secret = s;
          redactor.add(s);
        }
      },
    }, 'rotate');
    if (!r.ok) return failed(c, 'The secret was not rotated', r, 'Do not repeat blindly: read the endpoint secret_prefix to see whether it changed.');
    let saved = false;
    let line: string;
    if (secret && args.save_secret_to) {
      const problem = await saveSecretFile(args.save_secret_to, secret);
      saved = problem === undefined;
      line = saved ? `The new secret was saved to ${args.save_secret_to} (owner-only). It is not shown here. Update the receiver now.` : `The secret was rotated but could NOT be saved (${problem}); it is lost and withheld. Rotate again with a valid save_secret_to.`;
    } else line = 'The secret was rotated and is withheld from this answer. It was not saved: rotate again with save_secret_to to obtain one.';
    return done(c, [`Endpoint #${args.endpoint_id} rotated; new secret prefix ${r.body?.secret_prefix ?? '-'}.`, line], { endpoint_id: args.endpoint_id, secret_prefix: r.body?.secret_prefix, signing_secret: 'withheld', secret_saved_to_file: saved });
  },
});
