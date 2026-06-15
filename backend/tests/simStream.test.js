'use strict';
/**
 * Tests for the dev-only live fake-chat-stream endpoint:
 *   POST /api/admin/sim/stream  (backend/src/routes/simUsers.ts)
 *
 * Coverage:
 *  - SR-006: the sim surface (incl. /stream) is NOT mounted in production
 *    (NODE_ENV=production) and returns 404.
 *  - Auth: missing / invalid ADMIN_API_KEY → 403.
 *  - Happy path: valid key drips messages through the REAL broadcast path
 *    (handlers.broadcast) at the configured interval and queues persistence.
 *
 * Strategy mirrors users.test.js — every heavy external dep is mocked, and we
 * spy on handlers.broadcast / messagePersist.add to assert the drip reaches the
 * real fan-out path. Fake timers drive the setInterval drip deterministically.
 */

const request = require('supertest');

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  keys: jest.fn().mockResolvedValue([]),
  ping: jest.fn().mockResolvedValue('PONG'),
  connect: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  zCard: jest.fn().mockResolvedValue(0),
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
  __esModule: true,
  default: { add: jest.fn().mockResolvedValue({}), process: jest.fn(), on: jest.fn() },
  add: jest.fn().mockResolvedValue({}),
  process: jest.fn(),
  on: jest.fn(),
}));

// Spy on the real WS fan-out function the route is required to use.
const broadcastSpy = jest.fn();
jest.mock('../src/websocket/handlers', () => ({
  broadcast: broadcastSpy,
  handleConnection: jest.fn(),
  initPubSub: jest.fn(),
  getClientCount: jest.fn().mockReturnValue(0),
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

jest.mock('../src/services/deviceAuthService', () => ({
  extractSignatureHeaders: jest.fn().mockReturnValue({ alg: 'test', sig: 'ok', keyId: 'test' }),
  verifySignedRequest: jest.fn().mockResolvedValue({ ok: true }),
  isValidP256Spki: jest.fn().mockReturnValue(true),
}));

const ADMIN_KEY = 'test-admin-key';

describe('POST /api/admin/sim/stream (dev-only)', () => {
  describe('SR-006 — not mounted in production', () => {
    let prodApp;
    beforeAll(() => {
      jest.resetModules();
      // The test harness loads .env/.env.local with override:true, which pins
      // NODE_ENV=development — and flipping NODE_ENV=production for real would
      // trip environment.ts's prod startup guard (process.exit on missing
      // secrets). So we mock the env module to a production-flavored copy of the
      // real env, with ENABLE_DEV_LOGIN forced ON to prove the gate is the
      // NODE_ENV check (SR-006), not just dev-login being off.
      // environment.ts does `module.exports = env` (no .default), so require()
      // returns the env object directly.
      const realEnv = require('../src/config/environment');
      const prodEnv = { ...realEnv, NODE_ENV: 'production', ENABLE_DEV_LOGIN: true };
      jest.doMock('../src/config/environment', () => ({ __esModule: true, default: prodEnv, ...prodEnv }));
      prodApp = require('../src/server').app;
    });

    afterAll(() => {
      jest.dontMock('../src/config/environment');
      jest.resetModules();
    });

    it('returns 404 for /stream when NODE_ENV=production', async () => {
      const res = await request(prodApp)
        .post('/api/admin/sim/stream')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ count: 1 });
      expect(res.status).toBe(404);
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('returns 404 for /users when NODE_ENV=production', async () => {
      const res = await request(prodApp)
        .post('/api/admin/sim/users')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ count: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe('development', () => {
    let app;
    let prismaStub;
    let adminKey;
    beforeAll(() => {
      jest.resetModules();
      process.env.NODE_ENV = 'development';
      process.env.ENABLE_DEV_LOGIN = 'true';
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      app = require('../src/server').app;
      prismaStub = require('../src/config/prisma').default;
      // environment.ts loads .env/.env.local with override:true, so the
      // effective key may differ from process.env — read the loaded value.
      adminKey = require('../src/config/environment').ADMIN_API_KEY;
    });

    beforeEach(() => {
      broadcastSpy.mockClear();
      prismaStub.user.findMany.mockResolvedValue([
        { id: 'sim-user-1', username: 'RaiderQueen76' },
        { id: 'sim-user-2', username: 'NukaColaDrinker' },
      ]);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('rejects a missing ADMIN_API_KEY with 403', async () => {
      const res = await request(app).post('/api/admin/sim/stream').send({ count: 1 });
      expect(res.status).toBe(403);
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('rejects an invalid ADMIN_API_KEY with 403', async () => {
      const res = await request(app)
        .post('/api/admin/sim/stream')
        .set('Authorization', 'Bearer wrong-key')
        .send({ count: 1 });
      expect(res.status).toBe(403);
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('starts the drip and broadcasts count messages via the real path', async () => {
      jest.useFakeTimers();
      const messagePersist = require('../src/queues/messagePersist');

      const res = await request(app)
        .post('/api/admin/sim/stream')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ count: 3, intervalMs: 500 });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ started: true, count: 3, intervalMs: 500 });
      expect(res.body.data.channelId).toBe('00000000-0000-0000-0000-000000000001');

      // Drive the setInterval drip to completion.
      jest.advanceTimersByTime(500 * 3);
      await Promise.resolve();

      expect(broadcastSpy).toHaveBeenCalledTimes(3);
      const frame = broadcastSpy.mock.calls[0][0];
      expect(frame.type).toBe('chat:message');
      expect(frame.payload).toMatchObject({ source: 'game', isSim: true });
      expect(typeof frame.payload.content).toBe('string');
      expect(frame.payload.content.length).toBeGreaterThan(0);
      expect(['RaiderQueen76', 'NukaColaDrinker']).toContain(frame.payload.username);

      // Persistence queued for each drip (write-behind, same as real path).
      // Route imports the default export (`import messageQueue from ...`).
      expect(messagePersist.default.add).toHaveBeenCalledTimes(3);

      // Self-terminates: no further broadcasts after count reached.
      jest.advanceTimersByTime(500 * 5);
      expect(broadcastSpy).toHaveBeenCalledTimes(3);
    });

    it('honors a custom channelId and clamps count to the max', async () => {
      jest.useFakeTimers();
      const res = await request(app)
        .post('/api/admin/sim/stream')
        .set('Authorization', `Bearer ${adminKey}`)
        .send({ count: 9999, channelId: '00000000-0000-0000-0000-000000000002' });

      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(200); // clamped
      expect(res.body.data.channelId).toBe('00000000-0000-0000-0000-000000000002');
      // Stop the long drip from leaking into other tests.
      jest.clearAllTimers();
    });
  });
});
