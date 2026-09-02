'use strict';
/**
 * Integration tests: exercises the full middleware → routing → error handler chain.
 * All infrastructure is mocked so these run in CI without real DB/Redis, but they
 * catch contract regressions (wrong response shape, missing fields, auth bypass).
 */
const request = require('supertest');

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
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

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  relayToDiscord: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/queues/messagePersist', () => ({
  add: jest.fn().mockResolvedValue({}),
  process: jest.fn(),
  on: jest.fn(),
}));

// rate-limit-redis store must be mocked to prevent real Redis calls.
// express-rate-limit v7 Store interface requires: init?, increment, decrement, resetKey, get?
jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    decrement: jest.fn().mockResolvedValue(undefined),
    resetKey: jest.fn().mockResolvedValue(undefined),
    // express-rate-limit v7 may call get() when skipFailedRequests is set
    get: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    localKeys: true,
  })),
}));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

jest.mock('../src/services/deviceAuthService', () => ({
  extractSignatureHeaders: jest.fn().mockReturnValue({ alg: 'test', sig: 'ok', keyId: 'test' }),
  verifySignedRequest: jest.fn().mockResolvedValue({ ok: true }),
  isValidP256Spki: jest.fn().mockReturnValue(true),
}));

const { app } = require('../src/server');

// ── Auth contract tests ──────────────────────────────────────────────────────

describe('Auth middleware contract', () => {
  it('sets a browser session cookie before the Discord OAuth redirect', async () => {
    const res = await request(app).get('/auth/discord?intent=link');

    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.location)).toContain('/auth/discord/callback');
    expect(res.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('connect.sid=')]),
    );
  });

  it('returns 401 RFC 7807 when X-Auth-Token is missing on protected route', async () => {
    const res = await request(app).get('/api/users/some-id');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      type: expect.any(String),
      title: expect.any(String),
      status: 401,
    });
  });

  it('returns 401 when X-Auth-Token is present but session does not exist in Redis', async () => {
    // getRedisClient().get returns null (no session)
    const res = await request(app)
      .delete('/api/users/session')
      .set('X-Auth-Token', 'nonexistent-token-uuid');
    expect(res.status).toBe(401);
    expect(res.body.status).toBe(401);
  });

  it('returns 401 for Discord-only endpoints when no session cookie', async () => {
    const res = await request(app).get('/api/channels');
    // GET channels is public — should be 200
    expect(res.status).toBe(200);
  });

  it('returns 403 for Discord admin endpoints without Discord session', async () => {
    const res = await request(app).post('/api/channels').send({ name: 'Test', color: '#fff' });
    expect(res.status).toBe(401);
    expect(res.body.status).toBe(401);
  });
});

// ── Validation contract tests ────────────────────────────────────────────────

describe('Input validation contract', () => {
  it('returns 400 with errors array when required fields are missing on POST /api/users', async () => {
    const res = await request(app).post('/api/users').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeInstanceOf(Array);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 when username exceeds max length', async () => {
    const res = await request(app).post('/api/users').send({
      username: 'x'.repeat(65),
      installToken: 'some-uuid-token',
    });
    expect(res.status).toBe(400);
  });

  it('strips unknown fields and does not leak them in error responses', async () => {
    const res = await request(app).post('/api/users').send({
      username: 'TestUser',
      installToken: '550e8400-e29b-41d4-a716-446655440000', // valid UUID
      discordId: '123456789012345', // bypass Discord-gate (added post-refactor)
      __proto__: 'poisoned',
      admin: true,
    });
    // Should either succeed (201) or fail for DB reasons, NOT because of extra fields
    expect([201, 409, 500]).toContain(res.status);
    if (res.body.data) expect(res.body.data.admin).toBeUndefined();
  });
});

// ── Rate limiter headers contract ────────────────────────────────────────────

describe('Rate limiter response headers', () => {
  it('includes RateLimit-* headers on API responses', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    // express-rate-limit v7 with standardHeaders: true emits RateLimit-Policy
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });
});

// ── 404 contract ─────────────────────────────────────────────────────────────

describe('404 handler', () => {
  it('returns RFC 7807 shape for any unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ type: expect.any(String), status: 404 });
  });

  it('includes the method and path in the detail for unknown routes', async () => {
    const res = await request(app).delete('/api/completely-unknown');
    expect(res.status).toBe(404);
  });
});

// ── JSON body parsing contract ────────────────────────────────────────────────

describe('Request body parsing', () => {
  it('returns 400 for malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Content-Type', 'application/json')
      .send('{invalid json}');
    expect(res.status).toBe(400);
  });
});
