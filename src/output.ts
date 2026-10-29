import { redactor } from './redact.js';

/** jq-like select: dotted paths applied to each item of `data` (or to the root). `a.b` follows arrays automatically. */
export function selectFields(value: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0) {
    return value;
  }
  const pick = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(pick);
    }
    if (v === null || typeof v !== 'object') {
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      setPath(out, f.split('.'), getPath(v, f.split('.')));
    }
    return out;
  };
  if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
    return { ...(value as Record<string, unknown>), data: pick((value as { data: unknown }).data) };
  }
  return pick(value);
}

function getPath(v: unknown, segs: string[]): unknown {
  if (segs.length === 0) return v;
  if (Array.isArray(v)) return v.map((x) => getPath(x, segs));
  if (v && typeof v === 'object') {
    const [head, ...rest] = segs as [string, ...string[]];
    return getPath((v as Record<string, unknown>)[head], rest);
  }
  return undefined;
}

function setPath(target: Record<string, unknown>, segs: string[], value: unknown): void {
  if (value === undefined) return;
  const [head, ...rest] = segs as [string, ...string[]];
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  if (Array.isArray(value)) {
    const existing = Array.isArray(target[head]) ? (target[head] as Record<string, unknown>[]) : [];
    target[head] = value.map((v, i) => {
      const o = existing[i] ?? {};
      setPath(o, rest, v);
      return o;
    });
    return;
  }
  const child = (target[head] && typeof target[head] === 'object' ? target[head] : {}) as Record<string, unknown>;
  target[head] = child;
  setPath(child, rest, value);
}

export interface CapResult {
  text: string;
  truncated: boolean;
  note?: string;
}

/** Serialise `{meta, body}` within `maxChars`; shrink `body.data` arrays first, then cut text with a notice. */
export function capOutput(meta: Record<string, unknown>, body: unknown, maxChars: number): CapResult {
  const render = (b: unknown, m: Record<string, unknown>) => redactor.redact(JSON.stringify({ meta: m, body: b }, null, 1));
  let text = render(body, meta);
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as { data?: unknown }).data)) {
    const b = body as { data: unknown[] };
    const total = b.data.length;
    let keep = total;
    while (keep > 1) {
      keep = Math.floor(keep / 2);
      const shrunk = { ...b, data: b.data.slice(0, keep) };
      const m = { ...meta, truncated: true, truncation: `Showing ${keep} of ${total} items on this page because the answer exceeded ${maxChars} characters. Use the \`fields\` argument to select only what you need, or a smaller per_page / narrower filters.` };
      text = render(shrunk, m);
      if (text.length <= maxChars) {
        return { text, truncated: true, note: String(m.truncation) };
      }
    }
  }
  const notice = `\n…[truncated at ${maxChars} characters. Use \`fields\` to select only what you need, or narrow the request.]`;
  return { text: text.slice(0, maxChars) + notice, truncated: true, note: notice.trim() };
}
