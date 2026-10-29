import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { createContext, createMcpServer } from '../../src/server.js';
import { redactor } from '../../src/redact.js';
import { setLogLevel, setLogSink } from '../../src/log.js';
import { MOCK_KEY, MockHub } from './mock-hub.js';

export interface Harness {
  hub: MockHub;
  ctx: AppContext;
  client: Client;
  config: Config;
  logs: string[];
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; json: any; parts: string[]; data: any }>;
  close: () => Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}, hub?: MockHub): Promise<Harness> {
  const mock = hub ?? (await new MockHub().start());
  const config = loadConfig({ HB_API_KEY: MOCK_KEY, HB_BASE_URL: mock.url, HB_ENV: 'sandbox', ...env } as NodeJS.ProcessEnv);
  const logs: string[] = [];
  setLogSink((l) => logs.push(l));
  setLogLevel('debug');
  const ctx = createContext(config, { sleep: async () => {} });
  const server = createMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    hub: mock,
    ctx,
    client,
    config,
    logs,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const parts = (r.content as { type: string; text: string }[]).map((c) => c.text);
      const text = parts.join('\n');
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      let data: any;
      try { data = parts.length > 1 ? JSON.parse(parts[parts.length - 1] as string) : undefined; } catch { data = undefined; }
      return { text, isError: r.isError === true, json, parts, data };
    },
    async close() {
      await client.close();
      if (!hub) await mock.stop();
      redactor.forget(MOCK_KEY);
    },
  };
}
