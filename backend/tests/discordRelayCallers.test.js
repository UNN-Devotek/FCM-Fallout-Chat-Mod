const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
let mockDirectory, mockTicket, mockRedis, mockUser, runtime, sockets;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: {
  NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory, QA_BUILD_LOCK: false,
} }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  channel: { findFirst: jest.fn(async () => ({ id: 'a2000000-0000-4000-8000-000000000002', name: 'General', parentId: null })) },
  user: { findFirst: jest.fn(async () => mockUser), findUnique: jest.fn(async () => mockUser) },
  message: { create: jest.fn() },
} }));
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => mockRedis }));
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../src/services/discordService', () => ({ relayToDiscord: jest.fn(async () => {}), invalidateRelayMappingsCache() {} }));
jest.mock('../src/queues/messagePersist', () => ({ add: jest.fn(async () => ({})) }));
jest.mock('../src/services/messageService', () => ({ persistMessage: jest.fn(async () => {}) }));
jest.mock('../src/services/ingestMessage', () => ({ finalizeMessage: jest.fn(async () => {}) }));
jest.mock('../src/services/cosmetics/cosmeticsService', () => ({ attachCosmetics: jest.fn(async () => {}), attachCosmeticsToHistory: jest.fn(async () => {}) }));
jest.mock('../src/controllers/healthController', () => ({ incrementMessageCount() {}, removeFullscreenClient() {} }));
jest.mock('../src/services/commandService', () => ({ tryHandleCommand: jest.fn(async () => ({
  handled: true, actionType: 'relay', targetChannelId: 'a2000000-0000-4000-8000-000000000002',
  relayContent: 'canonical command publication', relayToDiscord: true,
})) }));
jest.mock('../src/services/autoModEngine', () => ({ engineEvaluate: async () => ({ block: false }) }));
jest.mock('../src/websocket/chatSlowmode', () => ({ rejectChatSlowmode: async () => false, rejectCommandSlowmode: async () => false }));
jest.mock('../src/services/blockService', () => ({ getBlockedIds: async () => new Set() }));
jest.mock('../src/services/userRoleService', () => ({ getEffectiveRole: async () => 'user', isPrivilegedRole: role => ['admin', 'moderator', 'owner'].includes(role) }));
jest.mock('../src/services/latestReleaseVersion', () => ({ getLatestVersion: () => null }));
jest.mock('../src/services/onlinePresenceService', () => ({ registerLocalPresenceSource() {}, noteUserConnected() {},
  noteUserDisconnected() {}, noteUserPendingDisconnect() {}, notePendingDisconnectSuppressed() {}, getLocalOnlineUserIds: () => [],
}));
jest.mock('../src/services/relay/relayLiveFanout', () => ({ notifyRelayLiveChatMessage: async () => {} }));
jest.mock('../src/services/privateMessagingService', () => ({}));
jest.mock('../src/services/messageEditService', () => ({}));
jest.mock('../src/websocket/bridgeConnection', () => ({ BridgeConnection: class { dispose() {} } }));
jest.mock('../src/services/relay/localExportBridge', () => ({}));
jest.mock('../src/websocket/serverModerationConnection', () => ({ ServerModerationConnection: class { dispose() {} } }));
jest.mock('../src/websocket/serverModerationAuthorization', () => ({}));
jest.mock('../src/services/relay/serverModeration', () => ({}));

const channelId = 'a2000000-0000-4000-8000-000000000002';
class LocalSocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames = [];
  send(text, callback) { this.frames.push(JSON.parse(text)); callback?.(); }
  close() { this.readyState = 3; this.emit('close'); }
}
beforeEach(() => {
  jest.resetModules();
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-relay-callers-')); sockets = [];
  mockUser = { id: 'a2000000-0000-4000-8000-000000000003', username: 'FixtureAuthor', discordId: '100000000000000003', isMuted: false, isBanned: false };
  mockRedis = { get: jest.fn(async () => JSON.stringify(mockTicket)), del: jest.fn(async () => 1), publish: jest.fn(async () => 0),
    multi: () => ({ zRemRangeByScore() { return this; }, zAdd() { return this; }, zCard() { return this; },
      expire() { return this; }, exec: async () => [0, 1, 1, 1] }),
  };
  runtime = require('../src/runtime').runtime;
});
afterEach(async () => {
  for (const socket of sockets) socket.close();
  runtime.freeze('fixture teardown'); await new Promise(resolve => setImmediate(resolve));
  runtime.disposeForTests(); delete global.broadcast;
  fs.rmSync(mockDirectory, { recursive: true, force: true });
});

test('the actual live-only REST caller relays its generated UUID/time and still creates no history row', async () => {
  const express = require('express'), request = require('supertest');
  const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
  const { createMessage } = require('../src/controllers/messagesController');
  const { relayToDiscord } = require('../src/services/discordService');
  const app = express(); app.use(accountHttpIngress(runtime)); app.use(express.json());
  app.use((req, _res, next) => { req.adminUser = { username: 'FixtureAuthor' }; next(); });
  app.post('/api/messages', createMessage); instrumentHttpHandlers(app, runtime);
  global.broadcast = jest.fn();
  const response = await request(app).post('/api/messages').send({ channelId, content: '  live-only publication  ' });
  expect(response.status).toBe(201);
  const payload = global.broadcast.mock.calls[0][0].payload;
  expect(payload.id).toBe(response.body.data.id);
  expect(payload.id).toMatch(/^[a-f0-9-]{36}$/); expect(Number.isFinite(Date.parse(payload.timestamp))).toBe(true);
  expect(relayToDiscord).toHaveBeenCalledWith(channelId, 'FixtureAuthor', 'live-only publication', undefined,
    undefined, undefined, payload.id, undefined, payload.timestamp);
  expect(require('../src/config/prisma').default.message.create).not.toHaveBeenCalled();
  expect(require('../src/queues/messagePersist').add).not.toHaveBeenCalled();
  runtime.freeze('fixture');
  const denied = await request(app).post('/api/messages').send({ channelId, content: 'new work' });
  expect(denied.status).toBe(503); expect(relayToDiscord).toHaveBeenCalledTimes(1); expect(global.broadcast).toHaveBeenCalledTimes(1);
});

test.each(['admin', 'command'])('the actual %s WS caller relays the same generated canonical UUID/time as its queued record and broadcast', async mode => {
  mockTicket = mode === 'admin'
    ? { type: 'admin', discordId: mockUser.discordId, username: 'FixtureAuthor', role: 'admin' }
    : { type: 'web', userId: mockUser.id };
  const { handleConnection } = require('../src/websocket/handlers');
  const { relayToDiscord } = require('../src/services/discordService');
  let relayed; const observed = new Promise(resolve => { relayed = resolve; });
  relayToDiscord.mockImplementation(async () => { relayed(); });
  const ws = new LocalSocket(); sockets.push(ws);
  await handleConnection(ws, { url: '/?ticket=single-use-synthetic-ticket', headers: {} });
  expect(ws.readyState).toBe(1);
  ws.emit('message', JSON.stringify({ type: 'chat:send', payload: { channelId,
    content: mode === 'admin' ? 'ordinary admin publication' : '/event fixture' } }));
  await observed;
  const record = require('../src/queues/messagePersist').add.mock.calls[0][0];
  const payload = ws.frames.find(frame => frame.type === 'chat:message').payload;
  expect(record.id).toBe(payload.id); expect(record.createdAt).toBe(payload.timestamp);
  const args = relayToDiscord.mock.calls[0];
  expect(args[6]).toBe(record.id); expect(args[8]).toBe(record.createdAt);
  expect(record.id).toMatch(/^[a-f0-9-]{36}$/); expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true);
  expect(require('../src/config/logger').default.error).not.toHaveBeenCalled();
  runtime.freeze('fixture');
  ws.emit('message', JSON.stringify({ type: 'chat:send', payload: { channelId, content: 'new work' } }));
  expect(relayToDiscord).toHaveBeenCalledTimes(1); expect(ws.frames.at(-1)).toMatchObject({ type: 'error', payload: { code: 'maintenance' } });
});
