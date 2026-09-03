import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldWaitForPersistence } from '../messagePersistencePolicy';

test('relay messages broadcast after queue acceptance without waiting for a worker', () => {
  assert.equal(shouldWaitForPersistence('relay'), false);
});

test('ordinary producers retain persist-before-broadcast ordering', () => {
  assert.equal(shouldWaitForPersistence('ws'), true);
  assert.equal(shouldWaitForPersistence('hud'), true);
  assert.equal(shouldWaitForPersistence('game'), true);
});
