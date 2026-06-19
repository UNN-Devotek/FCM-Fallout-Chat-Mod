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

const { app } = require('../src/server');

describe('Client metrics endpoint removed', () => {
  it('POST /api/client-metrics returns 410 Gone', async () => {
    const res = await request(app).post('/api/client-metrics').send({ source: 'overlay' });
    expect(res.status).toBe(410);
  });
  it('GET /api/admin/client-metrics is no longer registered (404)', async () => {
    const res = await request(app).get('/api/admin/client-metrics');
    expect(res.status).toBe(404);
  });
});
