import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  /** Directories the server may read certificate files from (HB_UPLOAD_DIRS). Empty unless set: certificate upload is off until the owner lists a folder. */
  uploadDirs: string[];
  /** The one directory new secret files (webhook signing secrets) may be written to (HB_SECRETS_DIR; default `<home config>/hb-hub-mcp/secrets`). */
  secretsDir: string;
}

/** Where secret files go unless HB_SECRETS_DIR says otherwise: a dedicated folder under the user's config directory. */
export function defaultSecretsDir(): string {
  const base = process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'hb-hub-mcp', 'secrets');
}

/** True for the Hub's own domain (hbcompliance.co.uk and its sub domains) and for local hosts. */
export function isKnownHubHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'hbcompliance.co.uk' || h.endsWith('.hbcompliance.co.uk') || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

const warnedHosts = new Set<string>();

/** For tests: forget which hosts were already warned about. */
export function resetHostWarnings(): void {
  warnedHosts.clear();
}

/**
 * The API key and tokens are sent to HB_BASE_URL, so a host that is not the Hub or localhost deserves a warning on stderr
 * (once per host and process). The server keeps working. Returns the warning, or undefined when there is nothing to say.
 */
export function baseUrlHostWarning(baseUrl: string): string | undefined {
  const host = new URL(baseUrl).hostname;
  if (isKnownHubHost(host) || warnedHosts.has(host)) return undefined;
  warnedHosts.add(host);
  return `HB_BASE_URL points at "${host}", which is not a hbcompliance.co.uk address, localhost or 127.0.0.1. Your Hub API key and tokens are sent to that host. Check HB_BASE_URL unless this is intended (for example a proxy).`;
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
  HB_UPLOAD_DIRS: z.string().optional(),
  HB_SECRETS_DIR: z.string().optional(),
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

  let uploadDirs: string[] = [];
  if (e.HB_UPLOAD_DIRS && e.HB_UPLOAD_DIRS.trim() !== '') {
    const listed = e.HB_UPLOAD_DIRS.split(',').map((s) => s.trim()).filter(Boolean);
    const relative = listed.filter((d) => !isAbsolute(d));
    if (relative.length) {
      throw new ConfigError(`HB_UPLOAD_DIRS must be a comma-separated list of absolute paths; not absolute: ${relative.join(', ')}`);
    }
    uploadDirs = listed.map((d) => resolve(d));
  }

  let secretsDir = defaultSecretsDir();
  if (e.HB_SECRETS_DIR && e.HB_SECRETS_DIR.trim() !== '') {
    if (!isAbsolute(e.HB_SECRETS_DIR.trim())) throw new ConfigError('HB_SECRETS_DIR must be an absolute path to a folder.');
    secretsDir = resolve(e.HB_SECRETS_DIR.trim());
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
    uploadDirs,
    secretsDir,
  };
}

/** True when this configuration may send a write to the Hub at all. */
export function writesEnabled(c: Config): boolean {
  return !c.readOnly && (c.mode === 'sandbox' || c.allowLiveWrites);
}
