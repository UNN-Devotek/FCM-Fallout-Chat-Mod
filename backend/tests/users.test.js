'use strict';
const request = require('supertest');

// Shared mock for Redis
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue('PONG'),
  connect: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  zRemRangeByScore: jest.fn().mockResolvedValue(0),
  zAdd: jest.fn().mockResolvedValue(1),
  zCard: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  multi: jest.fn().mockReturnValue({
    zRemRangeByScore: jest.fn().mockReturnThis(),
    zAdd: jest.fn().mockReturnThis(),
    zCard: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([0, 1, 1, 1]),
  }),
};

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedis),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
  pool: { on: jest.fn() },
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
}));

jest.mock('../src/queues/messagePersist', () => ({
  add: jest.fn().mockResolvedValue({}),
  process: jest.fn(),
  on: jest.fn(),
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

// Device keypair auth gate — mock so registration tests aren't blocked by it.
jest.mock('../src/services/deviceAuthService', () => ({
  extractSignatureHeaders: jest.fn().mockReturnValue({ alg: 'test', sig: 'ok', keyId: 'test' }),
  verifySignedRequest: jest.fn().mockResolvedValue({ ok: true }),
  isValidP256Spki: jest.fn().mockReturnValue(true),
}));

const { app } = require('../src/server');
const db = require('../src/config/database');
const prismaStub = require('./setup/prisma-stub').default;

describe('POST /api/users', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers a new user and returns userId + token', async () => {
    // Registration now goes through Prisma (not raw db.query).
    // Configure upsert to return a valid user so the response builds correctly.
    prismaStub.user.upsert.mockResolvedValueOnce({
      id: 'user-uuid', username: 'Wanderer76', isBanned: false,
      discordId: '123456789012345', discordUsername: null,
      discordDisplayName: null, discordAvatar: null,
    });

    // Pass discordId in body to bypass the Discord-gate (requires linked account).
    const res = await request(app).post('/api/users').send({
      username: 'Wanderer76',
      installToken: '123e4567-e89b-12d3-a456-426614174000',
      discordId: '123456789012345',
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('userId');
    expect(res.body.data).toHaveProperty('token');
  });

  it('rejects banned user with 403', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'user-uuid', username: 'BadActor', is_banned: true }],
    });

    const res = await request(app).post('/api/users').send({
      username: 'BadActor',
      installToken: '123e4567-e89b-12d3-a456-426614174001',
    });

    expect(res.status).toBe(403);
  });

  it('validates installToken as UUID', async () => {
    const res = await request(app).post('/api/users').send({
      username: 'Bob',
      installToken: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when username missing', async () => {
    const res = await request(app).post('/api/users').send({
      installToken: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(res.status).toBe(400);
  });
});
