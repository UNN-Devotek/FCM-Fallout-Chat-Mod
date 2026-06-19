'use strict';
// express-session requires a non-empty secret; set before server.ts is loaded.
process.env.SESSION_SECRET = 'test-secret-for-jest';

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
  pool: { on: jest.fn() },
}));
// Load-bearing: server.ts applies a global `apiLimiter` to all /api/ routes
// backed by rate-limit-redis's RedisStore. Its real `increment` runs a Lua
// script and rejects the redis mock's plain string reply, 500-ing before the
// 404 handler is reached. This mock stubs the store so requests pass through.
jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    decrement: jest.fn().mockResolvedValue(undefined),
    resetKey: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    localKeys: true,
  })),
}));
// Redis mock — `session:<token>` resolves to a userId so the real WS connect
// handler passes token auth; everything else returns null/OK. Used by both the
// route test (via server.ts) and the real handleConnection() WS test below.
const TEST_TOKEN = 'test-session-token';
const TEST_USER_ID = 'user-1234';
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockImplementation(async (key) => (key === 'session:test-session-token' ? 'user-1234' : null)),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1), ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined), on: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue('OK'),
  }),
  getSubscriberClient: jest.fn().mockResolvedValue({
    subscribe: jest.fn().mockResolvedValue(undefined), on: jest.fn(),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
}));
// Prisma mock — the real handleConnection() loads the user via
// prisma.user.findUnique before reaching the telemetry emit. Return a clean,
// non-banned, non-muted user so the handler walks all the way to the emit.
jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1234', username: 'tester', discordId: null,
        discordUsername: null, discordDisplayName: null, installToken: null,
        isBanned: false, isMuted: false, muteExpiresAt: null, muteReason: null,
        muteCategory: null, bannedUntil: null, banCategory: null, banReason: null,
        kickedUntil: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));
// Services the connect handler lazily require()s before the telemetry emit.
jest.mock('../src/services/blockService', () => ({
  getBlockedIds: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../src/services/userRoleService', () => ({
  getEffectiveRole: jest.fn().mockResolvedValue('user'),
  isPrivilegedRole: jest.fn().mockReturnValue(false),
}));

const { WebSocket } = require('ws');
const { EventEmitter } = require('events');

// ── Helpers ───────────────────────────────────────────────────────────────────

// A recording WebSocket double: a real EventEmitter (so the handler's
// on/once/removeListener/emit calls work) that also records every frame sent
// and reports itself OPEN. We assert the connect-time frames the handler pushes.
function makeRecordingWs() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.sentMessages = [];
  ws.send = (msg) => { ws.sentMessages.push(msg); };
  ws.close = () => {};
  ws.ping = () => {};
  ws.terminate = () => {};
  return ws;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Telemetry control removed', () => {
  it('GET /api/admin/telemetry is no longer registered (404)', async () => {
    const { app } = require('../src/server');
    const res = await request(app).get('/api/admin/telemetry');
    expect(res.status).toBe(404);
  });

  it('broadcastTelemetrySet is no longer exported from handlers', () => {
    const handlers = require('../src/websocket/handlers');
    expect(handlers.broadcastTelemetrySet).toBeUndefined();
  });

  it('real WS connect emits telemetry:set { enabled: false } kill-switch frame', async () => {
    // Exercises the ACTUAL handleConnection() code path (not a re-implemented
    // simulation): a reverting change (DB lookup, or a flag defaulting to true)
    // would fail this test.
    const { handleConnection } = require('../src/websocket/handlers');
    const ws = makeRecordingWs();
    const req = { url: '/', headers: { 'x-auth-token': TEST_TOKEN } };

    await handleConnection(ws, req);

    const frames = ws.sentMessages.map((m) => JSON.parse(m));
    const telemetryFrame = frames.find((f) => f.type === 'telemetry:set');
    expect(telemetryFrame).toBeDefined();
    expect(telemetryFrame.payload).toEqual({ enabled: false });

    // Tear down: the handler registered a heartbeat setInterval cleared by the
    // 'close' handler — fire it so no timer leaks past the test.
    ws.readyState = WebSocket.CLOSED;
    ws.emit('close');
  });
});
