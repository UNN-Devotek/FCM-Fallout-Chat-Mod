// Dependency-free unit-test entrypoint.
//
// The repo's Jest config targets compiled `tests/**/*.test.js`; these TypeScript
// unit tests instead use Node's built-in `node:test` runner via tsx. Node 20's
// `--test` flag doesn't expand `**` globs or discover `.ts`, so this runner finds
// and imports every `*.test.ts` under `src/` (recursively). `node:test`
// auto-executes registered tests and sets a non-zero exit code on failure.
//
// Run with: npm run test:unit
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(process.cwd(), 'src');
const files = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => typeof f === 'string' && f.endsWith('.test.ts'))
  .map((f) => path.join(root, f));

if (files.length === 0) {
  console.error('No *.test.ts files found under src/');
  process.exit(1);
}

void (async () => {
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
})();
