import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReconcile, type DiskMigration } from '../reconcileMigrations';

const mig = (name: string): DiskMigration => ({ name, checksum: 'x' });

test('inserts migrations on disk that are absent from the table', () => {
  const onDisk = [mig('a'), mig('b'), mig('c')];
  const { toInsert, toFix } = planReconcile(onDisk, new Set(['a', 'b']), new Set(['a', 'b']));
  assert.deepEqual(toInsert.map((m) => m.name), ['c']);
  assert.deepEqual(toFix, []);
});

test('fixes migrations present but not successfully applied (failed/unfinished)', () => {
  const onDisk = [mig('a'), mig('b'), mig('c')];
  // a applied, b present-but-failed, c present-but-failed
  const { toInsert, toFix } = planReconcile(onDisk, new Set(['a', 'b', 'c']), new Set(['a']));
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toFix.sort(), ['b', 'c']);
});

test('no-op when every migration is already applied (steady state)', () => {
  const onDisk = [mig('a'), mig('b')];
  const { toInsert, toFix } = planReconcile(onDisk, new Set(['a', 'b']), new Set(['a', 'b']));
  assert.equal(toInsert.length, 0);
  assert.equal(toFix.length, 0);
});

test('handles a mix of insert + fix in one pass', () => {
  const onDisk = [mig('a'), mig('b'), mig('c')];
  // a applied, b failed (present, not applied), c absent
  const { toInsert, toFix } = planReconcile(onDisk, new Set(['a', 'b']), new Set(['a']));
  assert.deepEqual(toInsert.map((m) => m.name), ['c']);
  assert.deepEqual(toFix, ['b']);
});
