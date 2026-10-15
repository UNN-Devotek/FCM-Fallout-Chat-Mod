const path = require('node:path');
const { execFileSync } = require('node:child_process');
let proof;
beforeAll(() => {
  proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-sdk-callback-fixtures.cjs')], {
    timeout: 25000, encoding: 'utf8',
  }));
}, 30000);
const result = label => proof.results.find(value => value.label === label);
test.each(['login-success', 'login-callback', 'rest-success', 'rest-held', 'rest-callback'])('actual installed Discord %s releases SDK operations and closes', mode => {
  const value = result('discord-' + mode);
  expect(value.phase).toBe('closed'); expect(value.active).toEqual([]); expect(value.failures).toEqual([]);
  expect(value.closed).toContain('discord-client'); expect(value.facts.destroyed).toBe(true);
  if (mode.startsWith('login')) expect(value.facts.readyUser).toBe('100000000000000001');
  else expect(value.facts.replyId).toBe('100000000000000002');
});
test.each(['login-callback', 'rest-held', 'rest-callback'])('actual installed Discord %s retains held work through freeze', mode => {
  const value = result('discord-' + mode);
  expect(value.facts.held.phase).toBe('failed'); expect(value.facts.held.active.length).toBeGreaterThan(0);
  if (mode.endsWith('callback')) { expect(value.facts.destroyedBeforeCallback).toBe(false); expect(value.facts.callbackCompleted).toBe(true); }
});
test.each(['rest-unknown', 'rest-lost-reply'])('unknown actual Discord mutation %s retains required disposition without hidden retries', mode => {
  const value = result('discord-' + mode);
  expect(value.facts.rejected).toBe(true); expect(value.facts.sdkRetries).toBe(0);
  expect(value.facts.requests).toBe(1); expect(value.phase).toBe('failed');
  expect(value.failures).toContainEqual(expect.objectContaining({ label: 'discord-rest:POST', evidence: expect.objectContaining({ stage: 'discord-rest-completion-unconfirmed' }) }));
  expect(JSON.stringify(value.failures)).not.toContain('private-fixture-token');
});
for (const mode of ['set', 'touch', 'destroy', 'clear']) {
  test.each(['success', 'held', 'unknown'])(`actual express-session/connect-redis ${mode} %s preserves callback completion and disposition`, outcome => {
    const value = result(`browser-${mode}-${outcome}`);
    expect(value.facts.calls).toContain(mode === 'touch' ? 'expire' : ['destroy', 'clear'].includes(mode) ? 'del' : 'set');
    expect(value.phase).toBe(outcome === 'unknown' ? 'failed' : 'closed'); expect(value.active).toEqual([]);
    expect(value.failures).toHaveLength(outcome === 'unknown' ? 1 : 0);
    if (outcome === 'held') { expect(value.facts.held.phase).toBe('failed'); expect(value.facts.held.active.length).toBeGreaterThan(0); }
    if (mode === 'destroy' || mode === 'clear') expect(value.facts.callbackCount).toBe(1);
    expect(JSON.stringify(value.failures)).not.toMatch(/private-fixture|private-session/);
  });
}
test('accepted connect-redis clear retains unknown session discovery', () => {
  const value = result('browser-clear-discovery-unknown');
  expect(value.phase).toBe('failed'); expect(value.facts.callbackCount).toBe(1); expect(value.facts.callbackError).toBe(true);
  expect(value.failures).toHaveLength(1);
});
test('the actual session SDK callback keeps detached work after its response resolves', () => {
  const value = result('browser-set-callback-held');
  expect(value.facts.held.phase).toBe('failed'); expect(value.facts.held.active.length).toBeGreaterThan(0);
  expect(value.phase).toBe('closed'); expect(value.facts.callbackCount).toBe(1); expect(value.facts.callbackCompleted).toBe(true);
});
test.each([['touch', 'read-unknown'], ['set', 'serialization-refused'], ['touch', 'touch-disabled']])('ordinary session %s/%s performs no write and preserves normal error/denial behavior', (mode, outcome) => {
  const value = result(`browser-${mode}-${outcome}`);
  expect(value.facts.calls).toEqual([]); expect(value.phase).toBe('closed'); expect(value.failures).toEqual([]);
});
test('a new automatic-store write after freeze is denied through its callback once before SDK commands', () => {
  const value = result('browser-set-frozen');
  expect(value.facts.callbackCount).toBe(1); expect(value.facts.maintenanceRefusal).toBe(true);
  expect(value.facts.calls).toEqual([]); expect(value.phase).toBe('closed'); expect(value.failures).toEqual([]);
});
