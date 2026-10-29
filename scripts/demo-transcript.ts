/**
 * Runs the BUILT server (dist/cli.js) over stdio with a real MCP client against the in-process mock Hub.
 * Usage: npm run build && npx tsx scripts/demo-transcript.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MOCK_KEY, MockHub } from '../test/helpers/mock-hub.js';

const hub = await new MockHub().start();
const show = (title: string, value: unknown) => console.log(`\n=== ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function session(env: Record<string, string>, label: string, body: (c: Client) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/cli.js'],
    env: { PATH: process.env.PATH ?? '', HB_API_KEY: MOCK_KEY, HB_BASE_URL: hub.url, HB_ENV: 'sandbox', ...env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(transport);
  console.log(`\n##### ${label}`);
  await body(client);
  await client.close();
}

await session({}, 'compact mode, read-only (default)', async (c) => {
  const tools = await c.listTools();
  show('tools/list', tools.tools.map((t) => `${t.name}  [readOnlyHint=${t.annotations?.readOnlyHint}]`));
  show('hb_status', text(await c.callTool({ name: 'hb_status', arguments: {} })));
  show('hb_search_operations "book practical training"', JSON.parse(text(await c.callTool({ name: 'hb_search_operations', arguments: { query: 'book practical training', limit: 3 } }))).operations.map((o: { id: string; method: string; path: string; callable_now: boolean }) => `${o.id} ${o.method} ${o.path} callable_now=${o.callable_now}`));
  show('hb_call_operation hub.candidates.list (per_page=2, fields)', text(await c.callTool({ name: 'hb_call_operation', arguments: { operation_id: 'hub.candidates.list', query: { per_page: 2 }, fields: ['candidate_ref', 'name', 'compliance_status'] } })).slice(0, 900));
  show('hb_call_operation hub.candidates.create (refused, read-only)', text(await c.callTool({ name: 'hb_call_operation', arguments: { operation_id: 'hub.candidates.create', body: { first_name: 'A', last_name: 'B', email: 'a@b.co' } } })));
});

await session({ HB_ENV: 'live', HB_READ_ONLY: 'false', HB_ALLOW_LIVE_WRITES: 'true' }, 'LIVE writes enabled: plan first, then confirm', async (c) => {
  const args = { operation_id: 'hub.candidates.create', body: { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com' } };
  const plan = JSON.parse(text(await c.callTool({ name: 'hb_call_operation', arguments: args })));
  show('first call (nothing sent)', plan);
  const done = JSON.parse(text(await c.callTool({ name: 'hb_call_operation', arguments: { ...args, confirm: true, idempotency_key: plan.idempotency_key } })));
  show('second call with confirm=true', done.meta);
  console.log(`\nHub saw ${hub.apiRequests().length} API request(s) in this session.`);
});

await session({ HB_TOOL_MODE: 'full', HB_TOOLSETS: 'hub', HB_READ_ONLY: 'false' }, 'full mode, toolset hub, sandbox writes', async (c) => {
  const tools = await c.listTools();
  show('tools/list', tools.tools.map((t) => t.name));
});

await hub.stop();
