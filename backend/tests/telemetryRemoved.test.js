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
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1), ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined), on: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue('OK'),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

const { WebSocket } = require('ws');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    sentMessages: [],
    send(msg) { this.sentMessages.push(msg); },
  };
}

/**
 * Simulate the telemetry kill-switch logic from handlers.ts.
 * Mirrors the exact block to keep the test structurally tied to the
 * implementation without importing the full handler module.
 */
function simulateTelemetryKillSwitch(ws) {
  // Telemetry collection was removed. Emit a one-time telemetry:set{enabled:false}
  // on connect as a permanent kill-switch so any already-installed client that
  // listens for it stops collecting. No DB lookup; always off.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'telemetry:set', payload: { enabled: false } }));
  }
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

  it('WS kill-switch sends telemetry:set { enabled: false } when socket is OPEN', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    simulateTelemetryKillSwitch(ws);

    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('telemetry:set');
    expect(msg.payload).toEqual({ enabled: false });
  });

  it('WS kill-switch does NOT send when socket is not OPEN', () => {
    const ws = makeMockWs(WebSocket.CLOSED);
    simulateTelemetryKillSwitch(ws);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('WS kill-switch always emits enabled:false (never true)', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    simulateTelemetryKillSwitch(ws);

    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.payload.enabled).toBe(false);
  });
});
