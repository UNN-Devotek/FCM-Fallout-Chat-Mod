import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipRoleVerification } from '../../utils/roleVerificationSkip';

test('skips synthetic dev-login personas when dev-login is enabled', () => {
  assert.equal(shouldSkipRoleVerification('dev-owner-4699b6466273c67f', { devLoginEnabled: true }), true);
  assert.equal(shouldSkipRoleVerification('dev-mod-abc', { devLoginEnabled: true }), true);
});

test('does NOT skip real Discord snowflake IDs', () => {
  assert.equal(shouldSkipRoleVerification('123456789012345678', { devLoginEnabled: true }), false);
});

test('never skips when dev-login is disabled (prod safety)', () => {
  // Even a dev-looking id is still verified in prod, where ENABLE_DEV_LOGIN is off.
  assert.equal(shouldSkipRoleVerification('dev-owner-x', { devLoginEnabled: false }), false);
  assert.equal(shouldSkipRoleVerification('123456789012345678', { devLoginEnabled: false }), false);
});
