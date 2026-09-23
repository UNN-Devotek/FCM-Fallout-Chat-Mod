jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test' } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  hudPairingToken: { findFirst: jest.fn(async () => ({ userId: 'native' })) },
} }));
jest.mock('../src/services/relay/localExportBridge', () => ({ parseLocalBridgeObservation: v => v }));
jest.mock('../src/services/relay/overlayServerBridge', () => ({ bridgeBindingId: b => `${b.relayUserId}/${b.requestId}/${b.room}`, resolveOverlayBridge: jest.fn() }));
jest.mock('../src/services/relay/serverChat', () => ({ getServerHistory: jest.fn(), SERVER_HISTORY_ROOM: Symbol('history') }));
jest.mock('../src/services/relay/worldRosterService', () => ({ readRoster: jest.fn() }));
jest.mock('../src/services/relay/serverMessageService', () => ({ sendServerMessage: jest.fn(), ServerMessageError: class extends Error {} }));
const { BridgeConnection } = require('../src/websocket/bridgeConnection');
const { nativeBridgePrototype: broker } = require('../src/services/relay/nativeBridgePrototype');
const prisma = require('../src/config/prisma').default;
let serial = 0, connections;
beforeEach(() => { jest.useFakeTimers(); process.env.FCM_NATIVE_BRIDGE_PROTOTYPE = '1'; connections = [];
  prisma.hudPairingToken.findFirst.mockResolvedValue({ userId: 'native' }); });
afterEach(() => { for (const c of connections) c.dispose(); jest.useRealTimers(); delete process.env.FCM_NATIVE_BRIDGE_PROTOTYPE; });
function setup(account = 'account') {
  const sessionId = `np-123456789-123456789-123456789-${++serial}`;
  let binding = null;
  const frames = [];
  const local = {
    observe: jest.fn(async s => { binding = s.state === 'active' ? { relayUserId: 'overlay', requestId: s.worldGeneration,
      room: 'r:room', displayName: 'Self', sessionId, worldGeneration: s.worldGeneration, sequence: s.sequence } : null; return true; }),
    resolve: jest.fn(async () => binding ? { status: 'ready', binding } : { status: 'inactive' }),
    invalidate: jest.fn(() => { binding = null; }), leave: jest.fn(async () => { binding = null; }), close: jest.fn(async () => {}),
  };
  const deps = { resolve: jest.fn(), history: jest.fn(async () => []), sendMessage: jest.fn() };
  const bridge = new BridgeConnection(account, f => frames.push(f), () => new Set(), deps, local);
  connections.push(bridge);
  const send = (sequence, extra = {}) => broker.ingest('account', 'native', { sentAt: Date.now(), snapshot: {
    schemaVersion: 1, environment: 'dev', provider: 'xscal', build: 'test', sessionId, worldGeneration: 'world-a', sequence,
    observationSequence: sequence, observationAgeMs: 0, state: 'active', ownName: 'Self', names: ['Peer'], ...extra } });
  return { sessionId, frames, bridge, local, deps, send };
}
test('paired evidence uses existing coordinator sink and precedes ready/history', async () => {
  const s = setup(); s.send(1); s.send(2); await s.bridge.pairNative(s.sessionId);
  expect(s.local.observe).toHaveBeenCalledTimes(1);
  const evidence = s.frames.findIndex(f => f.type === 'bridge:native-observation');
  const ready = s.frames.findIndex(f => f.type === 'bridge:state' && f.payload.status === 'ready');
  expect(evidence).toBeGreaterThanOrEqual(0); expect(ready).toBeGreaterThan(evidence);
  expect(s.frames[evidence].payload).not.toHaveProperty('names');
  expect(s.deps.resolve).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(2000); expect(s.local.observe).toHaveBeenCalledTimes(1);
  s.send(3); await jest.advanceTimersByTimeAsync(1000); expect(s.local.observe).toHaveBeenCalledTimes(2);
});
test('foreign account cannot pair and disabled flag cannot claim', async () => {
  const s = setup('foreign'); s.send(1); s.send(2); await s.bridge.pairNative(s.sessionId);
  expect(s.local.observe).not.toHaveBeenCalled();
  const t = setup(); t.send(1); t.send(2); delete process.env.FCM_NATIVE_BRIDGE_PROTOTYPE;
  await t.bridge.pairNative(t.sessionId); expect(t.local.observe).not.toHaveBeenCalled();
});
test('revocation, game leave and disposal stop native admission', async () => {
  const s = setup(); s.send(1); s.send(2); await s.bridge.pairNative(s.sessionId);
  prisma.hudPairingToken.findFirst.mockResolvedValue(null);
  s.send(3); await jest.advanceTimersByTimeAsync(1000);
  expect(s.local.observe).toHaveBeenCalledTimes(1); expect(s.local.leave).toHaveBeenCalledWith('account_change');
  expect(s.frames.at(-1)).toMatchObject({ type: 'bridge:state', payload: { status: 'inactive' } });
});
test('leave while credential lookup waits discards stale observation', async () => {
  const s = setup(); s.send(1); s.send(2);
  let finish; prisma.hudPairingToken.findFirst.mockImplementation(() => new Promise(r => { finish = r; }));
  const pending = s.bridge.pairNative(s.sessionId);
  await Promise.resolve(); await s.bridge.leave('game_exit'); finish({ userId: 'native' }); await pending;
  expect(s.local.observe).not.toHaveBeenCalled();
});
