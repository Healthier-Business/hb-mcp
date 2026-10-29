import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { assetPath } from './paths.js';

export type GuideGroup = 'api' | 'portal';

export interface Guide {
  /** Resource name after `hb://guides/` (portal guides start with `portal-`). */
  slug: string;
  group: GuideGroup;
  title: string;
  description: string;
  text: string;
}

export interface GuideHit {
  uri: string;
  title: string;
  description: string;
  group: GuideGroup;
  score: number;
  snippet: string;
}

function titleOf(markdown: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() ?? fallback;
}

/** Split an optional `---` front matter block holding a one-line `description:`. */
function splitFrontMatter(raw: string): { description?: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) return { body: raw };
  const d = /^description:\s*(.+)$/m.exec(m[1] as string);
  return { description: d?.[1]?.trim(), body: raw.slice(m[0].length) };
}

function numberedFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^\d\d-.*\.md$/.test(n)).sort();
}

let cache: Guide[] | undefined;

/** The API guides (content/guides) first, then the developer portal guides (content/guides/portal), each in file order. */
export function loadGuides(): Guide[] {
  if (cache) return cache;
  const guides: Guide[] = [];
  for (const f of numberedFiles(assetPath('content/guides'))) {
    const slug = f.replace(/^\d+-/, '').replace(/\.md$/, '');
    const text = readFileSync(assetPath('content/guides', f), 'utf8');
    guides.push({ slug, group: 'api', title: `Guide: ${titleOf(text, slug)}`, description: `Hub API v2 developer guide (${slug}).`, text });
  }
  if (existsSync(assetPath('content/guides/portal'))) {
    for (const f of numberedFiles(assetPath('content/guides/portal'))) {
      const name = f.replace(/^\d+-/, '').replace(/\.md$/, '');
      const { description, body } = splitFrontMatter(readFileSync(assetPath('content/guides/portal', f), 'utf8'));
      guides.push({
        slug: `portal-${name}`,
        group: 'portal',
        title: `Developer portal: ${titleOf(body, name)}`,
        description: `Developer portal guide: ${description ?? name}`,
        text: body,
      });
    }
  }
  cache = guides;
  return guides;
}

function words(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_.:-]+/).filter((w) => w.length > 1);
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < 20; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** Plain keyword search over the bundled guides: every word counts, title and description weigh more than body text. */
export function searchGuides(query: string, opts: { group?: GuideGroup | 'all'; limit?: number } = {}): GuideHit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const hits: GuideHit[] = [];
  for (const g of loadGuides()) {
    if (opts.group && opts.group !== 'all' && g.group !== opts.group) continue;
    const title = g.title.toLowerCase();
    const slug = g.slug.toLowerCase();
    const description = g.description.toLowerCase();
    const body = g.text.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const inBody = countOf(body, t);
      const s = (title.includes(t) ? 10 : 0) + (slug.includes(t) ? 6 : 0) + (description.includes(t) ? 4 : 0) + inBody;
      if (s > 0) matched += 1;
      score += s;
    }
    if (matched === 0) continue;
    score += matched === terms.length ? 25 : 0;
    const first = terms.find((t) => body.includes(t));
    let snippet = '';
    if (first) {
      const line = g.text.split('\n').find((l) => l.toLowerCase().includes(first)) ?? '';
      snippet = line.replace(/\s+/g, ' ').trim().slice(0, 220);
    }
    hits.push({ uri: `hb://guides/${g.slug}`, title: g.title, description: g.description, group: g.group, score, snippet });
  }
  hits.sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri));
  return hits.slice(0, Math.min(Math.max(opts.limit ?? 5, 1), 20));
}
