import { describe, expect, it } from 'vitest';
import { capOutput, selectFields } from '../src/output.js';
import { Redactor } from '../src/redact.js';
import { slimSchema, validate } from '../src/schema.js';
import { buildQuery } from '../src/http.js';

describe('schema validator', () => {
  const schema = {
    type: 'object',
    required: ['email', 'first_name'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 20 },
      first_name: { type: 'string' },
      roles: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 2 },
      status: { enum: ['a', 'b'] },
      n: { type: 'integer', minimum: 1, maximum: 5 },
    },
  } as const;

  it('accepts a valid body', () => {
    expect(validate({ email: 'a@b.co', first_name: 'A', roles: null, n: 3 }, schema)).toEqual([]);
  });
  it('reports required, type, format, enum, range and length problems', () => {
    const msgs = validate({ email: 'nope', roles: ['a', 'b', 'c'], status: 'z', n: 9 }, schema).map((i) => `${i.path} ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        '$.first_name is required',
        '$.email must be a valid email',
        '$.roles allows at most 2 items',
        expect.stringContaining('$.status must be one of'),
        '$.n must be at most 5',
      ]),
    );
    expect(validate({ email: 5, first_name: 'x' }, schema)[0]?.message).toMatch(/must be string/);
  });
  it('handles oneOf and binary file fields', () => {
    const s = { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] };
    expect(validate({ file: { filename: 'a.csv', content_text: 'a,b' } }, s)).toEqual([]);
    expect(validate({ file: 'plain' }, s).length).toBeGreaterThan(0);
    expect(validate(1, { oneOf: [{ type: 'string' }, { type: 'object' }] }).length).toBe(1);
  });
  it('slims schemas for tool lists', () => {
    const slim = slimSchema({ type: 'object', description: 'x'.repeat(500), examples: [1], properties: { a: { type: 'string', example: 'z' } } }) as any;
    expect(slim.description.length).toBeLessThanOrEqual(140);
    expect(slim.examples).toBeUndefined();
    expect(slim.properties.a.example).toBeUndefined();
  });
});

describe('output helpers', () => {
  const rows = [
    { id: 1, name: 'A', candidate: { ref: 'r1', email: 'a@x' } },
    { id: 2, name: 'B', candidate: { ref: 'r2', email: 'b@x' } },
  ];
  it('selects dotted fields from each record in data', () => {
    expect(selectFields({ data: rows, meta: { page: 1 } }, ['id', 'candidate.ref'])).toEqual({
      data: [{ id: 1, candidate: { ref: 'r1' } }, { id: 2, candidate: { ref: 'r2' } }],
      meta: { page: 1 },
    });
    expect(selectFields({ data: { id: 5, x: 1 } }, ['id'])).toEqual({ data: { id: 5 } });
    expect(selectFields({ data: rows }, undefined)).toEqual({ data: rows });
  });
  it('caps by shrinking data first and always says so', () => {
    const big = { data: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'x'.repeat(50) })) };
    const r = capOutput({ status: 200 }, big, 3000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(3200);
    expect(r.text).toContain('Showing');
    expect(JSON.parse(r.text).body.data.length).toBeLessThan(200);
  });
  it('cuts text with a notice when it is not a list', () => {
    const r = capOutput({}, { blob: 'y'.repeat(5000) }, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('truncated at 1000 characters');
  });
  it('does not touch small answers', () => {
    expect(capOutput({}, { a: 1 }, 1000).truncated).toBe(false);
  });
});

describe('redactor', () => {
  it('scrubs registered secrets, hbk_ keys and bearer tokens', () => {
    const r = new Redactor();
    r.add('tok_super_secret_value_123');
    const out = r.redact('a tok_super_secret_value_123 b hbk_live_abcdef123456 c Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('tok_super');
    expect(out).not.toContain('hbk_live');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(r.redactJson({ x: ['tok_super_secret_value_123'] })).toEqual({ x: ['[redacted]'] });
  });
});

describe('query building', () => {
  it('encodes arrays, booleans and skips empties', () => {
    expect(buildQuery({ a: 1, b: true, c: ['x', 'y'], d: undefined, e: null, f: 'a b' })).toBe('?a=1&b=true&c%5B%5D=x&c%5B%5D=y&f=a%20b');
    expect(buildQuery({})).toBe('');
  });
});
