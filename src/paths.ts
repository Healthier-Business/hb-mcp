import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root: this file lives in src/ (tsx) or dist/ (built), one level below it. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function assetPath(...parts: string[]): string {
  return join(PACKAGE_ROOT, ...parts);
}
