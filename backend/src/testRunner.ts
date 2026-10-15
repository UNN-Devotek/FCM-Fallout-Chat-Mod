// Dependency-free unit-test entrypoint.
//
// The repo's Jest config targets compiled `tests/**/*.test.js`; these TypeScript
// unit tests instead use Node's built-in `node:test` runner via tsx. Node 20's
// `--test` flag doesn't expand `**` globs or discover `.ts`, so this runner finds
// and imports every `*.test.ts` under `src/` (recursively). `node:test`
// reports registered tests. The programmatic API needs an explicit exit status.
//
// Run with: npm run test:unit
import { readdirSync } from 'node:fs';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';

const root = path.join(process.cwd(), 'src');
const files = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => typeof f === 'string' && f.endsWith('.test.ts'))
  .map((f) => path.join(root, f));

if (files.length === 0) {
  console.error('No *.test.ts files found under src/');
  process.exit(1);
}

// Run each TypeScript suite in a child process. forceExit is deliberate: unit
// fixtures can open Redis/Prisma handles through default dependencies, and a
// completed test run must not hang waiting for those test-only handles.
const tests = run({ files, isolation: 'process', execArgv: ['--import', 'tsx'], forceExit: true });
let finalSummary = false;
let failed = false;
const completedFiles = new Set<string>();
// Read structured events before composing the reporter. Text output and child
// exit zero cannot prove that every test finished successfully.
tests.on('test:fail', result => {
  if (!result.todo && !result.skip) { failed = true; process.exitCode = 1; }
});
tests.on('test:summary', summary => {
  if (summary.file !== undefined) {
    completedFiles.add(path.resolve(summary.file));
    if (!summary.success || summary.counts.cancelled > 0) { failed = true; process.exitCode = 1; }
    return;
  }
  finalSummary = true;
  // A child can exit zero before Node emits its own terminal summary; the
  // parent then reports a passed file pseudo-test. Require every child's proof.
  if (!summary.success || summary.counts.cancelled > 0 || summary.counts.tests === 0
    || files.some(file => !completedFiles.has(path.resolve(file)))) failed = true;
  if (failed) process.exitCode = 1;
});
tests.on('error', () => { failed = true; process.exitCode = 1; });
tests.on('end', () => { if (!finalSummary || failed) process.exitCode = 1; });
tests.compose(spec()).pipe(process.stdout);
