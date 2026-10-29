import { z } from 'zod';
import type { CatalogueOperation } from '../catalogue.js';
import { writesEnabled } from '../config.js';
import { scopeAllowed, type AppContext } from '../context.js';
import { redactor } from '../redact.js';
import { isOperationAvailable, isWrite, modeBadge } from '../safety.js';
import { describeEventTool, listEventsTool, statusTool, verifySignatureTool } from './knowledge.js';
import { jsonResult, textResult, type ToolDefinition } from './types.js';

const searchArgs = z.object({
  query: z.string().optional(),
  toolset: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  scope: z.string().optional(),
  writes_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const describeArgs = z.object({ operation_id: z.string() });
const callArgs = z.object({
  operation_id: z.string(),
  path_params: z.record(z.string(), z.unknown()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  confirm: z.boolean().optional(),
  all_pages: z.boolean().optional(),
  max_pages: z.number().int().min(1).max(20).optional(),
  fields: z.array(z.string()).optional(),
  idempotency_key: z.string().max(255).optional(),
});

export function summariseOperation(ctx: AppContext, op: CatalogueOperation) {
  const allowed = isOperationAvailable(ctx.config, op);
  const keyAllows = scopeAllowed(ctx.keyScopes, op.scope);
  return {
    id: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    toolset: op.toolset,
    scope: op.scope,
    kind: isWrite(op) ? 'write' : 'read',
    credits: op.credits ? true : undefined,
    health_data: op.healthData || undefined,
    destructive: op.destructive || undefined,
    paginated: op.paginated || undefined,
    callable_now: allowed,
    why_not: allowed ? undefined : op.internal ? 'handled by the server itself' : !ctx.config.toolsets.includes(op.toolset) ? 'toolset disabled' : 'writes are disabled (read-only)',
    key_has_scope: keyAllows === null ? undefined : keyAllows,
  };
}

function exampleCall(op: CatalogueOperation) {
  const path_params: Record<string, string> = {};
  for (const p of op.parameters.filter((x) => x.in === 'path')) path_params[p.name] = `<${p.name}>`;
  return {
    operation_id: op.id,
    path_params: Object.keys(path_params).length ? path_params : undefined,
    query: op.paginated ? { per_page: 25 } : undefined,
    body: op.body?.example ?? undefined,
    confirm: isWrite(op) ? '(true only after the user approved the plan; required in live)' : undefined,
  };
}

export function describeOperation(ctx: AppContext, op: CatalogueOperation) {
  const requiredBody = op.body && Array.isArray(op.body.schema.required) ? op.body.schema.required : [];
  return {
    ...summariseOperation(ctx, op),
    environment: ctx.config.mode,
    description: op.description.length > 9000 ? op.description.slice(0, 9000) + '…' : op.description,
    parameters: op.parameters.map((p) => ({ name: p.name, in: p.in, required: p.required, description: p.description, schema: p.schema })),
    body: op.body
      ? { required: op.body.required, content_types: op.body.contentTypes, required_fields: requiredBody, schema: op.body.schema, example: op.body.example }
      : null,
    response: { success_status: op.success.status, content_types: op.success.contentTypes },
    errors: op.errors.map((e) => ({ status: e.status, codes: e.codes })),
    side_effects: {
      changes_data: isWrite(op),
      credits: op.credits?.description ?? null,
      blocks_when_balance_short: op.credits?.blocksWhenBalanceShort ?? false,
      health_data: op.healthData,
      destructive: op.destructive,
      idempotency: op.hasIdempotencyKey ? 'Send an Idempotency-Key (the server generates one). The same key and body within 24 hours replays the first answer.' : 'No Idempotency-Key support: do not repeat blindly.',
      live_confirmation: isWrite(op) && ctx.config.mode === 'live' ? 'The first call returns a plan; repeat with confirm=true.' : undefined,
    },
    how_to_call: exampleCall(op),
  };
}

export function buildCompactTools(ctx: AppContext): ToolDefinition[] {
  const { config, catalogue } = ctx;
  const writes = writesEnabled(config);
  const badge = modeBadge(config);

  const search: ToolDefinition = {
    name: 'hb_search_operations',
    description: `Search the ${catalogue.operations.length} Hub API v2 operations by text, toolset (portal), method or scope. Returns id, method, path, summary, scope, flags (credits, health data, destructive) and whether each is callable now. Start here, then hb_describe_operation, then hb_call_operation.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "book practical training", "candidate compliance", "webhook".' },
        toolset: { type: 'string', description: 'Portal: hub, account, online-training, occupational-health, references, practical-training, virtual-bls-training, clinical-interviews, registration-monitoring, dbs-rtw, clinical-appraisals, authentication.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        scope: { type: 'string', description: 'Substring of the required scope, e.g. "bookings:write".' },
        writes_only: { type: 'boolean', description: 'Only operations that change data.' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Search Hub operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (raw) => {
      const a = searchArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const found = catalogue.search({ query: a.data.query, toolset: a.data.toolset, method: a.data.method, scope: a.data.scope, writesOnly: a.data.writes_only, limit: a.data.limit });
      return jsonResult({ count: found.length, operations: found.map((o) => summariseOperation(ctx, o)) }, (s) => redactor.redact(s));
    },
  };

  const describe: ToolDefinition = {
    name: 'hb_describe_operation',
    description: 'Full detail of one operation: parameters, body schema with required fields and an example, required scope, side effects (credits, health data, destructive, idempotency), documented errors, and a ready example call for hb_call_operation. Read this before any write.',
    inputSchema: { type: 'object', properties: { operation_id: { type: 'string', description: 'e.g. hub.candidates.list' } }, required: ['operation_id'], additionalProperties: false },
    annotations: { title: 'Describe Hub operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (raw) => {
      const a = describeArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.message}`, true);
      const op = catalogue.get(a.data.operation_id);
      if (!op) {
        const near = catalogue.suggest(a.data.operation_id);
        return textResult(`Unknown operation "${a.data.operation_id}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`, true);
      }
      return jsonResult(describeOperation(ctx, op), (s) => redactor.redact(s));
    },
  };

  const call: ToolDefinition = {
    name: 'hb_call_operation',
    description:
      `${badge} Call any Hub API v2 operation by id. Validates against the spec before sending; adds an Idempotency-Key to writes; follows pagination with all_pages (capped). ` +
      (writes
        ? config.mode === 'live'
          ? 'Writes are ENABLED against the LIVE Hub: the first write call returns a plan and sends nothing; repeat with confirm=true only after the user approves.'
          : 'Writes are enabled in this SANDBOX (synthetic data).'
        : 'The server is READ-ONLY: only GET operations run; writes are refused.') +
      ' Put path parameters in path_params, filters in query, JSON in body. Use `fields` (dotted paths such as ["candidate_ref","name"]) to keep answers small. Credits are units; money is integer pence with a currency. Never ask the user for an API key in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_id: { type: 'string', description: 'Operation id from hb_search_operations, e.g. hub.candidates.list.' },
        path_params: { type: 'object', description: 'Values for {placeholders} in the path, e.g. {"candidate_ref":"<uuid>"}.' },
        query: { type: 'object', description: 'Query parameters, e.g. {"per_page":50,"search":"jane"}.' },
        body: { description: 'JSON request body (object). For file uploads use {"filename","content_base64","content_type"} for file fields.' },
        headers: { type: 'object', description: 'Only headers the operation declares (e.g. Idempotency-Key). Authorization is never settable.' },
        confirm: { type: 'boolean', description: 'Live writes only: true after the user approved the plan.' },
        all_pages: { type: 'boolean', description: 'List operations: fetch following pages and merge data.' },
        max_pages: { type: 'integer', description: 'With all_pages: pages to fetch (default 5, max 20).' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these dotted paths of each record in `data`.' },
        idempotency_key: { type: 'string', description: 'Reuse the key from a plan or an earlier unknown-outcome write to repeat it safely.' },
      },
      required: ['operation_id'],
      additionalProperties: false,
    },
    annotations: writes
      ? { title: 'Call Hub operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      : { title: 'Call Hub operation (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (raw) => {
      const a = callArgs.safeParse(raw);
      if (!a.success) return textResult(`Invalid arguments: ${a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true);
      const { operation_id, ...rest } = a.data;
      return ctx.executor.call(operation_id, rest);
    },
  };

  return [statusTool(ctx), search, describe, call, listEventsTool(ctx), describeEventTool(ctx), verifySignatureTool(ctx)];
}
