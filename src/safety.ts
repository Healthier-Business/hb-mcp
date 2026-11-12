import type { CatalogueOperation } from './catalogue.js';
import { writesEnabled, type Config } from './config.js';
import { howToConfirm } from './confirmation.js';
import { SafetyRefusal } from './errors.js';

export interface GateResult {
  /** True in live mode: the first call only returns the plan. */
  needsConfirm: boolean;
}

export function isWrite(op: CatalogueOperation): boolean {
  return op.method !== 'GET';
}

/** Can this operation be offered at all with this configuration (used to hide tools)? */
export function isOperationAvailable(config: Config, op: CatalogueOperation): boolean {
  if (op.internal || !config.toolsets.includes(op.toolset)) {
    return false;
  }
  return !isWrite(op) || writesEnabled(config);
}

/** Enforce read-only, live-write and toolset rules for one call. Throws SafetyRefusal. */
export function gate(config: Config, op: CatalogueOperation): GateResult {
  if (op.internal) {
    throw new SafetyRefusal(
      `${op.id} is handled by the server itself (it carries credentials). The server exchanges HB_API_KEY and refreshes tokens automatically; use hb_status to see who you are.`,
      'internal',
    );
  }
  if (!config.toolsets.includes(op.toolset)) {
    throw new SafetyRefusal(`${op.id} belongs to the "${op.toolset}" toolset, which is not enabled (HB_TOOLSETS=${config.toolsets.join(',')}).`, 'toolset');
  }
  if (!isWrite(op)) {
    return { needsConfirm: false };
  }
  if (config.readOnly) {
    throw new SafetyRefusal(
      `${op.id} is a write (${op.method}) and this server is read-only (HB_READ_ONLY=true, the default). Nothing was sent. To allow writes the owner must set HB_READ_ONLY=false${config.mode === 'live' ? ' and HB_ALLOW_LIVE_WRITES=true' : ''} in the server environment; try it in a sandbox first.`,
      'read_only',
    );
  }
  if (config.mode === 'live' && !config.allowLiveWrites) {
    throw new SafetyRefusal(
      `${op.id} is a write against the LIVE Hub. HB_READ_ONLY=false is set but HB_ALLOW_LIVE_WRITES is not true, so nothing was sent. Use a sandbox base URL (HB_BASE_URL) or ask the owner to set HB_ALLOW_LIVE_WRITES=true.`,
      'live_writes',
    );
  }
  return { needsConfirm: config.mode === 'live' };
}

export interface WritePlan {
  status: 'confirmation_required';
  executed: false;
  environment: 'LIVE';
  operation: string;
  request: string;
  summary: string;
  required_scope: string | null;
  will_change_real_data: true;
  credits: string | null;
  health_data: string | null;
  destructive: boolean;
  idempotency_key: string | undefined;
  body: unknown;
  /** Webhook create/update: the full destination URL (credentials removed), so the user sees where events will be sent. */
  webhook_url?: string;
  /** Set when a token the caller sent was refused (used, expired or for other arguments). */
  token_problem?: string;
  /** One-time token for the confirming call. Bound to this operation and these arguments. */
  confirmation_token: string;
  confirmation_expires_in_seconds: number;
  how_to_confirm: string;
}

const WEBHOOK_URL_OPERATIONS = new Set(['webhooks.endpoints.create', 'webhooks.endpoints.update']);

export function isWebhookUrlOperation(op: CatalogueOperation): boolean {
  return WEBHOOK_URL_OPERATIONS.has(op.id);
}

/**
 * The destination of a webhook endpoint write: must be https, with no username or password. Returns the URL to show in the
 * plan (the whole URL, query included, without credentials), or a problem text. `undefined` when the body carries no url
 * (an update that leaves the URL alone).
 */
export function checkWebhookUrl(body: unknown): { url?: string; problem?: string } {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).url : undefined;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { problem: 'url must be a string.' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { problem: 'url is not a valid address.' };
  }
  if (u.protocol !== 'https:') return { problem: `the webhook url must use https (got ${u.protocol.replace(':', '')}). Nothing was sent.` };
  if (u.username || u.password) return { problem: 'the webhook url must not contain a username or password. Nothing was sent.' };
  return { url: u.href };
}

export function buildPlan(
  op: CatalogueOperation,
  resolvedPath: string,
  body: unknown,
  idempotencyKey: string | undefined,
  confirmation: { token: string; expiresInSeconds: number; problem?: string },
  webhookUrl?: string,
): WritePlan {
  return {
    status: 'confirmation_required',
    executed: false,
    environment: 'LIVE',
    operation: op.id,
    request: `${op.method} ${resolvedPath}`,
    summary: op.summary,
    required_scope: op.scope,
    will_change_real_data: true,
    credits: op.credits ? op.credits.description : null,
    health_data: op.healthData
      ? 'This operation involves health data (special category). Only proceed if the user needs it for this task.'
      : null,
    destructive: op.destructive,
    idempotency_key: idempotencyKey,
    body: body ?? null,
    ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    ...(confirmation.problem ? { token_problem: confirmation.problem } : {}),
    confirmation_token: confirmation.token,
    confirmation_expires_in_seconds: confirmation.expiresInSeconds,
    how_to_confirm: howToConfirm(true, confirmation.token, idempotencyKey, confirmation.expiresInSeconds),
  };
}

/** The one-line badge put at the front of every operation description. */
export function modeBadge(config: Config): string {
  return config.mode === 'live' ? '[LIVE Hub]' : '[SANDBOX]';
}

export function writeNote(config: Config, op: CatalogueOperation): string {
  if (!isWrite(op)) {
    return op.healthData ? 'Read-only. Involves health data.' : 'Read-only.';
  }
  const parts: string[] = [];
  if (config.mode === 'live') {
    parts.push('WRITE against the LIVE Hub: real data, real emails/credits. First call returns a plan and a one-time confirmation_token; repeat with that token (not confirm=true) to execute.');
  } else {
    parts.push('Write (sandbox: synthetic data).');
  }
  if (op.credits) parts.push('Uses credits (units, not money; money is pence+currency).');
  if (op.healthData) parts.push('Involves health data.');
  if (op.destructive) parts.push('Destructive or hard to undo.');
  return parts.join(' ');
}
