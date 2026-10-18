const { execFileSync } = require('node:child_process'), path = require('node:path');
test.each(['primary-mutations-fixtures.cjs', 'round6-primary-fixtures.cjs'])('%s binds the exact native helper to each current fixture coordinator without loading a singleton', file => {
  const proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup', file), path.join(__dirname, '../src'), '--native-binding-only'], { encoding: 'utf8', timeout: 10000 }));
  expect(proof.results).toHaveLength(3);
  for (const result of proof.results) {
    expect(result.facts.initializationCalls).toBe(1); expect(result.facts.unintendedRuntimeLoaded).toBe(false); expect(result.facts.unintendedEnvironmentLoaded).toBe(false);
    expect(result.phase).toBe('closed'); expect(result.ingressClosed).toBe(true); expect(result.active).toEqual([]); expect(result.failures).toEqual([]); expect(result.facts.body).toBe('synthetic result');
    if (result.label !== 'success') { expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
    if (result.label === 'body-held') expect(result.facts.completedAtCheckpoint).toBe(false);
    if (result.label === 'callback-held') { expect(result.facts.callbackDoneAtCheckpoint).toBe(false); expect(result.facts.callbackDone).toBe(true); }
  }
}, 15000);
