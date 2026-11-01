/**
 * Pure builder: Hub OpenAPI document -> operation catalogue and webhook event catalogue.
 * Used by scripts/generate.ts and by the drift test, so the committed output can never disagree with the spec.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface CatalogueParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description: string;
  schema: JsonObject;
}

export interface CatalogueOperation {
  id: string;
  toolName: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description: string;
  tag: string;
  toolset: string;
  scope: string | null;
  credits: { description: string; blocksWhenBalanceShort: boolean } | null;
  healthData: boolean;
  parameters: CatalogueParameter[];
  body: {
    required: boolean;
    contentTypes: string[];
    schema: JsonObject;
    example: Json | null;
  } | null;
  success: { status: number; contentTypes: string[] };
  errors: { status: number; codes: string[] }[];
  hasIdempotencyKey: boolean;
  paginated: boolean;
  internal: boolean;
  destructive: boolean;
}

export interface CatalogueEvent {
  type: string;
  portal: string;
  summary: string;
  description: string;
  dataSchema: JsonObject;
  example: Json | null;
}

export interface Catalogue {
  specSha256: string;
  specVersion: string;
  operationCount: number;
  operations: CatalogueOperation[];
}

export interface EventCatalogue {
  specSha256: string;
  eventCount: number;
  events: CatalogueEvent[];
}

export const TAG_TOOLSETS: Record<string, string> = {
  Authentication: 'authentication',
  Account: 'account',
  'Hub (core)': 'hub',
  'Practical Training': 'practical-training',
  'Registration Monitoring': 'registration-monitoring',
  'DBS & Right To Work': 'dbs-rtw',
  'Online Training': 'online-training',
  'Occupational Health': 'occupational-health',
  References: 'references',
  'Virtual BLS Training': 'virtual-bls-training',
  'Clinical Interviews': 'clinical-interviews',
  'Clinical Appraisals': 'clinical-appraisals',
  'Training Verification': 'training-verification',
};

/** Operations the server handles itself; they carry credentials and are never exposed as tools. */
export const INTERNAL_OPERATIONS = new Set(['auth.token.create', 'auth.refresh.create', 'auth.revoke.create']);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const DESTRUCTIVE_ID = /(cancel|delete|revoke|remove|rotate-secret|reset|withdraw|disable|archive|release)/;

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, JsonObject>>;
  webhooks: Record<string, Record<string, JsonObject>>;
  components: { schemas: Record<string, JsonObject>; parameters: Record<string, JsonObject>; responses: Record<string, JsonObject> };
};

function isObj(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resolveRef(spec: Spec, ref: string): JsonObject {
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = spec;
  for (const p of parts) {
    cur = (cur as Record<string, unknown>)[p];
  }
  if (!isObj(cur)) {
    throw new Error(`Unresolvable $ref ${ref}`);
  }
  return cur;
}

/** Inline every $ref (cycle-safe) and drop the keys the model does not need. */
export function dereference(spec: Spec, node: Json, stack: string[] = []): Json {
  if (Array.isArray(node)) {
    return node.map((n) => dereference(spec, n, stack));
  }
  if (!isObj(node)) {
    return node;
  }
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (stack.includes(ref)) {
      return { type: 'object', description: '(recursive structure; see the same schema above)' };
    }
    return dereference(spec, resolveRef(spec, ref), [...stack, ref]);
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('x-') || k === 'xml' || k === 'externalDocs') {
      continue;
    }
    out[k] = dereference(spec, v, stack);
  }
  return out;
}

function unrefParameter(spec: Spec, p: JsonObject): JsonObject {
  return typeof p.$ref === 'string' ? resolveRef(spec, p.$ref) : p;
}

function extractCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
    const code = m[1];
    if (code && code !== 'request_id' && (code.includes('_') || code === 'unauthenticated' || code === 'conflict')) {
      codes.add(code);
    }
  }
  return [...codes];
}

export function toolNameFor(operationId: string): string {
  return operationId.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

function buildOperation(spec: Spec, path: string, method: (typeof METHODS)[number], op: JsonObject): CatalogueOperation {
  const id = String(op.operationId);
  const tag = String((op.tags as string[])[0]);
  const toolset = TAG_TOOLSETS[tag];
  if (!toolset) {
    throw new Error(`Spec tag "${tag}" has no toolset mapping; add it to TAG_TOOLSETS`);
  }

  const parameters: CatalogueParameter[] = ((op.parameters as JsonObject[]) ?? []).map((raw) => {
    const p = unrefParameter(spec, raw);
    return {
      name: String(p.name),
      in: p.in as CatalogueParameter['in'],
      required: p.required === true || p.in === 'path',
      description: String(p.description ?? ''),
      schema: (dereference(spec, (p.schema as Json) ?? { type: 'string' }) as JsonObject),
    };
  });

  let body: CatalogueOperation['body'] = null;
  if (isObj(op.requestBody)) {
    const rb = op.requestBody;
    const content = rb.content as Record<string, JsonObject>;
    const contentTypes = Object.keys(content);
    const preferred = content['application/json'] ?? content[contentTypes[0] as string];
    body = {
      required: rb.required === true,
      contentTypes,
      schema: dereference(spec, (preferred?.schema as Json) ?? { type: 'object' }) as JsonObject,
      example: preferred && 'example' in preferred ? (dereference(spec, preferred.example as Json) as Json) : null,
    };
  }

  const responses = op.responses as Record<string, JsonObject>;
  // When an operation answers both 200 (already exists) and 201 (created), describe the creating answer.
  const successKeys = Object.keys(responses).filter((k) => k.startsWith('2'));
  const successKey = successKeys.find((k) => k === '201') ?? successKeys[0] ?? '200';
  const successResponse = responses[successKey] ?? {};
  const success = {
    status: Number(successKey),
    contentTypes: Object.keys((successResponse.content as JsonObject) ?? {}),
  };

  const errors: { status: number; codes: string[] }[] = [];
  for (const [status, raw] of Object.entries(responses)) {
    if (status.startsWith('2')) {
      continue;
    }
    const resolved = typeof raw.$ref === 'string' ? resolveRef(spec, raw.$ref) : raw;
    errors.push({ status: Number(status), codes: extractCodes(String(resolved.description ?? '')) });
  }

  const credits = isObj(op['x-credits'])
    ? {
        description: String((op['x-credits'] as JsonObject).description ?? ''),
        blocksWhenBalanceShort: (op['x-credits'] as JsonObject).blocks_when_balance_short === true,
      }
    : null;

  const names = new Set(parameters.map((p) => p.name));

  return {
    id,
    toolName: toolNameFor(id),
    method: method.toUpperCase() as CatalogueOperation['method'],
    path,
    summary: String(op.summary ?? id),
    description: String(op.description ?? ''),
    tag,
    toolset,
    scope: typeof op['x-required-scope'] === 'string' ? op['x-required-scope'] : null,
    credits,
    healthData: op['x-health-data'] === true,
    parameters,
    body,
    success,
    errors,
    hasIdempotencyKey: names.has('Idempotency-Key'),
    paginated: names.has('page') && names.has('per_page'),
    internal: INTERNAL_OPERATIONS.has(id),
    destructive: method === 'delete' || DESTRUCTIVE_ID.test(id),
  };
}

export function buildCatalogue(spec: Spec, specSha256: string): Catalogue {
  const operations: CatalogueOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op) {
        operations.push(buildOperation(spec, path, method, op));
      }
    }
  }
  operations.sort((a, b) => a.id.localeCompare(b.id));
  const names = new Set<string>();
  for (const o of operations) {
    if (names.has(o.toolName)) {
      throw new Error(`Tool name collision: ${o.toolName}`);
    }
    names.add(o.toolName);
    if (o.toolName.length > 64) {
      throw new Error(`Tool name too long: ${o.toolName}`);
    }
  }
  return { specSha256, specVersion: spec.info.version, operationCount: operations.length, operations };
}

export function buildEvents(spec: Spec, specSha256: string): EventCatalogue {
  const events: CatalogueEvent[] = [];
  for (const [type, item] of Object.entries(spec.webhooks)) {
    const op = item.post;
    if (!op) {
      continue;
    }
    const rb = op.requestBody as JsonObject;
    const media = (rb.content as Record<string, JsonObject>)['application/json'] as JsonObject;
    const allOf = ((media.schema as JsonObject).allOf as JsonObject[]) ?? [];
    const dataProp = allOf
      .map((s) => ((s.properties as JsonObject | undefined)?.data as Json | undefined))
      .find((d) => d !== undefined);
    events.push({
      type,
      portal: type.split('.')[0] as string,
      summary: String(op.summary ?? type),
      description: String(op.description ?? ''),
      dataSchema: (dataProp ? dereference(spec, dataProp) : { type: 'object' }) as JsonObject,
      example: media.example !== undefined ? (media.example as Json) : null,
    });
  }
  events.sort((a, b) => a.type.localeCompare(b.type));
  return { specSha256, eventCount: events.length, events };
}
