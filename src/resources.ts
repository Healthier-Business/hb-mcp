import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { assetPath } from './paths.js';
import type { AppContext } from './context.js';
import { describeOperation } from './tools/compact.js';
import { redactor } from './redact.js';

export interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

function guideSlug(file: string): string {
  return file.replace(/^\d+-/, '').replace(/\.md$/, '');
}

function titleOf(markdown: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() ?? fallback;
}

export class ResourceRegistry {
  private guides = new Map<string, string>();
  private portals = new Map<string, string>();

  constructor(private readonly ctx: AppContext) {
    for (const f of readdirSync(assetPath('content/guides')).filter((n) => /^\d\d-.*\.md$/.test(n)).sort()) {
      this.guides.set(guideSlug(f), readFileSync(assetPath('content/guides', f), 'utf8'));
    }
    if (existsSync(assetPath('content/portals'))) {
      for (const f of readdirSync(assetPath('content/portals')).filter((n) => n.endsWith('.md'))) {
        this.portals.set(f.replace(/\.md$/, ''), readFileSync(assetPath('content/portals', f), 'utf8'));
      }
    }
  }

  list(): ResourceEntry[] {
    const out: ResourceEntry[] = [
      { uri: 'hb://spec/overview', name: 'overview', title: 'Hub API v2 overview', description: 'Counts, toolsets and an index of every operation.', mimeType: 'text/markdown' },
    ];
    for (const [slug, text] of this.guides) {
      out.push({ uri: `hb://guides/${slug}`, name: `guide-${slug}`, title: `Guide: ${titleOf(text, slug)}`, description: `Hub API v2 developer guide (${slug}).`, mimeType: 'text/markdown' });
    }
    for (const toolset of this.toolsets()) {
      out.push({ uri: `hb://portals/${toolset}`, name: `portal-${toolset}`, title: `Portal: ${toolset}`, description: `What the ${toolset} portal API does and its operations.`, mimeType: 'text/markdown' });
    }
    return out;
  }

  templates(): ResourceTemplate[] {
    return [
      { uriTemplate: 'hb://spec/operations/{id}', name: 'operation', title: 'Operation detail', description: 'Full spec detail of one operation (e.g. hub.candidates.list).', mimeType: 'application/json' },
      { uriTemplate: 'hb://spec/events/{type}', name: 'event', title: 'Webhook event', description: 'Payload schema and example of one webhook event.', mimeType: 'application/json' },
    ];
  }

  private toolsets(): string[] {
    return [...new Set(this.ctx.catalogue.operations.map((o) => o.toolset))].sort();
  }

  private portalIndex(toolset: string): string {
    const ops = this.ctx.catalogue.operations.filter((o) => o.toolset === toolset);
    const rows = ops.map((o) => `| \`${o.id}\` | ${o.method} | \`${o.path}\` | ${o.scope ?? 'none'} | ${o.summary} |`);
    return ['## Operations', '', '| Operation | Method | Path | Scope | Summary |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
  }

  read(uri: string): { mimeType: string; text: string } | undefined {
    const guide = /^hb:\/\/guides\/([\w-]+)$/.exec(uri);
    if (guide) {
      const t = this.guides.get(guide[1] as string);
      return t === undefined ? undefined : { mimeType: 'text/markdown', text: t };
    }
    const portal = /^hb:\/\/portals\/([\w-]+)$/.exec(uri);
    if (portal) {
      const slug = portal[1] as string;
      if (!this.toolsets().includes(slug)) return undefined;
      const doc = this.portals.get(slug);
      const head = doc ?? `# ${slug}\n\nOperations of the ${slug} toolset.\n`;
      return { mimeType: 'text/markdown', text: `${head}\n\n${this.portalIndex(slug)}\n` };
    }
    if (uri === 'hb://spec/overview') {
      const c = this.ctx.catalogue;
      const lines = [
        `# Hub API v2`,
        '',
        `Spec version ${c.specVersion}: ${c.operations.length} operations, ${c.events.length} webhook events. Environment: ${this.ctx.config.mode}.`,
        '',
        '| Operation | Method | Path | Scope |',
        '| --- | --- | --- | --- |',
        ...c.operations.map((o) => `| \`${o.id}\` | ${o.method} | \`${o.path}\` | ${o.scope ?? 'none'} |`),
      ];
      return { mimeType: 'text/markdown', text: lines.join('\n') };
    }
    const op = /^hb:\/\/spec\/operations\/(.+)$/.exec(uri);
    if (op) {
      const found = this.ctx.catalogue.get(decodeURIComponent(op[1] as string));
      return found ? { mimeType: 'application/json', text: redactor.redact(JSON.stringify(describeOperation(this.ctx, found), null, 1)) } : undefined;
    }
    const ev = /^hb:\/\/spec\/events\/(.+)$/.exec(uri);
    if (ev) {
      const found = this.ctx.catalogue.event(decodeURIComponent(ev[1] as string));
      return found ? { mimeType: 'application/json', text: JSON.stringify(found, null, 1) } : undefined;
    }
    return undefined;
  }
}
