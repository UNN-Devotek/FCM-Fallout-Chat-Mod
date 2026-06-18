'use strict';

/**
 * Tests for POST /api/admin/telemetry userId UUID validation.
 *
 * Verified:
 *   (a) scope=user with a valid UUID is accepted (200).
 *   (b) scope=user with a non-UUID string is rejected (400).
 *   (c) scope=user with an empty string is rejected (400).
 *   (d) scope=user with a missing userId is rejected (400).
 *   (e) scope=global with no userId is accepted (200).
 */

const request = require('supertest');
const express = require('express');

// ── Infrastructure mocks ──────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn(),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

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

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

// ── Service mocks ─────────────────────────────────────────────────────────────

jest.mock('../src/services/telemetryService', () => ({
  getTelemetryAdminView: jest.fn().mockResolvedValue([]),
  setTelemetry: jest.fn().mockResolvedValue({ scope: 'global', enabled: true }),
}));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  process.env.ADMIN_API_KEY = 'test-admin-key';
  process.env.ADMIN_ROLE_ID = 'test-role-id';

  const telemetryRouter = require('../src/routes/adminTelemetry');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  // Bypass Discord role middleware for unit testing the validation logic
  app.use('/api/admin/telemetry', (req, _res, next) => {
    req.user = { id: 'admin', roles: ['test-role-id'] };
    next();
  }, telemetryRouter);
  app.use(errorHandler);
  return app;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let app;

beforeEach(() => {
  jest.resetModules();
  app = buildApp();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/admin/telemetry userId validation', () => {
  it('accepts scope=user with a valid UUID', async () => {
    const res = await request(app)
      .post('/api/admin/telemetry')
      .set('x-api-key', 'test-admin-key')
      .send({ scope: 'user', userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', enabled: true });
    expect(res.status).toBe(200);
  });

  it('rejects scope=user with a non-UUID string', async () => {
    const res = await request(app)
      .post('/api/admin/telemetry')
      .set('x-api-key', 'test-admin-key')
      .send({ scope: 'user', userId: 'not-a-uuid', enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/i);
  });

  it('rejects scope=user with an empty userId', async () => {
    const res = await request(app)
      .post('/api/admin/telemetry')
      .set('x-api-key', 'test-admin-key')
      .send({ scope: 'user', userId: '', enabled: true });
    expect(res.status).toBe(400);
  });

  it('rejects scope=user with no userId', async () => {
    const res = await request(app)
      .post('/api/admin/telemetry')
      .set('x-api-key', 'test-admin-key')
      .send({ scope: 'user', enabled: true });
    expect(res.status).toBe(400);
  });

  it('accepts scope=global with no userId', async () => {
    const res = await request(app)
      .post('/api/admin/telemetry')
      .set('x-api-key', 'test-admin-key')
      .send({ scope: 'global', enabled: false });
    expect(res.status).toBe(200);
  });
});
