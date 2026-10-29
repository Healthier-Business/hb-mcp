import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { redactor } from '../redact.js';
import { SERVER_VERSION, type AppContext, scopeAllowed } from '../context.js';
import { describeError } from '../errors.js';
import { writesEnabled } from '../config.js';
import { searchGuides } from '../guides.js';
import { jsonResult, textResult, type ToolDefinition } from './types.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Compute `sha256=` + hex HMAC of `{timestamp}.{rawBody}`, and verify against a given signature in constant time. */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function verifyWebhook(opts: { secret: string; timestamp: string; body: string; signature?: string; toleranceSeconds?: number; nowSeconds?: number }) {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const timestampValid = /^[0-9]+$/.test(opts.timestamp);
  const age = timestampValid ? now - Number(opts.timestamp) : null;
  const withinWindow = age !== null && Math.abs(age) <= tolerance;
  const expected = webhookSignature(opts.secret, opts.timestamp, opts.body);
  let signatureMatches: boolean | null = null;
  if (opts.signature !== undefined) {
    const given = Buffer.from(opts.signature.trim());
    const want = Buffer.from(expected);
    signatureMatches = given.length === want.length && timingSafeEqual(given, want);
  }
  return {
    timestampValid,
    ageSeconds: age,
    withinWindow,
    signatureMatches,
    valid: timestampValid && withinWindow && signatureMatches === true,
    expected,
  };
}

export function statusTool(ctx: AppContext): ToolDefinition {
  return {
    name: 'hb_status',
    description:
      'Who am I and what may I do? Calls GET /auth/me and reports: environment (live or sandbox), base URL, key name and prefix, the key\'s scopes, whether writes are enabled, the toolsets, and the last-seen rate limit. Never reveals a key or token. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Hub status', ...READ_ONLY, openWorldHint: true },
    handler: async () => {
      const c = ctx.config;
      const status: Record<string, unknown> = {
        server: { name: 'hb-hub-mcp', version: SERVER_VERSION },
        environment: c.mode === 'live' ? 'LIVE (real data)' : 'SANDBOX (synthetic data)',
        mode: c.mode,
        mode_detected_from: c.modeSource,
        base_url: c.baseUrl,
        tool_mode: c.toolMode,
        read_only: c.readOnly,
        writes_enabled: writesEnabled(c),
        writes_note: c.readOnly
          ? 'Read-only: every non-GET operation is refused. The owner enables writes with HB_READ_ONLY=false.'
          : c.mode === 'live'
            ? c.allowLiveWrites
              ? 'Live writes allowed; each needs confirm=true after the plan is shown.'
              : 'HB_READ_ONLY=false but live writes are not allowed (HB_ALLOW_LIVE_WRITES is not true).'
            : 'Sandbox writes allowed (synthetic data).',
        toolsets: c.toolsets,
        spec: { version: ctx.catalogue.specVersion, operations: ctx.catalogue.operations.length, webhook_events: ctx.catalogue.events.length },
      };
      const warnings: string[] = [];
      if (!ctx.tokens.hasKey) {
        status.auth = { configured: false, problem: 'HB_API_KEY is not set in the server environment.' };
        warnings.push('No API key configured: Hub calls will fail. Set HB_API_KEY in the MCP server config (never paste a key in chat) and restart.');
        if (c.modeSource === 'default') {
          warnings.push('The base URL is the default LIVE Hub (HB_BASE_URL is not set to a sandbox). To build or learn, use a sandbox base address (see hb://guides/portal-sandboxes).');
        }
        status.getting_started =
          'No key yet? Read hb://guides/portal-create-your-account (sign up with a work email and verify it), hb://guides/portal-sandboxes (create a sandbox) and hb://guides/portal-api-keys-and-tokens (create a test key), or run the get-started-in-sandbox prompt. Then set HB_API_KEY and HB_BASE_URL in the MCP server config and restart.';
      } else {
        try {
          const res = await ctx.client.send({ method: 'GET', path: '/api/v2/auth/me', pathTemplate: '/api/v2/auth/me', retryable: true });
          const me = res.json as { client_id?: number; key?: { name?: string; prefix?: string; scopes?: string[]; expires_at?: string | null } };
          ctx.keyScopes = me.key?.scopes ?? [];
          status.auth = { configured: true, ok: true, client_id: me.client_id, key: me.key, session: ctx.tokens.summary() };
          if (me.key?.prefix?.startsWith('hbk_test') && c.mode === 'live') {
            warnings.push('The key looks like a sandbox test key but the base URL is treated as LIVE.');
          }
          if (!me.key?.prefix?.startsWith('hbk_test') && c.mode === 'sandbox') {
            warnings.push('A non-test key is being sent to a URL treated as sandbox. Check HB_BASE_URL and HB_ENV.');
          }
        } catch (e) {
          status.auth = { configured: true, ok: false, problem: describeError(e) };
        }
      }
      status.rate_limit = ctx.client.lastRateLimit.limit !== undefined ? ctx.client.lastRateLimit : 'not seen yet';
      if (warnings.length) status.warnings = warnings;
      return jsonResult(status, (s) => redactor.redact(s));
    },
  };
}

const searchGuidesArgs = z.object({
  query: z.string().min(1),
  group: z.enum(['all', 'api', 'portal']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const listEventsArgs = z.object({ portal: z.string().optional(), query: z.string().optional() });
const describeEventArgs = z.object({ event_type: z.string() });
const verifyArgs = z.object({
  body: z.string().min(1),
  timestamp: z.string().min(1),
  signature: z.string().optional(),
  secret: z.string().optional(),
  tolerance_seconds: z.number().int().min(1).max(86_400).optional(),
  now_epoch_seconds: z.number().int().optional(),
});

export function searchGuidesTool(): ToolDefinition {
  return {
    name: 'hb_search_guides',
    description:
      'Search the bundled guides by words and get the best matches with a snippet and the resource to read (hb://guides/<name>). Covers the Hub API v2 developer guides and the developer portal guides (sign up, sandboxes, keys, webhooks, Playground, going to production). Knowledge only: sends nothing, needs no key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "create sandbox", "rotate webhook secret", "idempotency key".' },
        group: { type: 'string', enum: ['all', 'api', 'portal'], description: '"api" = Hub API guides, "portal" = developer portal (console) guides. Default all.' },
        limit: { type: 'integer', description: 'Max results (default 5, max 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search guides', ...READ_ONLY },
    handler: async (raw) => {
      const a = searchGuidesArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const hits = searchGuides(a.data.query, { group: a.data.group, limit: a.data.limit });
      return jsonResult({ count: hits.length, guides: hits.map((h) => ({ uri: h.uri, title: h.title, description: h.description, snippet: h.snippet })), next: 'Read a guide in full with its hb://guides/<name> resource.' }, (s) => s);
    },
  };
}

export function listEventsTool(ctx: AppContext): ToolDefinition {
  return {
    name: 'hb_list_events',
    description: 'List the 59 webhook events Hub can send (type and one-line summary). Optionally filter by portal prefix (e.g. "occupational-health") or text. Knowledge only: sends nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        portal: { type: 'string', description: 'Portal prefix, e.g. occupational-health, practical-training, hub.' },
        query: { type: 'string', description: 'Text to match in the event type or summary.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List webhook events', ...READ_ONLY },
    handler: async (raw) => {
      const a = listEventsArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const q = a.data.query?.toLowerCase();
      const events = ctx.catalogue.events
        .filter((e) => !a.data.portal || e.portal === a.data.portal.toLowerCase())
        .filter((e) => !q || e.type.includes(q) || e.summary.toLowerCase().includes(q))
        .map((e) => ({ type: e.type, portal: e.portal, summary: e.summary }));
      return jsonResult({ count: events.length, events, next: 'hb_describe_event gives the payload schema and an example.' }, (s) => s);
    },
  };
}

export function describeEventTool(ctx: AppContext): ToolDefinition {
  return {
    name: 'hb_describe_event',
    description: 'Describe one webhook event: summary, delivery behaviour (retries), the `data` payload schema and a sample payload. Payloads hold ids, statuses, dates and a candidate_ref, never names, emails or health data. Knowledge only.',
    inputSchema: { type: 'object', properties: { event_type: { type: 'string', description: 'e.g. occupational-health.request.submitted' } }, required: ['event_type'], additionalProperties: false },
    annotations: { title: 'Describe webhook event', ...READ_ONLY },
    handler: async (raw) => {
      const a = describeEventArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const ev = ctx.catalogue.event(a.data.event_type);
      if (!ev) {
        const near = ctx.catalogue.events.filter((e) => e.type.includes(a.data.event_type.toLowerCase())).slice(0, 8).map((e) => e.type);
        return textResult(`Unknown event "${a.data.event_type}".${near.length ? ` Similar: ${near.join(', ')}.` : ''} Use hb_list_events.`, true);
      }
      return jsonResult(
        {
          type: ev.type,
          summary: ev.summary,
          description: ev.description,
          envelope: 'Every delivery body is { event_id, event_type, occurred_at, data }.',
          headers: ['X-Hub-Signature (sha256=hex HMAC of "{timestamp}.{raw body}")', 'X-Hub-Timestamp (epoch seconds)', 'X-Hub-Event', 'X-Hub-Event-Id (stable across redeliveries; dedupe on it)', 'X-Hub-Delivery-Id'],
          verification: 'Reject if the timestamp is more than 300 seconds from now or the signature does not match. hb_verify_webhook_signature does this locally.',
          data_schema: ev.dataSchema,
          example: ev.example,
        },
        (s) => s,
      );
    },
  };
}

export function verifySignatureTool(ctx: AppContext): ToolDefinition {
  return {
    name: 'hb_verify_webhook_signature',
    description:
      'Pure local helper (no network): verify or compute a Hub webhook signature. The signature is "sha256=" plus the hex HMAC-SHA256 of "{timestamp}.{raw body}" with the endpoint secret; deliveries older or newer than 300 seconds are rejected. Pass the raw body byte-for-byte. The secret is read from HB_WEBHOOK_SECRET unless passed (prefer a sandbox secret if you pass it in chat). Omit `signature` to just compute it.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The raw request body exactly as received.' },
        timestamp: { type: 'string', description: 'The X-Hub-Timestamp header (epoch seconds).' },
        signature: { type: 'string', description: 'The X-Hub-Signature header. Omit to compute the expected signature.' },
        secret: { type: 'string', description: 'Endpoint signing secret. Defaults to env HB_WEBHOOK_SECRET.' },
        tolerance_seconds: { type: 'integer', description: 'Replay window; default 300.' },
        now_epoch_seconds: { type: 'integer', description: 'Override the current time (for testing recorded deliveries).' },
      },
      required: ['body', 'timestamp'],
      additionalProperties: false,
    },
    annotations: { title: 'Verify webhook signature', ...READ_ONLY },
    handler: async (raw) => {
      const a = verifyArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const secret = a.data.secret ?? ctx.config.webhookSecret;
      if (!secret) return textResult('No secret: set HB_WEBHOOK_SECRET in the server environment or pass `secret`.', true);
      redactor.add(secret);
      const r = verifyWebhook({
        secret,
        timestamp: a.data.timestamp,
        body: a.data.body,
        signature: a.data.signature,
        toleranceSeconds: a.data.tolerance_seconds,
        nowSeconds: a.data.now_epoch_seconds,
      });
      const out: Record<string, unknown> = {
        valid: a.data.signature !== undefined ? r.valid : undefined,
        signature_matches: r.signatureMatches,
        timestamp_valid: r.timestampValid,
        age_seconds: r.ageSeconds,
        within_replay_window: r.withinWindow,
        expected_signature: a.data.signature === undefined ? r.expected : undefined,
        reminder: 'Also ignore an X-Hub-Event-Id you have already handled, check X-Hub-Event is the event you expect, and answer 2xx quickly.',
      };
      return jsonResult(out, (s) => redactor.redact(s));
    },
  };
}

export { scopeAllowed };
