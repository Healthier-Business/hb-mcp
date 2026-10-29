import { readFileSync } from 'node:fs';
import { assetPath } from './paths.js';
import type { Catalogue, CatalogueEvent, CatalogueOperation, EventCatalogue } from './generator/build.js';

export type { CatalogueEvent, CatalogueOperation } from './generator/build.js';

export class OperationCatalogue {
  readonly operations: CatalogueOperation[];
  readonly events: CatalogueEvent[];
  readonly specSha256: string;
  readonly specVersion: string;
  private byId = new Map<string, CatalogueOperation>();
  private byTool = new Map<string, CatalogueOperation>();
  private byEvent = new Map<string, CatalogueEvent>();

  constructor(catalogue: Catalogue, events: EventCatalogue) {
    this.operations = catalogue.operations;
    this.events = events.events;
    this.specSha256 = catalogue.specSha256;
    this.specVersion = catalogue.specVersion;
    for (const o of this.operations) {
      this.byId.set(o.id, o);
      this.byTool.set(o.toolName, o);
    }
    for (const e of this.events) {
      this.byEvent.set(e.type, e);
    }
  }

  static load(): OperationCatalogue {
    const cat = JSON.parse(readFileSync(assetPath('generated/catalogue.json'), 'utf8')) as Catalogue;
    const ev = JSON.parse(readFileSync(assetPath('generated/events.json'), 'utf8')) as EventCatalogue;
    return new OperationCatalogue(cat, ev);
  }

  get(id: string): CatalogueOperation | undefined {
    return this.byId.get(id) ?? this.byTool.get(id);
  }

  event(type: string): CatalogueEvent | undefined {
    return this.byEvent.get(type);
  }

  /** Closest operation ids for a mistyped id. */
  suggest(id: string, limit = 5): string[] {
    const needle = id.toLowerCase();
    const parts = needle.split(/[^a-z0-9]+/).filter(Boolean);
    return this.operations
      .map((o) => ({ id: o.id, score: parts.filter((p) => o.id.includes(p)).length }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((s) => s.id);
  }

  search(opts: { query?: string; toolset?: string; method?: string; scope?: string; writesOnly?: boolean; limit?: number }): CatalogueOperation[] {
    const terms = (opts.query ?? '').toLowerCase().split(/[^a-z0-9_.:-]+/).filter(Boolean);
    const scored: { op: CatalogueOperation; score: number }[] = [];
    for (const op of this.operations) {
      if (op.internal) {
        continue;
      }
      if (opts.toolset && op.toolset !== opts.toolset.toLowerCase()) {
        continue;
      }
      if (opts.method && op.method !== opts.method.toUpperCase()) {
        continue;
      }
      if (opts.scope && !(op.scope ?? '').includes(opts.scope.toLowerCase())) {
        continue;
      }
      if (opts.writesOnly && op.method === 'GET') {
        continue;
      }
      let score = 1;
      if (terms.length) {
        score = 0;
        const id = op.id.toLowerCase();
        const summary = op.summary.toLowerCase();
        const path = op.path.toLowerCase();
        const desc = op.description.toLowerCase();
        for (const t of terms) {
          if (id.includes(t)) score += 4;
          if (summary.includes(t)) score += 3;
          if (path.includes(t)) score += 2;
          if (desc.includes(t)) score += 1;
        }
        if (score === 0) {
          continue;
        }
      }
      scored.push({ op, score });
    }
    scored.sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id));
    return scored.slice(0, opts.limit ?? 20).map((s) => s.op);
  }
}
