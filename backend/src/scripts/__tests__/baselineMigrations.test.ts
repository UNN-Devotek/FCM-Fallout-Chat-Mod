import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const script = readFileSync(path.resolve(process.cwd(), 'baseline-migrations.sh'), 'utf8');

test('baseline migrations fail closed when Prisma schema push fails', () => {
  assert.match(script, /set -eu/);
  assert.match(script, /if ! npx prisma db push --skip-generate; then/);
  assert.match(script, /FATAL: prisma db push failed/);
  assert.match(script, /exit 1/);
  assert.doesNotMatch(script, /db push[^\n]*--accept-data-loss/);
  assert.doesNotMatch(script, /db push[^\n]*\|\| true/);
});
