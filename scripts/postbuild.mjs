import { chmodSync, existsSync } from 'node:fs';
const cli = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(cli)) {
  console.error('dist/cli.js missing: tsc did not emit');
  process.exit(1);
}
chmodSync(cli, 0o755);
console.log('dist/cli.js is executable');
