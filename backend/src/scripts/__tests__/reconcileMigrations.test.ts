import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReconcile, type DiskMigration } from '../reconcileMigrations';

const mig = (name: string): DiskMigration => ({ name, checksum: 'x' });
const row = (migration_name: string, applied: boolean) => ({ migration_name, applied });

test('inserts migrations on disk that are absent from the table', () => {
  const onDisk = [mig('a'), mig('b'), mig('c')];
  const { toInsert, failedCount } = planReconcile(onDisk, [row('a', true), row('b', true)]);
  assert.deepEqual(toInsert.map((m) => m.name), ['c']);
  assert.equal(failedCount, 0);
});

test('counts EVERY not-applied row — including orphaned (off-disk) failed rows', () => {
  // Regression guard: b & c are failed rows whose migrations are no longer on
  // disk. An earlier gate on the on-disk subset missed these, leaving them P3009.
  const onDisk = [mig('a')];
  const { toInsert, failedCount } = planReconcile(onDisk, [row('a', true), row('b', false), row('c', false)]);
  assert.deepEqual(toInsert, []);
  assert.equal(failedCount, 2);
});

test('no-op when every migration is applied and there are no failed rows', () => {
  const onDisk = [mig('a'), mig('b')];
  const { toInsert, failedCount } = planReconcile(onDisk, [row('a', true), row('b', true)]);
  assert.equal(toInsert.length, 0);
  assert.equal(failedCount, 0);
});

test('handles insert + fix in one pass', () => {
  const onDisk = [mig('a'), mig('b'), mig('c')];
  // a applied, b present-but-failed, c absent from the table
  const { toInsert, failedCount } = planReconcile(onDisk, [row('a', true), row('b', false)]);
  assert.deepEqual(toInsert.map((m) => m.name), ['c']);
  assert.equal(failedCount, 1);
});
