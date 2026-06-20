'use strict';

/**
 * Tests for POST /api/reports self-report block.
 *
 * Verified:
 *   (a) Reporting yourself returns 400.
 *   (b) Reporting a different user proceeds past the self-report check (201).
 *   (c) Reporting yourself with an UPPERCASED copy of your own UUID still returns
 *       400 — the guard must compare case-insensitively (Joi .uuid() accepts
 *       uppercase without normalizing; Postgres canonicalizes to lowercase on insert).
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

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  postModAlert: jest.fn().mockResolvedValue(undefined),
}));

// ── Shared test data ──────────────────────────────────────────────────────────

const REPORTER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const VALID_BODY  = { targetUserId: OTHER_ID, reason: 'Spamming' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const { submitReport } = require('../src/controllers/reportsController');
  const { errorHandler } = require('../src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  // Inject authenticated user — bypasses requireAuth for unit testing the controller logic
  app.use((req, _res, next) => {
    req.user = { id: REPORTER_ID };
    next();
  });
  app.post('/api/reports', submitReport);
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

describe('POST /api/reports self-report block', () => {
  it('returns 400 when reporter and target are the same user', async () => {
    const res = await request(app)
      .post('/api/reports')
      .send({ targetUserId: REPORTER_ID, reason: 'Spamming' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 400 });
  });

  it('passes the self-report check when targeting a different user', async () => {
    // The prisma stub resolves $transaction (invokes the callback) and report.create
    // returns {}, so a non-self report reaches the 201 success path. Asserting the
    // exact status (not just "not 400") also guards against a silent 500.
    const res = await request(app)
      .post('/api/reports')
      .send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('returns 400 when the target is an UPPERCASED copy of the caller\'s own UUID', async () => {
    // Regression guard for the case-sensitivity bypass: req.user.id is lowercase,
    // so a case-sensitive === would let an uppercased self-id slip through.
    const res = await request(app)
      .post('/api/reports')
      .send({ targetUserId: REPORTER_ID.toUpperCase(), reason: 'Spamming' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 400 });
  });
});
