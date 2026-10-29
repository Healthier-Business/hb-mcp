import { randomUUID } from 'node:crypto';
import type { CatalogueOperation, OperationCatalogue } from './catalogue.js';
import type { Config } from './config.js';
import { HubApiError, HubNetworkError, ToolInputError, describeError } from './errors.js';
import type { HubClient, HubRequest, HubResponse } from './http.js';
import { capOutput, selectFields } from './output.js';
import { redactor } from './redact.js';
import { formatIssues, validate } from './schema.js';
import { buildPlan, gate, isWrite } from './safety.js';
import { textResult, type ToolResult } from './tools/types.js';

export interface CallArgs {
  path_params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, unknown>;
  confirm?: boolean;
  all_pages?: boolean;
  max_pages?: number;
  fields?: string[];
  idempotency_key?: string;
  /** In-process only (never a tool argument): receives the parsed answer before redaction, so a task tool can hold a one-time secret safely. */
  onResponse?: (json: unknown) => void;
}

/** Models often send "55" for an integer or "true" for a boolean; accept the unambiguous cases. */
function coerce(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes('string')) {
    if ((types.includes('integer') || types.includes('number')) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (types.includes('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  }
  return value;
}

const DEFAULT_MAX_PAGES = 5;
const HARD_MAX_PAGES = 20;
const HEALTH_NOTE = 'Contains health data (special category). Use only what the task needs; do not copy it into other systems, tickets or logs.';

/** The one pipeline every operation call goes through, in compact and full mode alike. */
export class Executor {
  constructor(
    private readonly config: Config,
    readonly catalogue: OperationCatalogue,
    private readonly client: HubClient,
  ) {}

  async call(operationId: string, args: CallArgs): Promise<ToolResult> {
    const op = this.catalogue.get(operationId);
    if (!op) {
      const near = this.catalogue.suggest(operationId);
      return textResult(
        `Unknown operation "${operationId}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Use hb_search_operations to find an operation id.`,
        true,
      );
    }
    try {
      return await this.run(op, args);
    } catch (e) {
      let text = describeError(e);
      if (e instanceof HubNetworkError && isWrite(op) && this.lastKey) {
        text += `\nidempotency_key used: ${this.lastKey}`;
      }
      if (e instanceof HubApiError && e.status >= 500 && isWrite(op) && this.lastKey) {
        text += `\nidempotency_key used: ${this.lastKey}`;
      }
      return textResult(text, true);
    }
  }

  private lastKey: string | undefined;

  private buildRequest(op: CatalogueOperation, args: CallArgs): { req: HubRequest; body: unknown; idempotencyKey: string | undefined } {
    const issues: string[] = [];

    const pathParams = args.path_params ?? {};
    let path = op.path;
    for (const p of op.parameters.filter((x) => x.in === 'path')) {
      const v = coerce(pathParams[p.name], p.schema);
      if (v === undefined || v === null || v === '') {
        issues.push(`path_params.${p.name} is required`);
        continue;
      }
      issues.push(...formatIssues(validate(v, p.schema, `path_params.${p.name}`)));
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    }
    for (const k of Object.keys(pathParams)) {
      if (!op.parameters.some((x) => x.in === 'path' && x.name === k)) {
        issues.push(`path_params.${k} is not a path parameter of ${op.id}`);
      }
    }

    const query: Record<string, unknown> = { ...(args.query ?? {}) };
    const queryDefs = op.parameters.filter((x) => x.in === 'query');
    for (const [k, raw] of Object.entries(query)) {
      const def = queryDefs.find((q) => q.name === k);
      const v = def ? coerce(raw, def.schema) : raw;
      if (def) query[k] = v;
      if (!def) {
        issues.push(`query.${k} is not a query parameter of ${op.id} (valid: ${queryDefs.map((q) => q.name).join(', ') || 'none'})`);
        continue;
      }
      issues.push(...formatIssues(validate(v, def.schema, `query.${k}`)));
    }
    for (const q of queryDefs.filter((x) => x.required)) {
      if (query[q.name] === undefined) issues.push(`query.${q.name} is required`);
    }

    const headerDefs = op.parameters.filter((x) => x.in === 'header');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.headers ?? {})) {
      const def = headerDefs.find((h) => h.name.toLowerCase() === k.toLowerCase());
      if (!def) {
        issues.push(`headers.${k} is not a header this operation accepts (valid: ${headerDefs.map((h) => h.name).join(', ') || 'none'})`);
        continue;
      }
      headers[def.name] = String(v);
    }

    let idempotencyKey: string | undefined;
    if (op.hasIdempotencyKey) {
      idempotencyKey = args.idempotency_key ?? headers['Idempotency-Key'] ?? randomUUID();
      if (idempotencyKey.length > 255) issues.push('idempotency_key must be at most 255 characters');
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const bodyDef = op.body;
    let multipart = false;
    if (bodyDef) {
      if (args.body === undefined || args.body === null) {
        if (bodyDef.required) issues.push('body is required');
      } else {
        issues.push(...formatIssues(validate(args.body, bodyDef.schema, 'body')));
        multipart = !bodyDef.contentTypes.includes('application/json') || (bodyDef.contentTypes.includes('multipart/form-data') && JSON.stringify(args.body).includes('"filename"'));
      }
    } else if (args.body !== undefined) {
      issues.push(`${op.id} takes no body`);
    }

    if (issues.length) {
      throw new ToolInputError(`The call to ${op.id} was not sent: it does not match the Hub spec. Use hb_describe_operation to see the exact shape.`, issues);
    }

    const req: HubRequest = {
      method: op.method,
      path,
      pathTemplate: op.path,
      query: Object.keys(query).length ? query : undefined,
      headers,
      retryable: op.method === 'GET',
    };
    if (args.body !== undefined && args.body !== null) {
      if (multipart) req.multipart = args.body as Record<string, unknown>;
      else req.json = args.body;
    }
    return { req, body: args.body, idempotencyKey };
  }

  private async run(op: CatalogueOperation, args: CallArgs): Promise<ToolResult> {
    const { needsConfirm } = gate(this.config, op);
    const { req, body, idempotencyKey } = this.buildRequest(op, args);
    this.lastKey = idempotencyKey;

    if (needsConfirm && args.confirm !== true) {
      const plan = buildPlan(op, `${req.path}`, body, idempotencyKey);
      return textResult(redactor.redact(JSON.stringify(plan, null, 1)));
    }

    const wantPages = args.all_pages === true && op.paginated && op.method === 'GET';
    const maxPages = Math.min(Math.max(1, args.max_pages ?? DEFAULT_MAX_PAGES), HARD_MAX_PAGES);

    let res: HubResponse;
    let pagination: Record<string, unknown> | undefined;
    let merged: unknown;

    if (wantPages) {
      const pages: HubResponse[] = [];
      let page = Number(args.query?.page ?? 1);
      let stopped = 'last_page';
      for (let i = 0; i < maxPages; i++) {
        const r = await this.client.send({ ...req, query: { ...req.query, page } });
        pages.push(r);
        const meta = (r.json as { meta?: { last_page?: number } } | null)?.meta;
        if (!meta?.last_page || page >= meta.last_page) {
          break;
        }
        page += 1;
        if (i === maxPages - 1) stopped = 'max_pages_reached';
      }
      res = pages[pages.length - 1] as HubResponse;
      const last = res.json as { data?: unknown[]; meta?: Record<string, unknown>; links?: unknown } | null;
      merged = {
        ...(last ?? {}),
        data: pages.flatMap((p) => ((p.json as { data?: unknown[] } | null)?.data ?? [])),
      };
      pagination = {
        pages_fetched: pages.length,
        stopped_because: stopped,
        note: stopped === 'max_pages_reached' ? `More pages exist. Raise max_pages (up to ${HARD_MAX_PAGES}), add filters, or continue from page ${page + 1}.` : undefined,
      };
    } else {
      res = await this.client.send(req);
      merged = res.json;
    }

    args.onResponse?.(merged);
    return this.format(op, res, merged, pagination, idempotencyKey, args);
  }

  private format(op: CatalogueOperation, res: HubResponse, json: unknown, pagination: Record<string, unknown> | undefined, idempotencyKey: string | undefined, args: CallArgs): ToolResult {
    const meta: Record<string, unknown> = {
      environment: this.config.mode,
      operation: op.id,
      status: res.status,
      request_id: res.requestId,
      rate_limit: res.rateLimit.limit !== undefined ? { limit: res.rateLimit.limit, remaining: res.rateLimit.remaining, reset_epoch: res.rateLimit.reset } : undefined,
      idempotency_key: idempotencyKey,
      idempotent_replayed: res.replayed || undefined,
      pagination,
      health_data: op.healthData ? HEALTH_NOTE : undefined,
    };

    let body: unknown;
    if (res.bytes) {
      const b64 = Buffer.from(res.bytes).toString('base64');
      const inline = b64.length <= this.config.maxResponseChars / 2;
      body = {
        content_type: res.contentType,
        size_bytes: res.bytes.byteLength,
        content_base64: inline ? b64 : undefined,
        note: inline ? 'File returned as base64.' : 'File is too large to return inline; download it with the Hub directly (curl) or raise HB_MAX_RESPONSE_CHARS.',
      };
    } else if (res.text !== undefined) {
      body = { content_type: res.contentType, text: res.text };
    } else {
      body = selectFields(json, args.fields);
    }

    const capped = capOutput(meta, body, this.config.maxResponseChars);
    return textResult(capped.text);
  }
}
