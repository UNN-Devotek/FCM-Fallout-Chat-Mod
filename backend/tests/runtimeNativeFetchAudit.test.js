const fs = require('node:fs'), path = require('node:path');
const { audit, nativeCalls } = require('./setup/native-fetch-audit.cjs');
const { sourceOwners, compareProofBindings } = require('./setup/runtime-writer-inventory.cjs');
const root = path.resolve(__dirname, '../..');
const ledger = () => JSON.parse(fs.readFileSync(path.join(root, 'backend/runtime-writer-classification.json'), 'utf8'));
const files = ['controllers/campImageController.ts', 'controllers/devPersonaLoginController.ts', 'controllers/mcpOAuthController.ts', 'controllers/qaOAuthController.ts',
  'controllers/releasesController.ts', 'controllers/tenorSearchController.ts', 'controllers/verifyDevRoleController.ts', 'controllers/wikiImageController.ts',
  'lib/fandomApiClient.ts', 'lib/imageStorage.ts', 'runtime/nativeFetch.ts', 'server.ts', 'services/aiModerationService.ts', 'services/avatarService.ts',
  'services/campService.ts', 'services/devAuthService.ts', 'services/githubReleaseService.ts', 'services/githubService.ts', 'services/minervaService.ts',
  'services/nukeCodesService.ts', 'services/roleVerificationService.ts', 'services/serverStatusService.ts', 'services/steamAuthService.ts', 'services/steamProfileService.ts', 'services/ticketService.ts'].map(file => 'backend/src/' + file);

test('the actual complete native/default-aliased audit distinguishes Discord SDK reads', () => {
  const calls = audit(root);
  expect(calls).toHaveLength(44); expect([...new Set(calls.map(call => call.file))].sort()).toEqual(files.sort());
  expect(calls.filter(call => call.file.endsWith('/githubReleaseService.ts')).map(call => call.callee)).toEqual(['f', 'f', 'f']);
  expect(calls.filter(call => call.file.endsWith('/steamProfileService.ts'))).toContainEqual(expect.objectContaining({ callee: 'fetchImpl', reference: 'native-or-injected-default' }));
  expect(calls.filter(call => call.file.endsWith('/ticketService.ts'))).toHaveLength(1);
  expect(calls.every(call => call.ownerFingerprint)).toBe(true);
});

test('native aliases, bound callbacks and injected defaults are audited without treating local/Discord fetch as native', () => {
  const calls = nativeCalls('backend/src/services/fixture.ts', `import { beginRuntimeFetch as begin } from '../runtime/nativeFetch';
    async function run(custom: typeof fetch = fetch) {
      const native = globalThis.fetch.bind(globalThis); const saved = native;
      const { fetch: other } = globalThis; const selected = opts.fetchImpl || begin;
      await saved(url); await other(url); await custom(url); await selected(url);
      await guild.members.fetch(id); const local = { fetch() {} }; local.fetch();
    }
    function shadowed() { const fetch = () => {}; fetch(); }`);
  expect(calls.map(call => call.callee)).toEqual(['saved', 'other', 'custom', 'selected']);
});

test('same-named actual OAuth and dev-bot member methods retain their distinct semantic owners', () => {
  const file = 'backend/src/services/devAuthService.ts', text = fs.readFileSync(path.join(root, file), 'utf8');
  const calls = nativeCalls(file, text).filter(call => call.owner === 'fetchGuildMemberRoles');
  const owners = sourceOwners(file, text).filter(owner => owner.identity.owner === 'fetchGuildMemberRoles');
  expect(calls).toHaveLength(2); expect(calls.map(call => call.ownerFingerprint)).toEqual(owners.map(owner => owner.fingerprint));
  expect(calls[0].ownerFingerprint).not.toBe(calls[1].ownerFingerprint);
});

test.each(files)('actual native response file %s has a current semantic lifetime binding', file => {
  const current = ledger(), owners = sourceOwners(file, fs.readFileSync(path.join(root, file), 'utf8'));
  const proof = current.sourceBindings.find(binding => binding.identity.file === file && binding.identity.owner === '<module>');
  expect(proof).toBeDefined();
  expect(compareProofBindings(root, { sourceBindings: [proof] }, owners)).toEqual([]);
});

test.each(['backend/src/services/avatarService.ts', 'backend/src/lib/imageStorage.ts', 'backend/src/services/steamProfileService.ts', 'backend/src/services/minervaService.ts'])('removing the actual %s refusal cancellation is rejected even without a new writer', file => {
  const current = ledger(), source = fs.readFileSync(path.join(root, file), 'utf8');
  const altered = source.replace(/await discardRuntimeResponse\((response|res)\);/, ''); expect(altered).not.toBe(source);
  const proof = current.sourceBindings.find(binding => binding.identity.file === file && binding.identity.owner === '<module>');
  expect(compareProofBindings(root, { sourceBindings: [proof] }, sourceOwners(file, altered)))
    .toContainEqual({ identity: proof.identity, reason: 'shared-source-proof-changed' });
});

test('escaping the actual cancellation from admitted ownership fails the shared helper proof', () => {
  const file = 'backend/src/runtime/nativeFetch.ts', current = ledger();
  const before = fs.readFileSync(path.join(root, file), 'utf8'), altered = before.replace('await response.body.cancel()', 'await runtime.initializeSdkLifetime(() => response.body!.cancel())');
  expect(altered).not.toBe(before);
  const proof = current.sourceBindings.find(binding => binding.identity.file === file && binding.identity.owner === '<module>');
  expect(compareProofBindings(root, { sourceBindings: [proof] }, sourceOwners(file, altered)))
    .toContainEqual({ identity: proof.identity, reason: 'shared-source-proof-changed' });
});
