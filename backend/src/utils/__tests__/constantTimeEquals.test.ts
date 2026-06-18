import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEquals } from '../constantTimeEquals';

test('returns true for identical strings', () => {
  assert.equal(constantTimeEquals('s3cr3t-token', 's3cr3t-token'), true);
});

test('returns false for different strings of equal length', () => {
  assert.equal(constantTimeEquals('s3cr3t-token', 'S3cr3t-token'), false);
});

test('returns false for strings of different length (no length leak / no throw)', () => {
  assert.equal(constantTimeEquals('short', 'a-much-longer-value'), false);
});

test('handles empty strings', () => {
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals('', 'x'), false);
});

test('is stable across repeated calls in the same process (blinding key is fixed)', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abc'), true);
});
