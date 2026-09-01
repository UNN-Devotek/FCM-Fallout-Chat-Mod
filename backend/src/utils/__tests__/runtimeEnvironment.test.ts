import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartBackgroundJobs } from '../runtimeEnvironment';

test('backend tests do not start external background jobs', () => {
  assert.equal(shouldStartBackgroundJobs('test'), false);
});

test('development and production start background jobs', () => {
  assert.equal(shouldStartBackgroundJobs('development', false), true);
  assert.equal(shouldStartBackgroundJobs('production', false), true);
});

test('Jest test runtime stays isolated even when a test reloads development config', () => {
  assert.equal(shouldStartBackgroundJobs('development', true), false);
});
