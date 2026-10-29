import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OperationCatalogue } from './catalogue.js';
import type { Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION, type AppContext } from './context.js';
import { describeError } from './errors.js';
import { Executor } from './execute.js';
import { HubClient } from './http.js';
import { buildInstructions } from './instructions.js';
import { log } from './log.js';
import { buildPrompts } from './prompts.js';
import { redactor } from './redact.js';
import { ResourceRegistry } from './resources.js';
import { TokenManager } from './tokens.js';
import { buildCompactTools } from './tools/compact.js';
import { buildFullTools } from './tools/full.js';
import { buildTaskTools } from './tools/tasks.js';
import { textResult, type ToolDefinition } from './tools/types.js';

export interface ContextOverrides {
  catalogue?: OperationCatalogue;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  const catalogue = overrides.catalogue ?? OperationCatalogue.load();
  redactor.add(config.apiKey);
  redactor.add(config.webhookSecret);
  const tokens = new TokenManager({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, fetchImpl: overrides.fetchImpl });
  const client = new HubClient({ baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, tokens, fetchImpl: overrides.fetchImpl, sleep: overrides.sleep });
  const executor = new Executor(config, catalogue, client);
  return { config, catalogue, tokens, client, executor, sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
}

export function buildTools(ctx: AppContext): ToolDefinition[] {
  const generic = ctx.config.toolMode === 'full' ? buildFullTools(ctx) : buildCompactTools(ctx);
  return [...generic, ...buildTaskTools(ctx)];
}

/** One MCP server instance (one per transport session) over the shared app context. */
export function createMcpServer(ctx: AppContext): Server {
  const tools = buildTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const resources = new ResourceRegistry(ctx);
  const prompts = buildPrompts(ctx);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      instructions: buildInstructions(ctx.config, ctx.catalogue.operations.length, ctx.catalogue.events.length),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' }, annotations: t.annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return textResult(`Unknown tool "${req.params.name}". ${ctx.config.toolMode === 'compact' ? 'Use hb_search_operations to find Hub operations.' : ''}`.trim(), true);
    }
    const started = Date.now();
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      log.info(`tool ${tool.name}`, { ms: Date.now() - started, error: result.isError === true });
      return { ...result, content: result.content.map((c) => ({ ...c, text: redactor.redact(c.text) })) };
    } catch (e) {
      log.error(`tool ${tool.name} failed`, { ms: Date.now() - started });
      return textResult(describeError(e), true);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.list() }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: resources.templates() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const found = resources.read(req.params.uri);
    if (!found) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${req.params.uri}`);
    }
    return { contents: [{ uri: req.params.uri, mimeType: found.mimeType, text: found.text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = prompts.find((x) => x.name === req.params.name);
    if (!p) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    const missing = p.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
    if (missing.length) {
      throw new McpError(ErrorCode.InvalidParams, `Missing prompt argument(s): ${missing.join(', ')}`);
    }
    return { description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.build(args) } }] };
  });

  return server;
}
