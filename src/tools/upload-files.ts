import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** The certificate types the Training Verification API accepts, by extension (used when GET /profile does not say). */
export const DEFAULT_CERTIFICATE_TYPES = ['pdf', 'jpg', 'jpeg', 'png'] as const;
export const DEFAULT_CERTIFICATE_MAX_KB = 5120;

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export interface UploadLimits {
  /** Lower case extensions without the dot. */
  types: string[];
  maxBytes: number;
}

export interface SafeFile {
  fileName: string;
  extension: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** The bytes. Never put these in an answer, a log or structured data. */
  bytes: Buffer;
}

export type ReadOutcome = { ok: true; file: SafeFile } | { ok: false; problem: string };

const WILDCARD = /[*?[\]{}]/;

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hiddenSegment(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  return rel.split(sep).find((part) => part.startsWith('.') && part !== '' && part !== '.');
}

function magicMatches(extension: string, head: Buffer): boolean {
  switch (extension) {
    case 'pdf': return head.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'png': return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg': return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    default: return false;
  }
}

/**
 * Read one local file for upload, only when it is safe to: an exact absolute path (no wildcards, no `..`), inside an allowed
 * directory both as written and after symlinks are resolved, no hidden file or folder below that directory, a regular file,
 * an accepted extension (as written and after symlinks), within the size cap, and whose first bytes match its extension.
 * The problem texts name the rule that failed and never contain file contents.
 */
export async function readUploadFile(path: string, allowedDirs: string[], limits: UploadLimits): Promise<ReadOutcome> {
  const no = (problem: string): ReadOutcome => ({ ok: false, problem });
  if (path.includes('\0')) return no('the path is not valid.');
  if (!isAbsolute(path)) return no('certificate_path must be an absolute path to one file.');
  if (WILDCARD.test(path)) return no('certificate_path must name exactly one file: wildcards and patterns ( * ? [ ] { } ) are not expanded.');
  if (path.split(/[\\/]/).includes('..')) return no('certificate_path must not contain ".." segments.');
  const written = resolve(path);

  const lexicalRoots = allowedDirs.map((d) => resolve(d)).filter((d) => inside(d, written));
  if (lexicalRoots.length === 0) {
    return no(`the file is outside the directories this server may read from (HB_UPLOAD_DIRS${allowedDirs.length ? `: ${allowedDirs.join(', ')}` : ''}). Move it into one of them, or ask the owner to add its folder.`);
  }
  const hiddenWritten = lexicalRoots.map((r) => hiddenSegment(r, written)).find((h) => h !== undefined);
  if (hiddenWritten !== undefined && lexicalRoots.every((r) => hiddenSegment(r, written) !== undefined)) {
    return no(`hidden files and folders are never read (${hiddenWritten}).`);
  }

  let real: string;
  try {
    real = await realpath(written);
  } catch {
    return no('the file does not exist or cannot be read.');
  }
  const realRoots: string[] = [];
  for (const d of allowedDirs) {
    try {
      const r = await realpath(resolve(d));
      if (inside(r, real)) realRoots.push(r);
    } catch {
      /* an allowed directory that does not exist allows nothing */
    }
  }
  if (realRoots.length === 0) {
    return no('the file resolves (through a symbolic link) to a place outside the directories this server may read from, so it was refused.');
  }
  const hiddenReal = realRoots.map((r) => hiddenSegment(r, real)).find((h) => h !== undefined);
  if (hiddenReal !== undefined && realRoots.every((r) => hiddenSegment(r, real) !== undefined)) {
    return no(`the file resolves to a hidden file or folder (${hiddenReal}), which is never read.`);
  }

  const fileName = basename(written);
  const extension = extname(fileName).slice(1).toLowerCase();
  const realExtension = extname(real).slice(1).toLowerCase();
  const accepted = limits.types.map((t) => t.toLowerCase());
  if (!extension || !accepted.includes(extension)) return no(`the file type ".${extension || '(none)'}" is not accepted. The API accepts: ${accepted.map((t) => `.${t}`).join(', ')}.`);
  if (!accepted.includes(realExtension)) return no(`the file is a link to a file of type ".${realExtension || '(none)'}", which is not accepted.`);

  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return no('the file cannot be opened.');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return no('the path is not a regular file.');
    if (st.size === 0) return no('the file is empty.');
    if (st.size > limits.maxBytes) return no(`the file is ${formatSize(st.size)}, over the limit of ${formatSize(limits.maxBytes)}.`);
    const buf = Buffer.alloc(Math.min(st.size, limits.maxBytes) + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > limits.maxBytes) return no(`the file is over the limit of ${formatSize(limits.maxBytes)}.`);
    const bytes = buf.subarray(0, bytesRead);
    if (!magicMatches(extension, bytes) || !magicMatches(realExtension, bytes)) {
      return no(`the content does not look like a real .${extension} file (the first bytes do not match), so it was refused.`);
    }
    return {
      ok: true,
      file: {
        fileName,
        extension,
        contentType: MIME[extension] ?? 'application/octet-stream',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      },
    };
  } finally {
    await handle.close();
  }
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
