jest.mock('../src/services/relay/overlayServerBridge', () => ({
  bridgeBindingId: b => `${b.relayUserId}/${b.requestId}/${b.room}`, resolveOverlayBridge: jest.fn(),
}));
jest.mock('../src/services/relay/serverChat', () => ({ getServerHistory: jest.fn() }));
jest.mock('../src/services/relay/serverMessageService', () => ({ sendServerMessage: jest.fn(), ServerMessageError: class extends Error {} }));
const { BridgeConnection } = require('../src/websocket/bridgeConnection');
const { bridgeBindingId } = require('../src/services/relay/overlayServerBridge');
const binding = { accountId: 'account-a', relayUserId: 'user_a', requestId: 'world-one', room: 'r:one', displayName: 'Alice' };
const event = (id = 1, override = {}) => ({ id, kind: 'chat.message', messageId: `server:r:one:${id}`, channel: 'server',
  linkedUserId: 'account-b', senderUserId: 'user_b', senderDisplayName: 'Bob', body: 'hello', createdAt: '2026-09-12T00:00:00Z', ...override });
const envelope = e => ({ kind: 'msg', worldId: 'r:one', cursor: e.id, event: e });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const frames = [], blocked = new Set();
  const deps = { resolve: jest.fn(async () => ({ status: 'ready', binding })), history: jest.fn(async () => []), sendMessage: jest.fn(async () => event()) };
  const bridge = new BridgeConnection('account-a', frame => frames.push(frame), () => blocked, deps);
  return { frames, deps, bridge, blocked, rows: () => frames.flatMap(f => f.payload.messages ?? []) };
}
test('does not subscribe without an authenticated socket watch', async () => {
  const s = setup(); await s.bridge.receive(envelope(event()));
  expect(s.frames).toEqual([]); expect(s.deps.resolve).not.toHaveBeenCalled();
});
test('initial state precedes history and duplicate history/live frames render once', async () => {
  const s = setup(); s.deps.history.mockResolvedValue([event(), event()]);
  await s.bridge.watch(); await s.bridge.receive(envelope(event())); await s.bridge.watch();
  expect(s.frames[0].type).toBe('bridge:state'); expect(s.rows()).toHaveLength(1);
  expect(s.rows()[0]).toMatchObject({ id: 'server:r:one:1', channelId: 'server:r:one', userId: 'account-b' });
});
test('live delivery waits for history and does not duplicate an overlapping row', async () => {
  const s = setup(), gate = deferred(); s.deps.history.mockReturnValueOnce(gate.promise);
  const watch = s.bridge.watch(); await new Promise(setImmediate);
  const live = s.bridge.receive(envelope(event())); gate.resolve([event()]);
  await Promise.all([watch, live]); expect(s.rows()).toHaveLength(1);
});
test('same-text distinct IDs survive and out-of-order missed delivery is recovered', async () => {
  const s = setup(); await s.bridge.watch(); await s.bridge.receive(envelope(event(2)));
  s.deps.history.mockResolvedValue([event(1), event(2)]); await s.bridge.watch();
  expect(s.rows().map(r => r.id)).toEqual(['server:r:one:2', 'server:r:one:1']);
});
test('room change during snapshot discards old-room history', async () => {
  const s = setup(), gate = deferred(); s.deps.history.mockReturnValueOnce(gate.promise);
  const work = s.bridge.watch(); await new Promise(setImmediate);
  s.deps.resolve.mockResolvedValue({ status: 'ready', binding: { ...binding, room: 'r:two', requestId: 'two' } });
  gate.resolve([event()]); await work;
  expect(s.rows()).toEqual([]); expect(s.frames.at(-1).payload.channelId).toBe('server:r:two');
});
test.each(['inactive', 'ambiguous'])('%s lease removes access before live delivery', async status => {
  const s = setup(); await s.bridge.watch(); s.deps.resolve.mockResolvedValue({ status });
  await s.bridge.receive(envelope(event())); expect(s.rows()).toEqual([]);
  expect(s.frames.at(-1)).toEqual({ type: 'bridge:state', payload: { status } });
});
test('foreign rooms, forged IDs and legacy events without account attribution are excluded', async () => {
  const s = setup(); s.deps.history.mockResolvedValue([event(1, { messageId: 'server:r:foreign:1' }), event(2, { linkedUserId: undefined })]);
  await s.bridge.watch(); await s.bridge.receive({ ...envelope(event()), worldId: 'r:foreign' });
  expect(s.rows()).toEqual([]);
});
test('blocks apply to both history and live, including after a block change', async () => {
  const s = setup(); s.blocked.add('account-b'); s.deps.history.mockResolvedValue([event()]);
  await s.bridge.watch(); await s.bridge.receive(envelope(event(2))); expect(s.rows()).toEqual([]);
});
test('stale client room/nonce cannot send, and accepted sends have one publication path', async () => {
  const s = setup(); await s.bridge.watch();
  await s.bridge.send('server:r:one', 'stale', 'hello'); await s.bridge.send('server:r:foreign', bridgeBindingId(binding), 'hello');
  expect(s.deps.sendMessage).not.toHaveBeenCalled();
  await s.bridge.send('server:r:one', bridgeBindingId(binding), 'hello');
  expect(s.deps.sendMessage).toHaveBeenCalledTimes(1); expect(s.rows()).toEqual([]);
  const guard = s.deps.sendMessage.mock.calls[0][3]; s.deps.resolve.mockResolvedValue({ status: 'inactive' });
  expect(await guard()).toBe(false);
});
test('storage errors fail closed and a later watch can recover', async () => {
  const s = setup(); await s.bridge.watch(); s.deps.resolve.mockRejectedValueOnce(new Error('offline'));
  await s.bridge.receive(envelope(event())); expect(s.frames.at(-1).payload.status).toBe('unavailable');
  await s.bridge.watch(); expect(s.frames.at(-2).payload.status).toBe('ready');
});
test('disposed connection cannot emit a pending snapshot', async () => {
  const s = setup(), gate = deferred(); s.deps.history.mockReturnValueOnce(gate.promise);
  const work = s.bridge.watch(); await new Promise(setImmediate); const count = s.frames.length;
  s.bridge.dispose(); gate.resolve([event()]); await work;
  expect(s.frames).toHaveLength(count);
});
