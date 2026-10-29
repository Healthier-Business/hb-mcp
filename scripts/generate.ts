import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogue, buildEvents } from '../src/generator/build.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'spec/hub-v2.json'));
const sha = createHash('sha256').update(raw).digest('hex');
const spec = JSON.parse(raw.toString('utf8'));

const catalogue = buildCatalogue(spec, sha);
const events = buildEvents(spec, sha);

mkdirSync(join(root, 'generated'), { recursive: true });
writeFileSync(join(root, 'generated/catalogue.json'), JSON.stringify(catalogue) + '\n');
writeFileSync(join(root, 'generated/events.json'), JSON.stringify(events) + '\n');
console.log(`generated ${catalogue.operationCount} operations and ${events.eventCount} events (spec ${catalogue.specVersion}, sha ${sha.slice(0, 12)})`);
