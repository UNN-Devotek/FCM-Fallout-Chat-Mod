const { runRequiredEffectsFixture } = require('./setup/required-effects-result.cjs');
let results;
const cases = ['moderation-message-audit', 'permanent-ban-device-revocation', 'permanent-ban-relay-revocation', 'chat-name-audit',
  'cosmetics-audit', 'automod-violation-and-audit', 'relay-link-account-name', 'admin-update-audit', 'admin-delete-audit',
  'device-revoke-audit', 'overlay-logout-session-delete', 'mcp-audit-finalization', 'discord-oauth-admin-upsert',
  'discord-oauth-admin-save', 'discord-oauth-public-save', 'browser-logout-session-destroy', 'discord-unlink-session-effects',
  'steam-unlink-session-effects', 'party-reap-ephemeral-audit', 'party-reap-persistent-audit', 'relay-cursor-backfill-advance',
  'camp-atom-price-persistence', 'wiki-ingest-carousel-create', 'wiki-ingest-locations-update', 'wiki-ingest-entry-and-error-row', 'rule-create-audit', 'rule-update-audit', 'rule-delete-audit', 'rule-toggle-audit',
  'moderation-voice-audit', 'moderation-ai-audit', 'legacy-word-filter-test-audit', 'account-delete-unknown',
  'account-delete-audit', 'cursor-seed-write', 'cursor-backfill-write', 'cursor-backfill-max', 'reaction-panel-rollback-delete'];
beforeAll(() => {
  const expectedLabels = cases.concat(['shared-image-put', 'account-delete-absent', 'overlay-logout-already-absent', 'cursor-seed-read-fallback', 'cursor-optional-next', 'validation-rule-no-write']);
  results = runRequiredEffectsFixture({ expectedLabels }).data.results;
}, 35000);
test.each(cases)('%s retains its unconfirmed required effect instead of acknowledging a clean drain', label => {
  const result = results.find(item => item.label === label);
  expect(result).toBeDefined(); expect(Object.values(result.facts).some(value => value === true)).toBe(true);
  expect(result.active).toEqual([]); expect(result.phase).toBe('failed'); expect(result.failures.length).toBeGreaterThan(0);
  expect(result.failures.some(failure => typeof failure.evidence?.stage === 'string')).toBe(true);
  const evidence = JSON.stringify(result.failures);
  for (const secret of ['synthetic-token', 'synthetic-install', 'synthetic-access', 'synthetic-secret', 'SyntheticFixture', 'synthetic evidence']) {
    expect(evidence).not.toContain(secret);
  }
});
test('ordinary shared image caching preserves its documented source-URL fallback without a required failure', () => {
  const result = results.find(item => item.label === 'shared-image-put');
  expect(result.facts.putAttempted).toBe(true); expect(result.phase).toBe('drained'); expect(result.failures).toEqual([]);
});

test.each(['account-delete-absent','overlay-logout-already-absent','cursor-seed-read-fallback','cursor-optional-next','validation-rule-no-write'])('%s preserves a resolved absence/read/validation fallback', label => {
  const result = results.find(item => item.label === label); expect(result).toBeDefined(); expect(result.phase).toBe('drained'); expect(result.failures).toEqual([]);
});

test.each(['discord-unlink-session-effects','steam-unlink-session-effects'])('%s records both independent cache and database revocation failures', label => {
 const result = results.find(item => item.label === label); const stages = result.failures.map(value => value.evidence.stage);
 expect(stages).toContain('unlink-session-cache-delete-unconfirmed'); expect(stages).toContain('unlink-session-row-delete-unconfirmed');
});
