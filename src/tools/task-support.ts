import { isApprovalCode } from '../approval.js';
import type { CatalogueOperation } from '../catalogue.js';
import { writesEnabled } from '../config.js';
import { scopeAllowed, type AppContext } from '../context.js';
import type { CallArgs } from '../execute.js';
import { redactor } from '../redact.js';
import { gate, isWrite } from '../safety.js';
import { SafetyRefusal } from '../errors.js';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { textResult, type ToolDefinition, type ToolResult } from './types.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Json = any; // the Hub answers are walked defensively; every field is optional

/** Which toolsets and capabilities a task tool needs before it is offered. */
export interface TaskAvailability {
  /** Needs writes enabled (hidden while read-only, like write tools in full mode). */
  writes?: boolean;
  /** Every one of these toolsets must be enabled. */
  allOf?: string[];
  /** At least one of these toolsets must be enabled. */
  anyOf?: string[];
}

export interface TaskTool {
  definition: ToolDefinition;
  availability: TaskAvailability;
}

export function isTaskAvailable(ctx: AppContext, a: TaskAvailability): boolean {
  const on = ctx.config.toolsets;
  if (a.writes && !writesEnabled(ctx.config)) return false;
  if (a.allOf && !a.allOf.every((t) => on.includes(t))) return false;
  if (a.anyOf && !a.anyOf.some((t) => on.includes(t))) return false;
  return true;
}

export interface CallOutcome {
  op: string;
  ok: boolean;
  /** The `data` of the answer for `{data: ...}` answers, else the whole body. */
  data?: Json;
  body?: Json;
  meta?: Json;
  status?: number;
  code?: string;
  error?: string;
  /** Set when nothing was sent (scope, toolset or mode). */
  skipped?: string;
}

/** Runs Hub operations for one task tool call through the shared executor and keeps the list of operation ids used. */
export class TaskRun {
  readonly calledOps: string[] = [];
  readonly skippedOps: { op: string; reason: string }[] = [];

  constructor(readonly ctx: AppContext) {}

  get config() {
    return this.ctx.config;
  }

  op(id: string): CatalogueOperation {
    const op = this.ctx.catalogue.get(id);
    if (!op) throw new Error(`Task tool bug: unknown operation ${id}`);
    return op;
  }

  /** Why this operation cannot be called now, or undefined. Uses the key's scopes once they are known. */
  blocker(id: string): string | undefined {
    const op = this.op(id);
    if (!this.config.toolsets.includes(op.toolset)) return `the ${op.toolset} toolset is not enabled (HB_TOOLSETS)`;
    if (isWrite(op) && !writesEnabled(this.config)) return 'writes are not enabled (read-only)';
    if (scopeAllowed(this.ctx.keyScopes, op.scope) === false) return `the key lacks the scope ${op.scope}`;
    return undefined;
  }

  /** Learn the key's scopes (auth.me.show) when not yet known. Returns the key record. */
  async loadKey(): Promise<{ name?: string; prefix?: string; scopes?: string[]; expires_at?: string | null; client_id?: number } | undefined> {
    const r = await this.get('auth.me.show', {});
    if (!r.ok) return undefined;
    const key = (r.body ?? {}).key ?? {};
    if (Array.isArray(key.scopes)) this.ctx.keyScopes = key.scopes;
    return { ...key, client_id: (r.body ?? {}).client_id };
  }

  async get(id: string, args: CallArgs): Promise<CallOutcome> {
    return this.call(id, args);
  }

  async call(id: string, args: CallArgs, opts: { noPrecheck?: boolean } = {}): Promise<CallOutcome> {
    const why = opts.noPrecheck ? undefined : this.blocker(id);
    if (why) {
      this.skippedOps.push({ op: id, reason: why });
      return { op: id, ok: false, skipped: why };
    }
    this.calledOps.push(id);
    const res = await this.ctx.executor.call(id, args);
    return parseOutcome(id, res);
  }

  /** The operation ids to report: ones that were sent. */
  operationsCalled(): string[] {
    return [...new Set(this.calledOps)];
  }
}

function parseOutcome(op: string, res: ToolResult): CallOutcome {
  const text = res.content.map((c) => c.text).join('\n');
  if (res.isError) {
    const m = /^Hub answered (\d+) (\S+?):/.exec(text);
    return { op, ok: false, status: m ? Number(m[1]) : undefined, code: m?.[2], error: text };
  }
  try {
    const parsed = JSON.parse(text) as Json;
    if (parsed?.status === 'confirmation_required') {
      return { op, ok: false, error: 'The call returned a confirmation plan instead of running.' };
    }
    const body = parsed?.body;
    const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
    return { op, ok: true, data, body, meta: parsed?.meta, status: parsed?.meta?.status };
  } catch {
    return { op, ok: false, error: 'The answer was too large to read in full. Narrow the request.' };
  }
}

/** One-line reason for a failed or skipped call, for a report line. */
export function why(r: CallOutcome): string {
  if (r.skipped) return r.skipped;
  if (r.code === 'insufficient_scope') return 'the key lacks the needed scope';
  if (r.code === 'portal_unavailable') return 'the account does not use this portal';
  if (r.code && isApprovalCode(r.code)) return 'the area needs approval in the Hub under Developer > API access (run hb_status)';
  if (r.status === 404) return 'not found';
  const first = (r.error ?? 'failed').split('\n')[0] ?? 'failed';
  return first.length > 160 ? first.slice(0, 160) + '…' : first;
}

export function isUnavailable(r: CallOutcome): boolean {
  return r.code === 'portal_unavailable' || r.code === 'insufficient_scope' || (r.code !== undefined && isApprovalCode(r.code)) || r.skipped !== undefined;
}

export interface TaskReport {
  /** Readable lines. */
  lines: string[];
  /** Structured data for the model. */
  data: Record<string, unknown>;
}

export function taskResult(ctx: AppContext, run: TaskRun, report: TaskReport, isError = false): ToolResult {
  const data = {
    environment: ctx.config.mode,
    operations_called: run.operationsCalled(),
    operations_skipped: run.skippedOps.length ? run.skippedOps : undefined,
    ...report.data,
  };
  const max = ctx.config.maxResponseChars;
  let text = redactor.redact(report.lines.join('\n'));
  let json = redactor.redact(JSON.stringify(data, null, 1));
  if (text.length > max / 2) text = text.slice(0, max / 2) + '\n…[truncated]';
  if (json.length > max / 2) json = JSON.stringify({ environment: data.environment, operations_called: data.operations_called, note: 'Structured data omitted: too large. The text above is complete up to its limit.' });
  const result = { content: [{ type: 'text' as const, text }, { type: 'text' as const, text: json }] } as ToolResult;
  if (isError) result.isError = true;
  return result;
}

export function refusal(text: string): ToolResult {
  return textResult(redactor.redact(text), true);
}

/** Money: integer pence to a display amount. */
export function money(pence: unknown, currency: unknown): string {
  if (typeof pence !== 'number') return 'n/a';
  return `${(pence / 100).toFixed(2)} ${typeof currency === 'string' ? currency : 'GBP'}`;
}

export function day(v: unknown): string {
  return typeof v === 'string' && v ? v.slice(0, 10) : '-';
}

export function when(v: unknown): string {
  return typeof v === 'string' && v ? v.replace(/:\d\d(\.\d+)?Z$/, 'Z').replace('T', ' ') : '-';
}

/** A URL without credentials or query string (query strings often carry tokens). */
export function safeUrl(v: unknown): string {
  if (typeof v !== 'string') return '-';
  try {
    const u = new URL(v);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '[unreadable url]';
  }
}

/** Check the write gates for operations a task will send, before sending anything. Throws SafetyRefusal. */
export function assertWritable(ctx: AppContext, ids: string[]): void {
  for (const id of ids) {
    const op = ctx.catalogue.get(id);
    if (!op) throw new Error(`Task tool bug: unknown operation ${id}`);
    gate(ctx.config, op);
  }
}

export function refuseFromError(e: unknown): ToolResult | undefined {
  return e instanceof SafetyRefusal ? refusal(e.message) : undefined;
}

export function missingScopes(ctx: AppContext, ids: string[], run: TaskRun): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const op = run.op(id);
    if (scopeAllowed(ctx.keyScopes, op.scope) === false && op.scope) out.add(op.scope);
  }
  return [...out];
}

export function readOnlyHints() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
}

export function rows(r: CallOutcome): Json[] {
  return Array.isArray(r.data) ? r.data : [];
}

export function fail(ctx: AppContext, run: TaskRun, what: string, r: CallOutcome, key?: string): ToolResult {
  const lines = [`${what}.`, ...(r.error && !r.skipped ? [r.error] : [`Reason: ${why(r)}.`]), ...(key ? [`idempotency_key: ${key}`] : []), `Operations called: ${run.operationsCalled().join(', ')}.`];
  return taskResult(ctx, run, { lines, data: { executed: false, problem: why(r), idempotency_key: key } }, true);
}

/** True when the failure left the outcome of a write unknown (no answer or a server error). */
export function outcomeUnknown(r: CallOutcome): boolean {
  return (r.status === undefined && /No answer from the Hub/.test(r.error ?? '')) || (r.status ?? 0) >= 500;
}

/** Show only the end of an identifier: share codes, certificate and document numbers are never echoed in full. */
export function maskId(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, '');
  return s.length <= 4 ? '****' : `${'*'.repeat(Math.max(4, s.length - 3))}${s.slice(-3)}`;
}

/** Register values that must never appear in an answer, a log or an error the Hub echoes. */
export function protect(...values: unknown[]): void {
  for (const v of values) if (typeof v === 'string') redactor.add(v);
}

/** Write a one-time secret to a NEW owner-only file. Returns a problem text, or undefined when saved. */
export async function saveSecretFile(path: string, secret: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return 'save_secret_to must be an absolute path.';
  if (!existsSync(dirname(path))) return 'The folder for save_secret_to does not exist.';
  try {
    const f = await open(path, 'wx', 0o600);
    try {
      await f.writeFile(secret + '\n');
    } finally {
      await f.close();
    }
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'save_secret_to already exists; the server never overwrites files.' : 'The secret file could not be written.';
  }
}

/** Environment line used at the top of plans and results. */
export function environmentLine(ctx: AppContext): string {
  return ctx.config.mode === 'live' ? 'LIVE Hub: real people, real credits and real emails.' : 'SANDBOX: synthetic data; nobody real is contacted.';
}

/** A sentence that says clearly who will be emailed, and whether they are real. */
export function emailNote(ctx: AppContext, who: string): string {
  return ctx.config.mode === 'live'
    ? `An email WILL be sent to ${who} (a real person on the LIVE Hub).`
    : `An email will be sent to ${who} (in a sandbox it goes to the sandbox inbox, not to a real person).`;
}
