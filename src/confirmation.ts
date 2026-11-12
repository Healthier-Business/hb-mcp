import { createHash, randomBytes } from 'node:crypto';

/** How long a confirmation token stays valid, in seconds. */
export const CONFIRMATION_TTL_SECONDS = 600;
const MAX_TOKENS = 200;

export type ConfirmationFailure = 'missing' | 'unknown_or_used' | 'expired' | 'mismatch';

export type ConsumeResult = { ok: true; idempotencyKey: string | undefined } | { ok: false; reason: ConfirmationFailure };

interface Entry {
  fingerprint: string;
  expiresAt: number;
  idempotencyKey: string | undefined;
}

/** Arguments that steer the confirmation itself and so never take part in what the token is bound to. */
const CONTROL_ARGS = new Set(['confirm', 'confirmation_token', 'idempotency_key']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** SHA-256 of the operation (or tool) name, the arguments without the control fields (and `ignore`), and an optional binding string. */
export function fingerprint(tool: string, args: Record<string, unknown>, options: { ignore?: readonly string[]; binding?: string } = {}): string {
  const ignore = new Set(options.ignore ?? []);
  const kept = Object.fromEntries(Object.entries(args).filter(([k]) => !CONTROL_ARGS.has(k) && !ignore.has(k)));
  return createHash('sha256')
    .update(JSON.stringify({ tool, args: canonical(kept), binding: options.binding ?? null }))
    .digest('hex');
}

/**
 * Server-issued, one-time confirmation tokens for live writes. A write call that is not yet confirmed returns its plan
 * and a token; only a second call carrying that token runs. A token is random, bound to the exact tool and arguments (and,
 * for a task tool, to what the plan computed), expires after ten minutes, works once, and is kept in memory only. A model
 * that sends `confirm: true` on its first call therefore gets a plan, not an action.
 */
export class ConfirmationStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlSeconds = CONFIRMATION_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  issue(tool: string, args: Record<string, unknown>, options: { ignore?: readonly string[]; binding?: string; idempotencyKey?: string } = {}): { token: string; expiresInSeconds: number } {
    this.prune();
    const token = `hbc_${randomBytes(24).toString('base64url')}`;
    this.entries.set(token, {
      fingerprint: fingerprint(tool, args, options),
      expiresAt: this.now() + this.ttlSeconds * 1000,
      idempotencyKey: options.idempotencyKey,
    });
    while (this.entries.size > MAX_TOKENS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { token, expiresInSeconds: this.ttlSeconds };
  }

  /** The idempotency key the plan promised, without using the token up. Used so the confirming call repeats the planned key. */
  peekIdempotencyKey(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const e = this.entries.get(token);
    return e && e.expiresAt > this.now() ? e.idempotencyKey : undefined;
  }

  /** Use a token. Every attempt with a known token removes it, whether it fits or not: a token never gets a second try. */
  consume(token: string | undefined, tool: string, args: Record<string, unknown>, options: { ignore?: readonly string[]; binding?: string } = {}): ConsumeResult {
    if (!token) return { ok: false, reason: 'missing' };
    const e = this.entries.get(token);
    if (!e) return { ok: false, reason: 'unknown_or_used' };
    this.entries.delete(token);
    if (e.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
    if (e.fingerprint !== fingerprint(tool, args, options)) return { ok: false, reason: 'mismatch' };
    return { ok: true, idempotencyKey: e.idempotencyKey };
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const at = this.now();
    for (const [token, e] of this.entries) {
      if (e.expiresAt <= at) this.entries.delete(token);
    }
  }
}

export function explainFailure(reason: ConfirmationFailure): string {
  switch (reason) {
    case 'missing': return '';
    case 'unknown_or_used': return 'The confirmation token was not recognised (it may have been used already, or the server restarted).';
    case 'expired': return 'The confirmation token has expired.';
    case 'mismatch': return 'The confirmation token belongs to a different operation or different arguments than this call.';
  }
}

export interface ConfirmationDecision {
  confirmed: boolean;
  /** Set when a new token was issued (the call is a plan). */
  token?: string;
  expiresInSeconds?: number;
  /** Why a supplied token was refused. */
  rejected?: string;
  idempotencyKey?: string;
}

/**
 * The decision for one task-tool call: confirmed by a valid token, or (sandbox only) by `confirm: true`, otherwise a plan
 * and a new token. On the LIVE Hub a bare `confirm: true` is never enough.
 */
export function decide(
  store: ConfirmationStore,
  input: { live: boolean; tool: string; args: Record<string, unknown>; ignore?: readonly string[]; binding?: string; idempotencyKey: string; issueToken?: boolean },
): ConfirmationDecision {
  const token = typeof input.args.confirmation_token === 'string' ? input.args.confirmation_token : undefined;
  let rejected: string | undefined;
  if (token) {
    const r = store.consume(token, input.tool, input.args, { ignore: input.ignore, binding: input.binding });
    if (r.ok) return { confirmed: true, idempotencyKey: r.idempotencyKey ?? input.idempotencyKey };
    rejected = explainFailure(r.reason);
  }
  if (!input.live && input.args.confirm === true) return { confirmed: true, idempotencyKey: input.idempotencyKey };
  if (input.issueToken === false) return { confirmed: false, rejected };
  const issued = store.issue(input.tool, input.args, { ignore: input.ignore, binding: input.binding, idempotencyKey: input.idempotencyKey });
  return { confirmed: false, token: issued.token, expiresInSeconds: issued.expiresInSeconds, rejected, idempotencyKey: input.idempotencyKey };
}

/** The sentence that tells the model how to proceed after a plan. */
export function howToConfirm(live: boolean, token: string | undefined, idempotencyKey: string | undefined, expiresInSeconds = CONFIRMATION_TTL_SECONDS): string {
  const key = idempotencyKey ? ` and idempotency_key "${idempotencyKey}"` : '';
  if (!token) return 'Nothing was sent.';
  const minutes = Math.round(expiresInSeconds / 60);
  return live
    ? `Nothing was sent. Show this plan to the user. Only after they agree, call again with the same arguments plus confirmation_token "${token}"${key}. The token works once, only for these exact arguments, for ${minutes} minutes; confirm=true alone does nothing on the LIVE Hub.`
    : `Nothing was sent. To proceed, call again with the same arguments plus confirm=true${key}, after the user agrees (confirmation_token "${token}" is also accepted).`;
}
