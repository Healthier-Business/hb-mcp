import type { CatalogueOperation } from '../catalogue.js';
import type { JsonObject } from '../generator/build.js';
import type { AppContext } from '../context.js';
import { isOperationAvailable, isWrite, modeBadge, writeNote } from '../safety.js';
import { slimSchema } from '../schema.js';
import { describeEventTool, listEventsTool, statusTool, verifySignatureTool } from './knowledge.js';
import type { ToolAnnotations, ToolDefinition } from './types.js';

const RESERVED = new Set(['body', 'confirm', 'fields', 'all_pages', 'max_pages', 'idempotency_key']);

export function annotationsFor(op: CatalogueOperation): ToolAnnotations {
  const read = op.method === 'GET';
  return {
    title: op.summary,
    readOnlyHint: read,
    destructiveHint: read ? false : op.destructive,
    idempotentHint: read || op.method === 'PUT' || op.method === 'DELETE' || op.hasIdempotencyKey,
    openWorldHint: true,
  };
}

function trimDescription(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

interface ArgMap {
  path: string[];
  query: string[];
}

/** Flat input schema: path + query parameters at the top level, `body`, and the call controls. */
export function buildInputSchema(op: CatalogueOperation): { schema: JsonObject; argMap: ArgMap } {
  const properties: JsonObject = {};
  const required: string[] = [];
  const argMap: ArgMap = { path: [], query: [] };
  for (const p of op.parameters) {
    if (p.in === 'header') continue;
    if (RESERVED.has(p.name) || p.name in properties) {
      throw new Error(`${op.id}: parameter name "${p.name}" collides with a reserved or duplicate tool argument`);
    }
    properties[p.name] = { ...(slimSchema(p.schema) as JsonObject), description: trimDescription(p.description, 160) };
    (p.in === 'path' ? argMap.path : argMap.query).push(p.name);
    if (p.required) required.push(p.name);
  }
  if (op.body) {
    const schema = slimSchema(op.body.schema) as JsonObject;
    properties.body = { ...schema, description: trimDescription(String(op.body.schema.description ?? 'Request body.'), 160) };
    if (op.body.required) required.push('body');
  }
  if (op.hasIdempotencyKey) {
    properties.idempotency_key = { type: 'string', description: 'Reuse a key from a plan or an unknown-outcome call to repeat the write safely. Generated if omitted.' };
  }
  if (isWrite(op)) {
    properties.confirm = { type: 'boolean', description: 'Live Hub only: true after the user approved the plan returned by the first call.' };
  }
  if (op.paginated) {
    properties.all_pages = { type: 'boolean', description: 'Fetch following pages and merge them (capped).' };
    properties.max_pages = { type: 'integer', description: 'With all_pages: pages to fetch (default 5, max 20).' };
  }
  if (op.method === 'GET' && op.success.contentTypes.includes('application/json')) {
    properties.fields = { type: 'array', items: { type: 'string' }, description: 'Keep only these dotted paths of each record in `data`.' };
  }
  const schema: JsonObject = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return { schema, argMap };
}

export function toolDescription(ctx: AppContext, op: CatalogueOperation): string {
  const bits = [
    `${modeBadge(ctx.config)} ${op.summary}.`,
    writeNote(ctx.config, op),
    op.scope ? `Scope: ${op.scope}.` : '',
    op.credits ? `Credits: ${trimDescription(op.credits.description, 220)}` : '',
    trimDescription(op.description, 700),
  ];
  return bits.filter(Boolean).join(' ');
}

export function buildFullTools(ctx: AppContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [statusTool(ctx), listEventsTool(ctx), describeEventTool(ctx), verifySignatureTool(ctx)];
  for (const op of ctx.catalogue.operations) {
    if (!isOperationAvailable(ctx.config, op)) continue;
    const { schema, argMap } = buildInputSchema(op);
    tools.push({
      name: op.toolName,
      description: toolDescription(ctx, op),
      inputSchema: schema,
      annotations: annotationsFor(op),
      handler: async (args) => {
        const path_params: Record<string, unknown> = {};
        const query: Record<string, unknown> = {};
        for (const n of argMap.path) if (args[n] !== undefined) path_params[n] = args[n];
        for (const n of argMap.query) if (args[n] !== undefined) query[n] = args[n];
        const unknown = Object.keys(args).filter((k) => !(k in (schema.properties as JsonObject)));
        if (unknown.length) {
          return { isError: true, content: [{ type: 'text', text: `Unknown argument(s): ${unknown.join(', ')}. Valid: ${Object.keys(schema.properties as JsonObject).join(', ')}` }] };
        }
        return ctx.executor.call(op.id, {
          path_params,
          query,
          body: args.body,
          confirm: args.confirm === true,
          all_pages: args.all_pages === true,
          max_pages: typeof args.max_pages === 'number' ? args.max_pages : undefined,
          fields: Array.isArray(args.fields) ? (args.fields as string[]) : undefined,
          idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        });
      },
    });
  }
  return tools;
}
