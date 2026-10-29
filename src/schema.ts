import type { Json, JsonObject } from './generator/build.js';

export interface SchemaIssue {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(value: unknown, type: string): boolean {
  const t = typeOf(value);
  return t === type || (type === 'number' && t === 'integer');
}

/** A binary (file) field accepts {filename, content_base64 | content_text, content_type?}. */
export function isFileValue(v: unknown): boolean {
  return isObj(v) && typeof v.filename === 'string' && (typeof v.content_base64 === 'string' || typeof v.content_text === 'string');
}

/**
 * Small JSON-schema validator covering what the Hub spec uses: type, enum, const, string/number/array limits,
 * pattern, common formats, required, properties, items, oneOf/anyOf/allOf. Unknown properties are allowed
 * unless the schema says additionalProperties: false.
 */
export function validate(value: unknown, schema: Json, path = '$'): SchemaIssue[] {
  if (!isObj(schema)) {
    return [];
  }
  const issues: SchemaIssue[] = [];
  const push = (message: string) => issues.push({ path, message });

  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) issues.push(...validate(value, s, path));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    if (!schema.anyOf.some((s) => validate(value, s, path).length === 0)) {
      push('does not match any of the allowed shapes');
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const ok = schema.oneOf.filter((s) => validate(value, s, path).length === 0).length;
    if (ok === 0) push('does not match any of the allowed shapes');
  }

  const type = schema.type;
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? (type as string[]) : [];
  if (types.length) {
    const binary = schema.format === 'binary' && isFileValue(value);
    if (!binary && !types.some((t) => typeMatches(value, t))) {
      push(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return issues;
    }
  }
  if (value === null || value === undefined) {
    return issues;
  }
  if (schema.format === 'binary') {
    if (!isFileValue(value)) push('must be a file: {filename, content_base64 or content_text, content_type?}');
    return issues;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    push(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    push(`must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) push(`must match pattern ${schema.pattern}`);
      } catch {
        /* an unsupported pattern syntax is not the caller's fault */
      }
    }
    const fmt = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (fmt && !fmt.test(value)) push(`must be a valid ${String(schema.format)}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push(`must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) push(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) push(`needs at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) push(`allows at most ${schema.maxItems} items`);
    if (isObj(schema.items)) {
      value.forEach((item, i) => issues.push(...validate(item, schema.items as Json, `${path}[${i}]`)));
    }
  }
  if (isObj(value) && !(schema.format === 'binary')) {
    const props = isObj(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (typeof r === 'string' && (value[r] === undefined)) {
          issues.push({ path: `${path}.${r}`, message: 'is required' });
        }
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k] !== undefined) {
        issues.push(...validate(v, props[k] as Json, `${path}.${k}`));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${k}`, message: 'is not an allowed property' });
      }
    }
  }
  return issues;
}

export function formatIssues(issues: SchemaIssue[]): string[] {
  return issues.slice(0, 25).map((i) => `${i.path} ${i.message}`);
}

/** Make a schema cheap to put in a tool list: no examples, shortened descriptions, no titles. */
export function slimSchema(node: Json, maxDescription = 140): Json {
  if (Array.isArray(node)) {
    return node.map((n) => slimSchema(n, maxDescription));
  }
  if (!isObj(node)) {
    return node;
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'examples' || k === 'example' || k === 'title' || k === 'contentMediaType' || k === 'default') {
      continue;
    }
    if (k === 'description' && typeof v === 'string') {
      const flat = v.replace(/\s+/g, ' ').trim();
      out[k] = flat.length > maxDescription ? flat.slice(0, maxDescription - 1) + '…' : flat;
      continue;
    }
    if (k === 'properties' && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, slimSchema(pv, maxDescription)]));
      continue;
    }
    out[k] = slimSchema(v, maxDescription);
  }
  // Binary fields are sent as a file object.
  if (out.format === 'binary') {
    return {
      type: 'object',
      description: 'A file: {filename, content_base64 or content_text, content_type?}',
      properties: { filename: { type: 'string' }, content_base64: { type: 'string' }, content_text: { type: 'string' }, content_type: { type: 'string' } },
      required: ['filename'],
    };
  }
  return out;
}
