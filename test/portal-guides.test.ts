import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGuides, searchGuides } from '../src/guides.js';
import { assetPath } from '../src/paths.js';
import { startHarness, type Harness } from './helpers/harness.js';

const PORTAL_SLUGS = [
  'overview', 'create-your-account', 'verify-your-email', 'sign-in-and-security', 'the-console-tour', 'sandboxes', 'api-keys-and-tokens',
  'calling-the-api-from-curl-and-postman', 'webhooks', 'data-page-and-json-viewer', 'simulate', 'api-playground', 'request-log-and-debugging',
  'inbox-and-notifications', 'support-and-booking-a-call', 'go-to-production', 'profile-and-security', 'moving-from-legacy-apis-to-v2',
  'reading-the-api-reference', 'rate-limits-errors-and-idempotency', 'faq-and-troubleshooting',
].map((s) => `portal-${s}`);

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('developer portal guides', () => {
  it('lists all 21 portal guides after the 15 API guides, each with a description, and reads them', async () => {
    h = await startHarness();
    const { resources } = await h.client.listResources();
    const guides = resources.filter((r) => r.uri.startsWith('hb://guides/'));
    expect(guides).toHaveLength(36);
    expect(guides.slice(15).map((r) => r.uri)).toEqual(PORTAL_SLUGS.map((s) => `hb://guides/${s}`));
    for (const g of guides.slice(15)) {
      expect(g.description?.length ?? 0).toBeGreaterThan(30);
      const read = await h.client.readResource({ uri: g.uri });
      const text = (read.contents[0] as { text: string }).text;
      expect(text.length, g.uri).toBeGreaterThan(500);
      expect(text.startsWith('# ')).toBe(true);
    }
  });

  it('no custom tag, image or callout syntax remains in any guide', () => {
    for (const g of loadGuides()) {
      expect(g.text, g.slug).not.toMatch(/<Steps>|<\/Steps>|<Step[ >]|<Frame|<\/Frame>|shot:|^:::/m);
      if (g.group === 'portal') {
        expect(g.text, g.slug).not.toMatch(/!\[|^---$/m);
        expect(g.text, g.slug).not.toMatch(/\]\(\/[^)]*\)/);
      }
    }
    const files = readdirSync(assetPath('content/guides/portal'));
    expect(files).toHaveLength(21);
    for (const f of files) expect(readFileSync(assetPath('content/guides/portal', f), 'utf8')).not.toMatch(/<Steps>|<Frame|shot:|^:::/m);
  });

  it('states no sunset date for the legacy APIs', () => {
    const legacy = loadGuides().find((g) => g.slug === 'portal-moving-from-legacy-apis-to-v2')!;
    expect(legacy.text).not.toMatch(/31 December|sunset/i);
    expect(legacy.text).toContain('date is to be announced');
  });

  it('internal links point at existing guides', () => {
    const slugs = new Set(loadGuides().map((g) => g.slug));
    for (const g of loadGuides().filter((x) => x.group === 'portal')) {
      for (const m of g.text.matchAll(/\(hb:\/\/guides\/([\w-]+)\)/g)) expect(slugs.has(m[1] as string), `${g.slug} -> ${m[1]}`).toBe(true);
    }
  });

  it('has the get-started-in-sandbox prompt that references the portal guides', async () => {
    h = await startHarness();
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('get-started-in-sandbox');
    const text = ((await h.client.getPrompt({ name: 'get-started-in-sandbox' })).messages[0]!.content as { text: string }).text;
    for (const s of ['portal-create-your-account', 'portal-sandboxes', 'portal-api-keys-and-tokens', 'HB_BASE_URL', 'HB_API_KEY', '--doctor']) expect(text).toContain(s);
  });

  it('instructions, status and errors point to the portal guides', async () => {
    h = await startHarness();
    expect(h.client.getInstructions()).toContain('hb://guides/portal-overview');
    const h2 = await startHarness({ HB_API_KEY: '' }, h.hub);
    expect(h2.client.getInstructions()).toContain('hb://guides/portal-create-your-account');
    expect(h2.client.getInstructions()).toContain('hb://guides/portal-sandboxes');
    const r = await h2.call('hb_status');
    expect(r.json.getting_started).toContain('portal-sandboxes');
    const c = await h2.call('hb_call_operation', { operation_id: 'hub.candidates.list' });
    expect(c.text).toContain('portal-create-your-account');
    await h2.close();
  });

  it('hb_search_guides finds portal and API guides, read-only, and is in the tool list', async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const t = tools.find((x) => x.name === 'hb_search_guides')!;
    expect(t.annotations?.readOnlyHint).toBe(true);
    const r = await h.call('hb_search_guides', { query: 'rotate signing secret' });
    expect(r.isError).toBe(false);
    expect(r.json.guides.map((g: { uri: string }) => g.uri)).toContain('hb://guides/portal-webhooks');
    const p = await h.call('hb_search_guides', { query: 'sandbox', group: 'portal', limit: 3 });
    expect(p.json.guides.length).toBeLessThanOrEqual(3);
    expect(p.json.guides.every((g: { uri: string }) => g.uri.includes('portal-'))).toBe(true);
    expect(searchGuides('idempotency', { group: 'api' })[0]?.uri).toBe('hb://guides/idempotency');
    expect((await h.call('hb_search_guides', { query: '' })).isError).toBe(true);
  });
});
