'use strict';
const request = require('supertest');

// Shared mock for Redis
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  publish: jest.fn().mockResolvedValue(1),
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

describe('DELETE /api/link/provider/discord', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    prismaStub.user.findUnique.mockResolvedValue(null);
  });

  it('clears the Discord identity, revokes the active session, and reports logout', async () => {
    mockRedis.get.mockResolvedValueOnce('user-uuid');
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'user-uuid',
      username: 'Wanderer76',
      isBanned: false,
      bannedUntil: null,
      banReason: null,
      banCategory: null,
      isMuted: false,
      muteExpiresAt: null,
      discordId: '123456789012345',
      installToken: '123e4567-e89b-12d3-a456-426614174000',
    });

    const res = await request(app)
      .delete('/api/link/provider/discord')
      .set('X-Auth-Token', 'session-token');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true, loggedOut: true });
    expect(prismaStub.user.update).toHaveBeenCalledWith({
      where: { id: 'user-uuid' },
      data: {
        discordId: null,
        discordUsername: null,
        discordDisplayName: null,
        discordAvatar: null,
        discordAuthedAt: null,
      },
    });
    expect(mockRedis.del).toHaveBeenCalledWith('discord_link:123e4567-e89b-12d3-a456-426614174000');
    expect(mockRedis.del).toHaveBeenCalledWith('session:session-token');
    expect(prismaStub.session.delete).toHaveBeenCalledWith({ where: { token: 'session-token' } });
    expect(mockRedis.publish).toHaveBeenCalled();
  });

  it('does not revoke a session when Discord is already unlinked', async () => {
    mockRedis.get.mockResolvedValueOnce('user-uuid');
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'user-uuid',
      username: 'Wanderer76',
      isBanned: false,
      bannedUntil: null,
      banReason: null,
      banCategory: null,
      isMuted: false,
      muteExpiresAt: null,
      discordId: null,
      installToken: '123e4567-e89b-12d3-a456-426614174000',
    });

    const res = await request(app)
      .delete('/api/link/provider/discord')
      .set('X-Auth-Token', 'session-token');

    expect(res.status).toBe(404);
    expect(prismaStub.user.update).not.toHaveBeenCalled();
    expect(prismaStub.session.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/link/provider/steam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'steam-user',
      username: 'SteamUser',
      isBanned: false,
      bannedUntil: null,
      banReason: null,
      banCategory: null,
      steamId: '76561198012345678',
      discordId: null,
      installToken: '123e4567-e89b-12d3-a456-426614174002',
    });
    prismaStub.linkedIdentity.count.mockResolvedValue(0);
  });

  it('clears Steam, revokes the session, and reports logout when it was the last provider', async () => {
    mockRedis.get.mockResolvedValueOnce('steam-user');

    const res = await request(app)
      .delete('/api/link/provider/steam')
      .set('X-Auth-Token', 'steam-session-token');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true, loggedOut: true });
    expect(prismaStub.user.update).toHaveBeenCalledWith({
      where: { id: 'steam-user' },
      data: { steamId: null, steamDisplayName: null },
    });
    expect(mockRedis.del).toHaveBeenCalledWith('steam_link:123e4567-e89b-12d3-a456-426614174002');
    expect(mockRedis.del).toHaveBeenCalledWith('session:steam-session-token');
    expect(prismaStub.session.delete).toHaveBeenCalledWith({ where: { token: 'steam-session-token' } });
    expect(mockRedis.publish).toHaveBeenCalled();
  });

  it('keeps the session when Discord is still linked', async () => {
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'dual-provider-user',
      username: 'DualProvider',
      isBanned: false,
      bannedUntil: null,
      banReason: null,
      banCategory: null,
      steamId: '76561198012345678',
      discordId: 'discord-123',
      installToken: '123e4567-e89b-12d3-a456-426614174003',
    });
    mockRedis.get.mockResolvedValueOnce('dual-provider-user');

    const res = await request(app)
      .delete('/api/link/provider/steam')
      .set('X-Auth-Token', 'dual-provider-session');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true, loggedOut: false });
    expect(prismaStub.session.delete).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalledWith('session:dual-provider-session');
  });

  it('keeps the session when another non-Discord provider is still linked', async () => {
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'nexus-steam-user',
      username: 'NexusSteamUser',
      isBanned: false,
      bannedUntil: null,
      banReason: null,
      banCategory: null,
      steamId: '76561198012345678',
      discordId: null,
      installToken: '123e4567-e89b-12d3-a456-426614174004',
    });
    prismaStub.linkedIdentity.count.mockResolvedValue(1);
    mockRedis.get.mockResolvedValueOnce('nexus-steam-user');

    const res = await request(app)
      .delete('/api/link/provider/steam')
      .set('X-Auth-Token', 'nexus-steam-session');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true, loggedOut: false });
    expect(prismaStub.session.delete).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalledWith('session:nexus-steam-session');
  });
});
