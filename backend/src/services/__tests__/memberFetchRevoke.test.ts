import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRevokeOnMemberFetchStatus } from '../../utils/memberFetchRevoke';

test('revokes only on 404 (member genuinely gone from the guild)', () => {
  assert.equal(shouldRevokeOnMemberFetchStatus(404), true);
});

test('does NOT revoke on transient / non-definitive statuses', () => {
  // Regression guard: revoking on these previously wiped valid moderators/admins
  // during a Discord rate-limit/outage blip. They must be retried, not revoked.
  for (const status of [429, 500, 502, 503, 504, 401, 403, 408, 0]) {
    assert.equal(
      shouldRevokeOnMemberFetchStatus(status),
      false,
      `status ${status} must NOT trigger a revoke`,
    );
  }
});
