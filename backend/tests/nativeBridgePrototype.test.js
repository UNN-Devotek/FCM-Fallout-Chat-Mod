jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test' } }));
jest.mock('../src/services/relay/localExportBridge', () => ({
  parseLocalBridgeObservation: v => v && v.schemaVersion === 1 && Number.isSafeInteger(v.sequence)
    && Number.isSafeInteger(v.observationSequence) && typeof v.observationAgeMs === 'number' ? v : null,
}));
const { NativeBridgePrototype, nativeBridgePrototypeEnabled } = require('../src/services/relay/nativeBridgePrototype');
const sid = 'np-123456789-123456789-123456789-123456789';
let now, broker;
const sample = (n = 1, extra = {}, sentAt = now) => ({ sentAt, snapshot: { schemaVersion: 1, environment: 'dev', provider: 'xscal',
  build: 'prototype', sessionId: sid, worldGeneration: 'world-a', sequence: n, observationSequence: n,
  observationAgeMs: 0, state: 'active', ownName: 'Self', names: ['Peer'], ...extra } });
beforeEach(() => { now = 100000; broker = new NativeBridgePrototype(() => now); });
afterEach(() => { delete process.env.FCM_NATIVE_BRIDGE_PROTOTYPE; });
test('requires explicit flag and never enables on production', () => {
  expect(nativeBridgePrototypeEnabled()).toBe(false); process.env.FCM_NATIVE_BRIDGE_PROTOTYPE = '1';
  expect(nativeBridgePrototypeEnabled()).toBe(true);
  const env = require('../src/config/environment').default; env.NODE_ENV = 'production';
  expect(nativeBridgePrototypeEnabled()).toBe(false); env.NODE_ENV = 'test';
});
test('requires two advancing observations and exact account/session ownership', () => {
  const a = {}, b = {};
  expect(broker.ingest('account', 'native', sample())).toBe(true);
  expect(broker.claim('account', sid, a)).toBe(false);
  expect(broker.ingest('account', 'native', sample(2))).toBe(true);
  expect(broker.claim('foreign', sid, a)).toBe(false);
  expect(broker.claim('account', sid + '-other', a)).toBe(false);
  expect(broker.claim('account', sid, a)).toBe(true);
  expect(broker.claim('account', sid, b)).toBe(false);
  expect(broker.read('account', sid, b)).toBeNull();
  broker.release(a); expect(broker.claim('account', sid, b)).toBe(true);
});
test('rejects cross-native takeover, replay and foreign environments', () => {
  broker.ingest('account', 'native', sample());
  for (const [account, native, value] of [ ['account', 'other', sample(2)], ['other', 'native', sample(2)],
    ['account', 'native', sample()], ['account', 'native', sample(2, { environment: 'prod' })],
    ['account', 'native', sample(2, { provider: 'zfe' })]]) expect(broker.ingest(account, native, value)).toBe(false);
});
test('transport delay and clock margin reduce freshness; stale and future packets fail', () => {
  expect(broker.ingest('a', 'n', sample(1, {}, now - 28000))).toBe(false);
  expect(broker.ingest('a', 'n', sample(1, {}, now + 2001))).toBe(false);
  broker.ingest('a', 'n', sample(1, {}, now - 10000));
  broker.ingest('a', 'n', sample(2, {}, now - 10000));
  const owner = {}; broker.claim('a', sid, owner);
  expect(broker.read('a', sid, owner).snapshot.observationAgeMs).toBe(12000);
  now += 18000; expect(broker.read('a', sid, owner)).toBeNull();
});
test('heartbeats cannot extend deadlines or change evidence', () => {
  broker.ingest('a', 'n', sample()); broker.ingest('a', 'n', sample(2));
  const owner = {}; broker.claim('a', sid, owner);
  const deadline = broker.read('a', sid, owner).deadline;
  now += 10000;
  expect(broker.ingest('a', 'n', sample(3, { observationSequence: 2, names: ['Other'] }))).toBe(false);
  expect(broker.ingest('a', 'n', sample(3, { observationSequence: 2 }))).toBe(true);
  expect(broker.read('a', sid, owner).deadline).toBe(deadline);
  now = deadline;
  expect(broker.ingest('a', 'n', sample(4, { observationSequence: 2 }))).toBe(false);
  expect(broker.ingest('a', 'n', sample(4))).toBe(true);
  expect(broker.claim('a', sid, owner)).toBe(false);
  expect(broker.ingest('a', 'n', sample(5))).toBe(true);
  expect(broker.claim('a', sid, owner)).toBe(true);
});
test('holding cannot establish a session and session count is bounded', () => {
  expect(broker.ingest('a', 'n', sample(1, { state: 'holding' }))).toBe(false);
  for (let i = 0; i < 64; i++) expect(broker.ingest('a', 'n', sample(1, { sessionId: sid + '-' + i }))).toBe(true);
  expect(broker.ingest('a', 'n', sample(1, { sessionId: sid + '-65' }))).toBe(false);
});
test('inactive notice remains deliverable even with expired observation age', () => {
  broker.ingest('a', 'n', sample()); broker.ingest('a', 'n', sample(2));
  const owner = {}; broker.claim('a', sid, owner);
  expect(broker.ingest('a', 'n', sample(3, { state: 'inactive', observationAgeMs: 60000, observationSequence: 2 }))).toBe(true);
  expect(broker.read('a', sid, owner).snapshot.state).toBe('inactive');
});
