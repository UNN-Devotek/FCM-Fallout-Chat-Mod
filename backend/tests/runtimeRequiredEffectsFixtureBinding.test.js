const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { runRequiredEffectsFixture, readRequiredEffectsArtifact } = require('./setup/required-effects-result.cjs');
const labels = ['module-success', 'module-body-held', 'module-callback-held', 'vm-success', 'vm-body-held', 'vm-callback-held'];
test.each(['source', 'compiled'])('the required-effects %s fixture binds both loaders to its current admitted coordinator', variant => {
  const source = path.join(__dirname, variant === 'source' ? '../src' : '../dist');
  const proof = runRequiredEffectsFixture({ args: ['--native-binding-only'], environment: { FCM_REQUIRED_EFFECTS_SOURCE: source }, expectedLabels: labels }).data;
  expect(proof.compiled).toBe(variant === 'compiled');
  for (const result of proof.results) {
    expect(result.facts.initializationCalls).toBe(1); expect(result.facts.activeAtInitialization).toContain('accepted-bound-native-result');
    expect(result.facts.unintendedRuntimeLoaded).toBe(false); expect(result.facts.unintendedEnvironmentLoaded).toBe(false);
    expect(result.facts.body).toBe('synthetic result'); expect(result.facts.requests).toBe(1);
    expect(result.facts.requestEnded).toBe(true); expect(result.facts.responseFinished).toBe(true); expect(result.facts.responseClosed).toBe(true); expect(result.facts.terminalSockets).toBe(0);
    expect(result.phase).toBe('closed'); expect(result.ingressClosed).toBe(true); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
    expect(result.accountingEpoch).toEqual(expect.any(Number)); expect(result.accountingEpoch).toBe(result.inspectionEpoch);
    if (!result.label.endsWith('success')) { expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
    if (result.label.endsWith('body-held')) expect(result.facts.completedAtCheckpoint).toBe(false);
    if (result.label.endsWith('callback-held')) { expect(result.facts.callbackDoneAtCheckpoint).toBe(false); expect(result.facts.callbackDone).toBe(true); }
  }
}, 35000);
test.each(['source', 'compiled'])('the actual %s helper refuses access before a fixture coordinator exists', variant => {
  const proof = runRequiredEffectsFixture({ args: ['--native-before-runtime'], environment: { FCM_REQUIRED_EFFECTS_SOURCE: path.join(__dirname, variant === 'source' ? '../src' : '../dist') } }).data;
  expect(proof.guardRefused).toBe(true); expect(proof.unintendedRuntimeLoaded).toBe(false); expect(proof.unintendedEnvironmentLoaded).toBe(false);
});
test('removing the exact current helper runtime binding exposes the unintended singleton even through an explicit result artifact', () => {
  const proof = runRequiredEffectsFixture({ args: ['--native-binding-only'], expectedLabels: labels, removedBinding: true }).data;
  expect(proof.results.every(result => result.facts.initializationCalls === 0)).toBe(true);
  expect(proof.results.every(result => result.facts.unintendedRuntimeLoaded && result.facts.unintendedEnvironmentLoaded)).toBe(true);
});
test('a real child with the removed before-instance guard returns failure instead of an accepted artifact', () => {
  expect(() => runRequiredEffectsFixture({ args: ['--native-before-runtime'], removedBinding: true })).toThrow('Required fixture process failed: status=1');
});
test.each(['missing', 'malformed', 'incomplete', 'duplicate', 'unexpected'])('a %s explicit artifact cannot satisfy the canonical scenario set', mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-result-validation-')), output = path.join(directory, 'result.json');
  try {
    if (mode !== 'missing') fs.writeFileSync(output, mode === 'malformed' ? 'ordinary diagnostic, not JSON' : JSON.stringify({ results: mode === 'incomplete' ? [] : mode === 'duplicate' ? [{ label: 'a' }, { label: 'a' }] : [{ label: 'a' }, { label: 'foreign' }] }));
    expect(() => readRequiredEffectsArtifact(output, ['a', 'b'])).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
