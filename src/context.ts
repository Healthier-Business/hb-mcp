import type { OperationCatalogue } from './catalogue.js';
import type { Config } from './config.js';
import type { Executor } from './execute.js';
import type { HubClient } from './http.js';
import type { TokenManager } from './tokens.js';

export const SERVER_NAME = 'hb-hub-mcp';
export const SERVER_VERSION = '0.3.0';

/** Everything a tool needs. One per process; shared by every MCP session. */
export interface AppContext {
  config: Config;
  catalogue: OperationCatalogue;
  tokens: TokenManager;
  client: HubClient;
  executor: Executor;
  /** Scopes of the key, learnt from /auth/me (hb_status). Undefined until known. */
  keyScopes?: string[];
  /** Pause between polls (task tools); replaced in tests. */
  sleep: (ms: number) => Promise<void>;
}

export function scopeAllowed(scopes: string[] | undefined, needed: string | null): boolean | null {
  if (needed === null) return true;
  if (!scopes) return null;
  if (scopes.includes(needed) || scopes.includes('*') || scopes.includes(`${needed.split(':')[0]}:*`)) return true;
  return needed.endsWith(':read') && scopes.includes(needed.replace(/:read$/, ':write'));
}
