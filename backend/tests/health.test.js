'use strict';
const request = require('supertest');

// Mock dependencies before requiring app
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

const { app } = require('../src/server');

describe('GET /api/health', () => {
  it('returns status ok with required fields', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data).toHaveProperty('uptime');
    expect(res.body.data).toHaveProperty('database');
    expect(res.body.data).toHaveProperty('redis');
    expect(res.body.data).toHaveProperty('discord');
    expect(res.body.data).toHaveProperty('websocket_clients');
    expect(res.body.data).toHaveProperty('timestamp');
  });

  it('reports connected when db and redis are healthy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.data.database).toBe('connected');
    expect(res.body.data.redis).toBe('connected');
  });
});

describe('GET /api/version', () => {
  it('returns version info', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('downloadUrl');
  });
});

describe('404 handler', () => {
  it('returns RFC 7807 error for unknown route', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('title');
    expect(res.body.status).toBe(404);
  });
});
