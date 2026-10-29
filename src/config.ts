import { z } from 'zod';
import type { LogLevel } from './log.js';

export const DEFAULT_BASE_URL = 'https://hub.hbcompliance.co.uk';
export const TOOLSETS = [
  'hub', 'account', 'authentication', 'online-training', 'occupational-health', 'references', 'practical-training',
  'virtual-bls-training', 'clinical-interviews', 'registration-monitoring', 'dbs-rtw', 'clinical-appraisals',
  'training-verification',
] as const;

export type Mode = 'live' | 'sandbox';
export type ToolMode = 'compact' | 'full';
export type TaskToolsMode = 'all' | 'core' | 'none';

export interface Config {
  apiKey: string | undefined;
  baseUrl: string;
  mode: Mode;
  modeSource: 'HB_ENV' | 'url' | 'default' | 'unrecognised-host';
  toolMode: ToolMode;
  taskTools: TaskToolsMode;
  toolsets: string[];
  readOnly: boolean;
  allowLiveWrites: boolean;
  logLevel: LogLevel;
  maxResponseChars: number;
  requestTimeoutMs: number;
  webhookSecret: string | undefined;
}

export class ConfigError extends Error {}

const bool = (name: string, def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') {
        return def;
      }
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(s)) {
        return false;
      }
      ctx.addIssue({ code: 'custom', message: `${name} must be true or false` });
      return z.NEVER;
    });

const schema = z.object({
  HB_API_KEY: z.string().optional(),
  HB_BASE_URL: z.string().optional(),
  HB_ENV: z.enum(['live', 'sandbox']).optional(),
  HB_TOOL_MODE: z.enum(['compact', 'full']).optional(),
  HB_TASK_TOOLS: z.enum(['all', 'core', 'none']).optional(),
  HB_TOOLSETS: z.string().optional(),
  HB_READ_ONLY: bool('HB_READ_ONLY', true),
  HB_ALLOW_LIVE_WRITES: bool('HB_ALLOW_LIVE_WRITES', false),
  HB_LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).optional(),
  HB_MAX_RESPONSE_CHARS: z.coerce.number().int().min(2000).max(2_000_000).optional(),
  HB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).optional(),
  HB_WEBHOOK_SECRET: z.string().optional(),
});

export function detectMode(baseUrl: string, hbEnv: Mode | undefined): { mode: Mode; source: Config['modeSource'] } {
  if (hbEnv) {
    return { mode: hbEnv, source: 'HB_ENV' };
  }
  const url = new URL(baseUrl);
  if (url.origin === DEFAULT_BASE_URL) {
    return { mode: 'live', source: 'default' };
  }
  const host = url.hostname.toLowerCase();
  if (/(^|\.)sandbox(\.|$)/.test(host) || /\/sandbox(\/|$)/.test(url.pathname)) {
    return { mode: 'sandbox', source: 'url' };
  }
  return { mode: 'live', source: 'unrecognised-host' };
}

export function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`HB_BASE_URL is not a valid URL: ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ConfigError('HB_BASE_URL must use https (http is only allowed for localhost).');
  }
  if (url.username || url.password) {
    throw new ConfigError('HB_BASE_URL must not contain credentials.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api\/v2$/, '');
  return `${url.origin}${path}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Clients such as Claude Code pass unset optional settings as empty strings: treat those as not set.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const e = parsed.data;
  const baseUrl = normaliseBaseUrl(e.HB_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const { mode, source } = detectMode(baseUrl, e.HB_ENV);

  let toolsets: string[] = [...TOOLSETS];
  if (e.HB_TOOLSETS && e.HB_TOOLSETS.trim() !== '' && e.HB_TOOLSETS.trim().toLowerCase() !== 'all') {
    toolsets = e.HB_TOOLSETS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = toolsets.filter((t) => !(TOOLSETS as readonly string[]).includes(t));
    if (unknown.length) {
      throw new ConfigError(`HB_TOOLSETS has unknown toolsets: ${unknown.join(', ')}. Valid: ${TOOLSETS.join(', ')}`);
    }
  }

  return {
    apiKey: e.HB_API_KEY?.trim() || undefined,
    baseUrl,
    mode,
    modeSource: source,
    toolMode: e.HB_TOOL_MODE ?? 'compact',
    taskTools: e.HB_TASK_TOOLS ?? 'all',
    toolsets,
    readOnly: e.HB_READ_ONLY,
    allowLiveWrites: e.HB_ALLOW_LIVE_WRITES,
    logLevel: e.HB_LOG_LEVEL ?? 'warn',
    maxResponseChars: e.HB_MAX_RESPONSE_CHARS ?? 60_000,
    requestTimeoutMs: e.HB_REQUEST_TIMEOUT_MS ?? 30_000,
    webhookSecret: e.HB_WEBHOOK_SECRET?.trim() || undefined,
  };
}

/** True when this configuration may send a write to the Hub at all. */
export function writesEnabled(c: Config): boolean {
  return !c.readOnly && (c.mode === 'sandbox' || c.allowLiveWrites);
}
