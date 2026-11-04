const { execFileSync } = require('node:child_process'); const path = require('node:path');
let results;
beforeAll(() => { results = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/primary-mutations-fixtures.cjs')], {
  timeout: 30000, maxBuffer: 3 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'test' },
})).results; }, 35000);
test.each(['oauth-code-primary-unknown', 'oauth-grant-transaction-unknown-commit', 'oauth-expired-family-revoke-unknown',
  'oauth-client-registration-alias-unknown', 'linked-identity-unlink-unknown', 'device-nonce-authority-unknown'])('%s retains unknown required state through its actual caller and current error response', label => {
  const result = results.find(value => value.label === label); expect(result).toBeDefined();
  expect(result.phase).toBe('failed'); expect(result.active).toEqual([]); expect(result.failures.length).toBeGreaterThan(0);
  expect(result.facts.activeAtDisposition.some(value => value.active.some(active => /^(oauth|identity|authority):(primary|transaction)$/.test(active)))).toBe(true);
  expect(JSON.stringify(result.failures)).not.toMatch(/synthetic-code|synthetic-refresh-token|synthetic-install-token|synthetic-access-token|synthetic-secret|SQL INSERT/);
});
test.each(['oauth-grant-transaction-atomic-refusal', 'oauth-expired-family-revoke-confirmed', 'oauth-access-last-used-optional',
  'linked-identity-unlink-last-provider'])('%s preserves its confirmed rollback, intended denial, telemetry or prewrite permission outcome', label => {
  const result = results.find(value => value.label === label); expect(result).toBeDefined();
  expect(result.phase).toBe('drained'); expect(result.failures).toEqual([]);
});
test('an OAuth grant alias statement stays pending until its actual owning transaction outcome', () => {
  const rolledBack = results.find(value => value.label === 'oauth-grant-transaction-atomic-refusal');
  expect(rolledBack.facts).toMatchObject({ codeStatementResolved: true, grantStatementAttempted: true, transactionRolledBack: true });
  expect(rolledBack.failures).toEqual([]);
  const unknownCommit = results.find(value => value.label === 'oauth-grant-transaction-unknown-commit');
  expect(unknownCommit.facts).toMatchObject({ grantStatementResolved: true, commitResponseUnknown: true });
  expect(unknownCommit.failures[0].evidence.stage).toBe('transaction-completion-unconfirmed');
});
