const { evaluateBuildGate } = require('../src/services/buildLock');

// Simulates the handler's read of the WS upgrade request headers.
function gateFor(headers, active, lock) {
  return evaluateBuildGate(headers, active, lock);
}

test('lock on, stale WS client -> not allowed (handler will close 4003)', () => {
  const r = gateFor({ 'x-auth-token': 'abc', 'x-client-version': '1.3.0-qa' }, '1.4.0-qa', true);
  expect(r.allowed).toBe(false);
});

test('lock on, current WS client -> allowed', () => {
  const r = gateFor({ 'x-client-version': '1.4.0-qa' }, '1.4.0-qa', true);
  expect(r.allowed).toBe(true);
});

test('lock off -> allowed regardless (prod overlays unaffected)', () => {
  const r = gateFor({ 'x-client-version': '0.0.0' }, '1.4.0-qa', false);
  expect(r.allowed).toBe(true);
});
