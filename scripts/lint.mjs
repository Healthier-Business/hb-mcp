// Cheap project lint with no extra dependencies. stdout is the MCP protocol channel in stdio mode, so it must stay clean.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
  const rel = relative(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (/\bconsole\.(log|info|debug)\b/.test(line)) problems.push(`${at} console output (stdout is the protocol channel)`);
    if (/process\.stdout\.write/.test(line) && !rel.endsWith('cli.ts')) problems.push(`${at} stdout write outside cli.ts`);
    if (/:\s*any\b|\bas any\b|<any>/.test(line) && !line.includes('eslint-disable')) problems.push(`${at} 'any' type`);
    if (/@ts-ignore|@ts-nocheck/.test(line)) problems.push(`${at} ts-ignore`);
    if (/\b(TODO|FIXME|XXX)\b/.test(line)) problems.push(`${at} unfinished marker`);
    if (/hbk_[A-Za-z0-9]{20,}/.test(line)) problems.push(`${at} looks like a real key`);
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint ok');
