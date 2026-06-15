'use strict';
/**
 * MCP Admin router tests — /api/mcp-admin/*
 *
 * Verifies:
 *   1. No token → 401
 *   2. dev-env token → 401 (env mismatch)
 *   3. prod-env token → 200 on a read endpoint
 *   4. Destructive/excluded paths (nuke, migration, sim, game-bridge) are NOT
 *      routable through /api/mcp-admin — they must 404 (or 405), never 200.
 */
const request = require('supertest');
const crypto = require('crypto');

// ── Infrastructure mocks (same pattern as mcp.test.js) ────────────────────
jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) =>
    cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  ),
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
    keys: jest.fn().mockResolvedValue([]),
    sendCommand: jest.fn().mockResolvedValue(null),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnValue({
      zRemRangeByScore: jest.fn().mockReturnThis(),
      zAdd: jest.fn().mockReturnThis(),
      zCard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 1, 1, 1]),
    }),
    publish: jest.fn().mockResolvedValue(0),
    subscribe: jest.fn().mockResolvedValue(undefined),
  }),
  getSubscriberClient: jest.fn().mockResolvedValue({
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn() },
}));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  relayToDiscord: jest.fn().mockResolvedValue(undefined),
  invalidateRelayMappingsCache: jest.fn(),
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

const prismaStub = require('./setup/prisma-stub');
const prismaDefault = prismaStub.default;
jest.mock('../src/config/prisma', () => prismaStub);

jest.mock('../src/services/deviceAuthService', () => ({
  extractSignatureHeaders: jest.fn().mockReturnValue({ alg: 'test', sig: 'ok', keyId: 'test' }),
  verifySignedRequest: jest.fn().mockResolvedValue({ ok: true }),
  isValidP256Spki: jest.fn().mockReturnValue(true),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
const TOKEN_PREFIX = 'fcm_mcp_';

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function makeFakeToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('/api/mcp-admin auth gates', () => {
  let app;

  beforeAll(() => {
    const mod = require('../src/server');
    app = mod.app || mod;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function setupProdToken(userId) {
    userId = userId || 'owner-123';
    const raw = makeFakeToken();
    const hash = sha256(raw);
    // verifyToken will find this row; env = 'prod' so requireMcpToken('prod') accepts it
    prismaDefault.mcpApiKey.findUnique.mockResolvedValue({
      id: 'tok-prod-1',
      keyHash: hash,
      ownerId: userId,
      env: 'prod',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      label: 'owner',
    });
    prismaDefault.mcpApiKey.update.mockResolvedValue({});
    prismaDefault.user.findUnique.mockResolvedValue({
      id: userId,
      username: 'OwnerUser',
      isBanned: false,
      isMuted: false,
      bannedUntil: null,
    });
    return raw;
  }

  // ── 1. No token ─────────────────────────────────────────────────────────────
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/api/mcp-admin/health');
    expect(res.status).toBe(401);
  });

  // ── 2. Dev-env token rejected ────────────────────────────────────────────────
  it('returns 401 when a dev-env token is sent to the prod endpoint', async () => {
    const raw = makeFakeToken();
    prismaDefault.mcpApiKey.findUnique.mockResolvedValue({
      id: 'tok-dev-1',
      keyHash: sha256(raw),
      ownerId: 'user-dev',
      env: 'dev',        // <-- dev token; requireMcpToken('prod') must reject this
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      label: null,
    });
    const res = await request(app)
      .get('/api/mcp-admin/health')
      .set('Authorization', `Bearer ${raw}`);
    expect(res.status).toBe(401);
  });

  // ── 3. Valid prod token → read succeeds ────────────────────────────────────
  it('returns 200 on health with a valid prod token', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .get('/api/mcp-admin/health')
      .set('Authorization', `Bearer ${raw}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok' });
  });

  it('returns 200 on channels read with a valid prod token', async () => {
    const raw = setupProdToken();
    prismaDefault.channel.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/mcp-admin/channels')
      .set('Authorization', `Bearer ${raw}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // ── 4. Catastrophic paths are NOT routable through /api/mcp-admin ──────────
  // These must 404 (route doesn't exist in mcpAdmin router) or 405.
  // They must NEVER return 200.
  it('POST /api/mcp-admin/admin/nuke-users is NOT reachable (404)', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .post('/api/mcp-admin/admin/nuke-users')
      .set('Authorization', `Bearer ${raw}`)
      .send({ confirm: true });
    // Must not be 200 — the route simply doesn't exist in the mcp-admin router
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /api/mcp-admin/admin/migration/run is NOT reachable (404)', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .post('/api/mcp-admin/admin/migration/run')
      .set('Authorization', `Bearer ${raw}`)
      .send({ confirm: true });
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /api/mcp-admin/sim/stream is NOT reachable (404)', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .post('/api/mcp-admin/sim/stream')
      .set('Authorization', `Bearer ${raw}`)
      .send({ confirm: true });
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /api/mcp-admin/game/player-bridge is NOT reachable (404)', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .post('/api/mcp-admin/game/player-bridge')
      .set('Authorization', `Bearer ${raw}`)
      .send({ confirm: true });
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── 5. Mutation without confirm: true → 400 ────────────────────────────────
  it('POST /api/mcp-admin/messages/send returns 400 without confirm: true', async () => {
    const raw = setupProdToken();
    const res = await request(app)
      .post('/api/mcp-admin/messages/send')
      .set('Authorization', `Bearer ${raw}`)
      .send({ channelId: '00000000-0000-0000-0000-000000000001', content: 'hello' });
    expect(res.status).toBe(400);
  });
});
