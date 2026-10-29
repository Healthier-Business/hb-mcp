/**
 * Usage: npm run spec:refresh -- <path to hub-v2.json> [<path to guides dir> <path to portals dir>]
 * Validates the new spec (shape, counts, tag mapping, unique tool names), copies it to spec/ and regenerates.
 */
import { copyFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogue, buildEvents } from '../src/generator/build.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [specArg, guidesArg, portalsArg] = process.argv.slice(2);
if (!specArg) {
  console.error('Usage: npm run spec:refresh -- <path to hub-v2.json> [guides-dir portals-dir]');
  process.exit(2);
}
const source = resolve(specArg);
if (!existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(2);
}
const raw = readFileSync(source);
let spec;
try {
  spec = JSON.parse(raw.toString('utf8'));
} catch (e) {
  console.error(`Not valid JSON: ${(e as Error).message}`);
  process.exit(1);
}
if (!String(spec.openapi ?? '').startsWith('3.') || !spec.paths || !spec.webhooks || !spec.components) {
  console.error('Not an OpenAPI 3 document with paths, webhooks and components.');
  process.exit(1);
}
const catalogue = buildCatalogue(spec, 'validation');
const events = buildEvents(spec, 'validation');
console.log(`valid: ${catalogue.operationCount} operations, ${events.eventCount} events, version ${catalogue.specVersion}`);

copyFileSync(source, join(root, 'spec/hub-v2.json'));
if (guidesArg) cpSync(resolve(guidesArg), join(root, 'content/guides'), { recursive: true });
if (portalsArg) cpSync(resolve(portalsArg), join(root, 'content/portals'), { recursive: true });
execFileSync('npx', ['tsx', 'scripts/generate.ts'], { cwd: root, stdio: 'inherit' });
console.log('Spec refreshed. Run `npm test` to check nothing drifted.');
