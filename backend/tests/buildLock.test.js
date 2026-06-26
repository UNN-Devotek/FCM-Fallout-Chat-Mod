const { isBuildAllowed, evaluateBuildGate } = require('../src/services/buildLock');

describe('isBuildAllowed', () => {
  test('lock disabled -> always allowed', () => {
    expect(isBuildAllowed('0.0.1', '9.9.9', false)).toBe(true);
    expect(isBuildAllowed('', '9.9.9', false)).toBe(true);
  });
  test('lock enabled but active unset -> fail open', () => {
    expect(isBuildAllowed('1.0.0', '', true)).toBe(true);
    expect(isBuildAllowed('1.0.0', null, true)).toBe(true);
  });
  test('lock enabled, exact match -> allowed', () => {
    expect(isBuildAllowed('1.4.0-qa', '1.4.0-qa', true)).toBe(true);
  });
  test('lock enabled, mismatch -> denied', () => {
    expect(isBuildAllowed('1.3.0-qa', '1.4.0-qa', true)).toBe(false);
  });
  test('lock enabled, missing client version -> denied', () => {
    expect(isBuildAllowed('', '1.4.0-qa', true)).toBe(false);
  });
});

describe('evaluateBuildGate', () => {
  test('reads x-client-version header (lowercase) and allows on match', () => {
    const r = evaluateBuildGate({ 'x-client-version': '1.4.0-qa' }, '1.4.0-qa', true);
    expect(r).toEqual({ allowed: true, clientVersion: '1.4.0-qa' });
  });
  test('denies on mismatch with a reason', () => {
    const r = evaluateBuildGate({ 'x-client-version': '1.3.0-qa' }, '1.4.0-qa', true);
    expect(r.allowed).toBe(false);
    expect(r.clientVersion).toBe('1.3.0-qa');
    expect(r.reason).toMatch(/1\.4\.0-qa/);
  });
  test('missing header -> clientVersion empty, denied when locked', () => {
    const r = evaluateBuildGate({}, '1.4.0-qa', true);
    expect(r.allowed).toBe(false);
    expect(r.clientVersion).toBe('');
  });
});
