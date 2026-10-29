import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject } from '../generator/build.js';
import type { AppContext } from '../context.js';
import { SafetyRefusal } from '../errors.js';
import {
  assertWritable,
  environmentLine,
  missingScopes,
  refusal,
  taskResult,
  TaskRun,
  type CallOutcome,
  type Json,
  type TaskAvailability,
  type TaskTool,
} from './task-support.js';
import type { ToolResult } from './types.js';

/** Fields every write task tool accepts. */
export const writeBase = {
  confirm: z.boolean().optional(),
  idempotency_key: z.string().max(200).optional(),
};

const writeBaseProperties: JsonObject = {
  confirm: { type: 'boolean', description: 'true only after the user approved the plan returned by the first call. Without it nothing is changed.' },
  idempotency_key: { type: 'string', description: 'Reuse the key returned by an earlier call to repeat a write safely.' },
};

export interface WriteCtx<A> {
  ctx: AppContext;
  run: TaskRun;
  args: A;
  /** Base idempotency key; per-operation keys are derived with `keyFor`. */
  key: string;
  live: boolean;
}

export interface PlanResult {
  lines: string[];
  data?: Record<string, unknown>;
  /** Things that stop the write; the plan is still shown. */
  problems?: string[];
  /** The action only reads (for example listing): return the lines as the answer, no confirm needed. */
  readOnlyAction?: boolean;
}

export interface WriteSpec<A extends { confirm?: boolean; idempotency_key?: string }> {
  name: string;
  title: string;
  description: string;
  properties: JsonObject;
  required?: string[];
  schema: z.ZodType<A>;
  availability: TaskAvailability;
  /** Hub operations a confirmed call may send (checked against read-only, live-write and scope rules before anything is sent). */
  ops: (args: A) => string[];
  /** Reads only. Builds the plan or the options. */
  plan: (c: WriteCtx<A>) => Promise<PlanResult>;
  /** Runs after `confirm: true`, only when the plan has no problems. */
  execute: (c: WriteCtx<A>, plan: PlanResult) => Promise<ToolResult>;
  destructive?: boolean;
  idempotent?: boolean;
}

export const keyFor = (c: { key: string }, tag: string): string => `${c.key}-${tag}`;

/** Send one write operation of a confirmed task. The tool-level confirm is the user's approval for the live gate. */
export function send(c: WriteCtx<unknown>, op: string, args: Record<string, unknown>, tag = op.split('.').pop() ?? 'w'): Promise<CallOutcome> {
  return c.run.call(op, { ...args, confirm: true, idempotency_key: keyFor(c, tag) }, { noPrecheck: true });
}

export function done(c: WriteCtx<unknown>, lines: string[], data: Record<string, unknown>): ToolResult {
  return taskResult(c.ctx, c.run, { lines: [environmentLine(c.ctx), ...lines, `Idempotency key: ${c.key}.`, `Operations called: ${c.run.operationsCalled().join(', ')}.`], data: { executed: true, idempotency_key: c.key, ...data } });
}

export function failed(c: WriteCtx<unknown>, what: string, r: CallOutcome, extra?: string): ToolResult {
  const unknown = (r.status === undefined && /No answer from the Hub/.test(r.error ?? '')) || (r.status ?? 0) >= 500;
  const lines = [
    `${what}.`,
    ...(r.error && !r.skipped ? [r.error] : []),
    ...(extra ? [extra] : []),
    ...(unknown ? ['The outcome is unknown: do not repeat blindly. Check the record, or repeat with the same idempotency_key.'] : []),
    `idempotency_key: ${c.key}`,
    `Operations called: ${c.run.operationsCalled().join(', ')}.`,
  ];
  return taskResult(c.ctx, c.run, { lines, data: { executed: false, problem: r.error?.split('\n')[0] ?? r.skipped, idempotency_key: c.key } }, true);
}

/** Build a write task tool: validate, gate, scope check, plan (reads only), then act only on confirm. */
export function writeTask<A extends { confirm?: boolean; idempotency_key?: string }>(spec: WriteSpec<A>) {
  return (ctx: AppContext): TaskTool => ({
    availability: { ...spec.availability, writes: true },
    definition: {
      name: spec.name,
      description: spec.description,
      inputSchema: { type: 'object', properties: { ...spec.properties, ...writeBaseProperties }, ...(spec.required?.length ? { required: spec.required } : {}), additionalProperties: false },
      annotations: { title: spec.title, readOnlyHint: false, destructiveHint: spec.destructive === true, idempotentHint: spec.idempotent ?? !spec.destructive, openWorldHint: true },
      handler: async (raw) => {
        const parsed = spec.schema.safeParse(raw);
        if (!parsed.success) return refusal(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const args = parsed.data;
        const run = new TaskRun(ctx);
        const needed = spec.ops(args);
        try {
          assertWritable(ctx, needed);
        } catch (e) {
          if (e instanceof SafetyRefusal) return refusal(`${e.message} Nothing was sent.`);
          throw e;
        }
        await run.loadKey();
        const lacking = missingScopes(ctx, needed, run);
        if (lacking.length) return refusal(`The key lacks the scope(s) ${lacking.join(', ')}, so this cannot be done. Ask the user to add them to the key on the Hub Developer page. Nothing was sent.`);
        const key = args.idempotency_key ?? randomUUID();
        const c: WriteCtx<A> = { ctx, run, args, key, live: ctx.config.mode === 'live' };
        const plan = await spec.plan(c);

        if (plan.readOnlyAction) {
          return taskResult(ctx, run, { lines: [environmentLine(ctx), ...plan.lines, `Operations called: ${run.operationsCalled().join(', ')}.`], data: { executed: false, stage: 'read', ...plan.data } });
        }
        const problems = plan.problems ?? [];
        if (args.confirm !== true) {
          const lines = [
            environmentLine(ctx),
            ...plan.lines,
            ...(problems.length ? [`Cannot proceed yet: ${problems.join(' ')}`] : []),
            `Nothing was sent. To proceed, call again with the same arguments plus confirm=true and idempotency_key "${key}", after the user agrees.`,
            `Operations called: ${run.operationsCalled().join(', ')}.`,
          ];
          return taskResult(ctx, run, { lines, data: { executed: false, stage: 'plan', problems, idempotency_key: key, ...plan.data } });
        }
        if (problems.length) return refusal(`Cannot proceed: ${problems.join(' ')} Nothing was changed.`);
        return spec.execute(c, plan);
      },
    },
  });
}

/** Common optional pay option check for plans. */
export function payExplained(opt: string | undefined): string {
  switch (opt) {
    case 'credits': return 'takes one credit now';
    case 'balance': return 'takes the price from the booking balance now';
    case 'invoice':
    case 'inv': return 'adds it to the invoice (nothing is taken now)';
    case 'candidate_pays': return 'leaves it pending and emails the candidate a payment link';
    default: return 'pay option not chosen yet';
  }
}

export type { Json };
