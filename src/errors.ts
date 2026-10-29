import { redactor } from './redact.js';

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
}

/** An error answered by the Hub (the documented `{error, message, details, request_id}` body). */
export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly requestId: string | undefined,
    readonly retryAfterSeconds: number | undefined,
    readonly rateLimit: RateLimitInfo = {},
  ) {
    super(message);
  }
}

/** The request could not be completed (no answer, timeout). For writes the outcome is unknown. */
export class HubNetworkError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
  }
}

/** The local auth throttle (10 a minute) or a 429 from the auth endpoints. */
export class AuthThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Authentication is throttled (10 token calls a minute). Retry in ${retryAfterSeconds}s.`);
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('HB_API_KEY is not set. Put the API key in the MCP server environment (never in chat) and restart the server. No key yet? Point the user to the developer portal guides: read hb://guides/portal-create-your-account (sign up and verify a work email), hb://guides/portal-sandboxes (create a sandbox) and hb://guides/portal-api-keys-and-tokens (create a test key), or use the get-started-in-sandbox prompt.');
  }
}

/** A problem with what the caller asked for, found before anything was sent. */
export class ToolInputError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
  }
}

/** A safety rule stopped the call before it was sent. */
export class SafetyRefusal extends Error {
  constructor(message: string, readonly rule: 'read_only' | 'live_writes' | 'toolset' | 'internal') {
    super(message);
  }
}

const GUIDANCE: Record<number, string> = {
  400: 'The body was not valid JSON. Check the body object and try again.',
  401: 'The token was refused even after a refresh. Check that HB_API_KEY is current (it may have been regenerated or deleted).',
  402: 'The account does not have enough credits or balance. Credits are units; money is integer pence with a currency. Do not retry: ask the user to top up in the Hub (or use another pay_option if the operation offers one).',
  403: 'The key may not do this. Read the code: insufficient_scope (add the named scope to the key in the Hub Developer page), portal_unavailable (the account does not use this portal), key_inactive (key switched off or expired), ip_not_allowed (see the IP hint).',
  404: 'Not found. Check the id or candidate_ref (it must be a candidate_ref uuid, not an internal id) and that you are in the right environment: sandbox ids mean nothing in live.',
  409: 'Conflict with current state (a taken slot, an existing hold, or an Idempotency-Key reused with a different body). Re-read the current state before trying again; do not repeat the same write blindly.',
  413: 'The upload or body is too large. Reduce it.',
  415: 'Unsupported media type for this operation. Use the content type the operation describes.',
  422: 'Validation failed. `details` maps each field to its messages. Fix those fields and call again; nothing was changed.',
  429: 'Rate limited. Wait for Retry-After before calling again; avoid broad loops, use filters and per_page up to 100.',
  500: 'Hub server error. Quote the request_id to support. A write may or may not have happened: read the record before repeating, or repeat with the same Idempotency-Key.',
  503: 'The Hub is temporarily unavailable. Try again shortly.',
};

const CODE_GUIDANCE: Record<string, string> = {
  insufficient_scope: 'The key lacks the scope named in the message. Ask the user to add that scope to the key on the Hub Developer page (a :write scope also grants :read). Run hb_status to see the key\'s scopes.',
  ip_not_allowed:
    'The key has an IP allowlist and this machine\'s public address is not on it. With the stdio transport the call leaves from the machine that runs this server, so that machine\'s own IP must be allowlisted (or use a sandbox). Ask the user to add the address on the Hub Developer page.',
  key_inactive: 'The key is switched off or has expired. Ask the user to switch it on or create a new one in the Hub, then restart the server with the new HB_API_KEY.',
  portal_unavailable: 'The account does not use this portal, so its endpoints answer 403. Choose an endpoint of a portal the account has.',
  insufficient_credits: 'Not enough credits or balance. Nothing was charged. Ask the user to top up, or choose a different pay_option if the operation supports one.',
  idempotency_conflict: 'The same Idempotency-Key was used earlier with a different body. Use a new key for a different request, or resend exactly the original body to get the first answer.',
  invalid_credentials: 'HB_API_KEY is wrong, deleted or regenerated. Ask the user to check the key; do not retry.',
  validation_failed: 'Fix the fields named in `details` and call again. Nothing was changed.',
  rate_limited: 'Wait for Retry-After before the next call.',
  slot_taken: 'That slot was just taken. List the available slots again and pick another.',
};

/** Turn any thrown error into a clear, secret-free message for the model. */
export function describeError(e: unknown): string {
  if (e instanceof HubApiError) {
    const lines = [`Hub answered ${e.status} ${e.code}: ${e.message}`];
    if (e.details !== undefined && e.details !== null && Object.keys(e.details as object).length > 0) {
      lines.push(`details: ${JSON.stringify(e.details)}`);
    }
    if (e.requestId) {
      lines.push(`request_id: ${e.requestId} (quote this to support)`);
    }
    if (e.retryAfterSeconds !== undefined) {
      lines.push(`retry_after_seconds: ${e.retryAfterSeconds}`);
    }
    if (e.rateLimit.remaining !== undefined) {
      lines.push(`rate_limit: ${e.rateLimit.remaining}/${e.rateLimit.limit ?? '?'} remaining`);
    }
    lines.push(`What to do next: ${CODE_GUIDANCE[e.code] ?? GUIDANCE[e.status] ?? 'Read the message and the operation description before trying again.'}`);
    return redactor.redact(lines.join('\n'));
  }
  if (e instanceof HubNetworkError) {
    return redactor.redact(
      `No answer from the Hub (${e.timedOut ? 'timed out' : e.message}). For a read, simply try again. For a write the outcome is unknown: do not repeat it blindly; check the record, or repeat with the same idempotency_key shown.`,
    );
  }
  if (e instanceof AuthThrottledError || e instanceof MissingApiKeyError || e instanceof SafetyRefusal || e instanceof ToolInputError) {
    const issues = e instanceof ToolInputError && e.issues.length ? '\n- ' + e.issues.join('\n- ') : '';
    return redactor.redact(e.message + issues);
  }
  return redactor.redact(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
}
