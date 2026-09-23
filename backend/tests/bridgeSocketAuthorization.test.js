const { EventEmitter } = require('events');
const { readFileSync } = require('node:fs');
const { WebSocket } = require('ws');
const store = new Map();
const redis = {
  get: jest.fn(async key => store.get(key) ?? null), del: jest.fn(async key => store.delete(key)),
  set: jest.fn(async () => 'OK'), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1),
  on: jest.fn(), publish: jest.fn(async () => 1), sendCommand: jest.fn(async () => 'OK'),
};
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis,
  getSubscriberClient: async () => ({ subscribe: jest.fn(), on: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), pool: { on: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  user: { findUnique: jest.fn(async () => ({ id: 'account-a', username: 'Alice', isBanned: false, isMuted: false })) },
} }));
jest.mock('../src/services/blockService', () => ({ getBlockedIds: jest.fn(async () => new Set()) }));
jest.mock('../src/services/commandService', () => ({ tryHandleCommand: jest.fn(async () => null) }));
jest.mock('../src/controllers/healthController', () => ({ incrementMessageCount: jest.fn(), setFullscreenStatus: jest.fn(), removeFullscreenClient: jest.fn() }));
jest.mock('../src/services/onlinePresenceService', () => ({
  getGlobalOnlineCount: jest.fn(async () => 17), getLocalOnlineUserIds: () => [],
  registerLocalPresenceSource: jest.fn(), noteUserConnected: jest.fn(), noteUserDisconnected: jest.fn(),
  noteUserPendingDisconnect: jest.fn(), notePendingDisconnectSuppressed: jest.fn(),
}));
jest.mock('../src/services/userRoleService', () => ({ getEffectiveRole: jest.fn(async () => 'user'), isPrivilegedRole: jest.fn(() => false) }));
const instances = [];
jest.mock('../src/websocket/bridgeConnection', () => ({ BridgeConnection: class {
  constructor(...args) { this.args = args; this.watch = jest.fn(); this.pairNative = jest.fn(); this.observe = jest.fn(); this.leave = jest.fn(); this.dispose = jest.fn(); this.observedPlayerStats = jest.fn(async () => ({ bindingId: null, observedPlayers: null })); instances.push(this); }
} }));
jest.mock('../src/services/relay/localExportBridge', () => ({
  BRIDGE_LEAVE_REASONS: ['observation_timeout', 'game_exit', 'main_menu', 'explicit_inactive', 'account_change',
    'socket_replaced', 'app_quit', 'invalid_export', 'provider_conflict'],
  isBridgeLeaveReason: value => ['observation_timeout', 'game_exit', 'main_menu', 'explicit_inactive', 'account_change',
    'socket_replaced', 'app_quit', 'invalid_export', 'provider_conflict'].includes(value),
  LocalExportBridge: class { constructor(...args) { this.args = args; } },
}));
// Imported services own maintenance intervals; keep them test-owned from import.
jest.useFakeTimers();
const { handleConnection } = require('../src/websocket/handlers');
const sockets = [];
test('presence counts require live desktop session and ignore client room authority', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' });
  const bridge = instances.at(-1);
  await control(ws, 'presence:stats', { requestId: 'one', room: 'forged' });
  expect(bridge.observedPlayerStats).toHaveBeenCalledWith();
  expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(f => f.type === 'presence:stats').payload)
    .toMatchObject({ requestId: 'one', bindingId: null, observedPlayers: null });
  store.delete('session:desktop-token'); await control(ws, 'presence:stats', { requestId: 'two' });
  expect(bridge.observedPlayerStats).toHaveBeenCalledTimes(1);
});
test('presence counts reject browser tickets, invalid request IDs and superseded sockets', async () => {
  const old = await connect('/', { 'x-auth-token': 'desktop-token' }); const oldBridge = instances.at(-1);
  const next = await connect('/', { 'x-auth-token': 'desktop-token' }); const nextBridge = instances.at(-1);
  await control(old, 'presence:stats', { requestId: 'valid' });
  await control(next, 'presence:stats', { requestId: 'x'.repeat(65) });
  expect(oldBridge.observedPlayerStats).not.toHaveBeenCalled(); expect(nextBridge.observedPlayerStats).not.toHaveBeenCalled();
  store.set('ws_ticket:browser', JSON.stringify({ type: 'web', userId: '10000000-0000-4000-8000-000000000001' }));
  const browser = await connect('/?ticket=browser'); const browserBridge = instances.at(-1);
  await control(browser, 'presence:stats', { requestId: 'valid' }); expect(browserBridge.observedPlayerStats).not.toHaveBeenCalled();
});
test('presence requests are rate bounded and expire before reply', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' }); const bridge = instances.at(-1);
  let count = 0;
  redis.incr.mockImplementation(async key => key.startsWith('rl_ws:presence-stats:') ? ++count : 1);
  try {
    for (let i = 0; i < 9; i++) await control(ws, 'presence:stats', { requestId: String(i) });
    expect(bridge.observedPlayerStats).toHaveBeenCalledTimes(4);
  } finally { redis.incr.mockImplementation(async () => 1); }
  bridge.observedPlayerStats.mockImplementation(async () => { store.delete('session:desktop-token'); return { bindingId: null, observedPlayers: null }; });
  const before = ws.send.mock.calls.length;
  await control(ws, 'presence:stats', { requestId: 'expired-during-read' });
  expect(ws.send.mock.calls.length).toBe(before);
});
test('chat receipt diagnostics never include raw message text, account or room identifiers', () => {
  const source = readFileSync(require.resolve('../src/websocket/handlers'), 'utf8');
  const diagnostic = source.slice(source.lastIndexOf('logger.info({', source.indexOf("}, '[chat:send] received')")), source.indexOf("}, '[chat:send] received')"));
  expect(diagnostic).toContain('contentLength:');
  expect(diagnostic).not.toMatch(/\b(userId|username|channelId|content)\s*:/);
});
async function connect(url, headers = {}) {
  const ws = new EventEmitter(); ws.readyState = WebSocket.OPEN;
  ws.send = jest.fn(); ws.close = jest.fn(); ws.ping = jest.fn(); ws.terminate = jest.fn();
  sockets.push(ws); await handleConnection(ws, { url, headers }); return ws;
}
async function control(ws, type, payload) {
  for (const listener of ws.listeners('message')) await listener(Buffer.from(JSON.stringify({ type, payload })));
}
beforeEach(() => { jest.useFakeTimers(); store.clear(); instances.length = 0; store.set('session:desktop-token', 'account-a'); });
afterEach(() => { for (const ws of sockets.splice(0)) { ws.readyState = WebSocket.CLOSED; ws.emit('close'); } jest.clearAllTimers(); jest.useRealTimers(); });

test('only header-authenticated desktop gets local authority and accepts new controls', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' });
  const bridge = instances.at(-1), payload = { schemaVersion: 1 };
  expect(bridge.args[4].args.slice(0, 2)).toEqual(['account-a', 'desktop-token']);
  await control(ws, 'bridge:observe', payload);
  expect(bridge.observe).not.toHaveBeenCalled();
  expect(bridge.args[4].args[3]()).toBe(false);
  await control(ws, 'client:status', { inGame: true });
  await control(ws, 'bridge:watch', { mode: 'local-export' });
  await control(ws, 'bridge:observe', payload); await control(ws, 'bridge:leave', { reason: 'observation_timeout' });
  expect(bridge.watch).toHaveBeenCalledWith('local-export'); expect(bridge.observe).toHaveBeenCalledWith(payload, expect.any(Number));
  expect(bridge.leave).toHaveBeenCalledWith('observation_timeout');
  await control(ws, 'client:status', { inGame: false });
  expect(bridge.leave).toHaveBeenLastCalledWith('game_exit');
  expect(bridge.args[4].args[3]()).toBe(false);
  await control(ws, 'bridge:observe', payload);
  expect(bridge.observe).toHaveBeenCalledTimes(1);
});

test('unknown leave reasons fail closed as explicit inactive', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' });
  const bridge = instances.at(-1);
  await control(ws, 'bridge:leave', { reason: 'forged-soft-reason' });
  expect(bridge.leave).toHaveBeenCalledWith('explicit_inactive');
});

test('legacy bridge leaves without a reason use the bounded observation timeout', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' });
  const bridge = instances.at(-1);
  await control(ws, 'bridge:leave', {});
  expect(bridge.leave).toHaveBeenCalledWith('observation_timeout');
});

test('browser tickets cannot activate legacy or local bridge controls', async () => {
  store.set('ws_ticket:browser', JSON.stringify({ type: 'web', userId: '10000000-0000-4000-8000-000000000001' }));
  const ws = await connect('/?ticket=browser'); const bridge = instances.at(-1);
  expect(bridge.args[4]).toBeUndefined();
  await control(ws, 'bridge:watch', {}); await control(ws, 'bridge:watch', { mode: 'local-export' });
  await control(ws, 'bridge:observe', {}); await control(ws, 'bridge:leave', {});
  await control(ws, 'bridge:native-pair', { sessionId: 'forged' });
  expect(bridge.pairNative).not.toHaveBeenCalled();
  expect(bridge.watch).not.toHaveBeenCalled(); expect(bridge.observe).not.toHaveBeenCalled(); expect(bridge.leave).not.toHaveBeenCalled();
});

test('native pairing requires the current in-game desktop socket', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' }); const bridge = instances.at(-1);
  await control(ws, 'bridge:native-pair', { sessionId: 'test-session' });
  expect(bridge.pairNative).not.toHaveBeenCalled();
  await control(ws, 'client:status', { inGame: true });
  await control(ws, 'bridge:native-pair', { sessionId: 'test-session' });
  expect(bridge.pairNative).toHaveBeenCalledWith('test-session');
  await connect('/', { 'x-auth-token': 'desktop-token' });
  await control(ws, 'bridge:native-pair', { sessionId: 'old-session' });
  expect(bridge.pairNative).toHaveBeenCalledTimes(1);
});

test('public unauthenticated socket and admin observers never get bridge authority', async () => {
  const publicSocket = await connect('/'); expect(publicSocket.close).toHaveBeenCalled();
  store.set('ws_ticket:admin', 'admin'); const admin = await connect('/?ticket=admin');
  await control(admin, 'bridge:watch', { mode: 'local-export' }); await control(admin, 'bridge:observe', {});
  expect(instances).toHaveLength(0);
});

test('superseded socket cannot mutate newer socket membership', async () => {
  const old = await connect('/', { 'x-auth-token': 'desktop-token' }); const first = instances.at(-1);
  const fresh = await connect('/', { 'x-auth-token': 'desktop-token' }); const second = instances.at(-1);
  expect(first.dispose).toHaveBeenCalledTimes(1);
  await control(old, 'bridge:observe', {}); await control(old, 'bridge:leave', {});
  expect(first.observe).not.toHaveBeenCalled(); expect(first.leave).not.toHaveBeenCalled();
  await control(fresh, 'client:status', { inGame: true });
  await control(fresh, 'bridge:observe', {}); expect(second.observe).toHaveBeenCalledTimes(1);
});

test('observation flood is bounded before dispatch to the room coordinator', async () => {
  const ws = await connect('/', { 'x-auth-token': 'desktop-token' });
  await control(ws, 'client:status', { inGame: true });
  let count = 0;
  redis.incr.mockImplementation(async key => key.startsWith('rl_ws:bridge-observe:') ? ++count : 1);
  try {
    for (let index = 0; index < 25; index++) await control(ws, 'bridge:observe', { sequence: index + 1 });
    expect(instances.at(-1).observe).toHaveBeenCalledTimes(12);
  } finally { redis.incr.mockImplementation(async () => 1); }
});
