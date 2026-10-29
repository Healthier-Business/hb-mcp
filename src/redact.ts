/**
 * Secret registry. Every secret the process learns (API key, access and refresh tokens, webhook secrets) is registered
 * and scrubbed from every string that leaves the server, in addition to pattern-based scrubbing of anything key-shaped.
 */
const MIN_SECRET_LENGTH = 8;
const MARK = '[redacted]';

export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | undefined | null): void {
    if (secret && secret.length >= MIN_SECRET_LENGTH) {
      this.secrets.add(secret);
    }
  }

  forget(secret: string | undefined | null): void {
    if (secret) {
      this.secrets.delete(secret);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(MARK);
      }
    }
    out = out.replace(/whsec_[A-Za-z0-9]{20,}/g, MARK);
    out = out.replace(/hbk_[A-Za-z0-9_]{6,}/g, MARK);
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${MARK}`);
    return out;
  }

  /** Deep-redact a JSON value (strings only; keys are left alone). */
  redactJson<T>(value: T): T {
    if (typeof value === 'string') {
      return this.redact(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.redactJson(v)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.redactJson(v);
      }
      return out as T;
    }
    return value;
  }
}

export const redactor = new Redactor();
