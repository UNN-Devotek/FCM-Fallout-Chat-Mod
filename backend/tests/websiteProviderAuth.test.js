'use strict';
const request = require('supertest');

// Shared mock for Redis
const mockRedis = {
  getDel: jest.fn().mockResolvedValue(null),
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

let mockBrowserSession = {};
jest.mock('express-session', () => () => (req, _res, next) => {
  req.session = mockBrowserSession;
  req.session.save = cb => cb();
  req.sessionID = 'browser-a';
  next();
});
jest.mock('../src/services/avatarService', () => ({ captureAvatar: jest.fn().mockResolvedValue(undefined), buildAvatarUrl: () => '/avatars/default' }));
jest.mock('../src/services/linkedIdentityService', () => ({
  ...jest.requireActual('../src/services/linkedIdentityService'),
  isBannedIdentity: jest.fn().mockResolvedValue(false),
}));
jest.mock('../src/services/chatNameService', () => ({ setChatName: jest.fn().mockResolvedValue({ ok: true, chatName: 'Dweller', changed: true }) }));
const { app } = require('../src/server');
const db = require('../src/config/database');
const prismaStub = require('./setup/prisma-stub').default;


const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  mockBrowserSession = { steamUser: { steamId: '76561198000000001', userId: 'stale' } };
  prismaStub.user.findFirst.mockResolvedValue({ id: 'account-a', username: 'Dweller', isBanned: false });
  prismaStub.user.findUnique.mockResolvedValue({ id: 'account-a', username: 'Dweller', isBanned: false });
  prismaStub.user.updateMany.mockResolvedValue({ count: 1 });
  mockRedis.getDel.mockResolvedValue(JSON.stringify({ sessionId: 'browser-a', intent: 'profile', linkUserId: 'account-a' }));
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'verified-token' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '12345678901234567', username: 'Dweller' }) });
});
afterAll(() => { global.fetch = originalFetch; });
test('Steam website sign-in exposes canonical member account, never staff role', async () => {
  const response = await request(app).get('/auth/me');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ id: 'account-a', role: 'member' });
  expect(response.body.data).not.toHaveProperty('steamId');
});
test('Steam website sign-in rejects banned or removed account', async () => {
  prismaStub.user.findFirst.mockResolvedValueOnce({ id: 'account-a', isBanned: true, bannedUntil: null });
  expect((await request(app).get('/auth/me')).status).toBe(401);
  prismaStub.user.findFirst.mockResolvedValueOnce(null);
  expect((await request(app).get('/auth/me')).status).toBe(401);
});
test('profile OAuth links to the existing Steam account without granting Discord roles', async () => {
  const response = await request(app).get('/auth/discord/callback?code=code&state=state');
  expect(response.status).toBe(302);
  expect(response.headers.location).toContain('/profile/account-a?linked=discord');
  expect(prismaStub.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'account-a', OR: [{ discordId: null }, { discordId: '12345678901234567' }] } }));
  expect(prismaStub.user.create).not.toHaveBeenCalled();
  expect(mockBrowserSession.discordUser).toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
test('profile callback rejects a changed account and mismatched browser', async () => {
  prismaStub.user.findFirst.mockResolvedValueOnce({ id: 'other-account' });
  expect((await request(app).get('/auth/discord/callback?code=code&state=state')).status).toBe(403);
  expect(prismaStub.user.updateMany).not.toHaveBeenCalled();
  mockRedis.getDel.mockResolvedValueOnce(JSON.stringify({ sessionId: 'other-browser', intent: 'profile', linkUserId: 'account-a' }));
  expect((await request(app).get('/auth/discord/callback?code=code&state=state')).status).toBe(403);
});
test('profile link refuses an occupied Discord identity without switching accounts', async () => {
  prismaStub.user.updateMany.mockRejectedValueOnce(new Error('unique constraint'));
  const response = await request(app).get('/auth/discord/callback?code=code&state=state');
  expect(response.headers.location).toContain('linkError=conflict');
  expect(mockBrowserSession.discordUser).toBeUndefined();
  expect(prismaStub.user.create).not.toHaveBeenCalled();
});
test('profile link start requires an authenticated account and binds it into state', async () => {
  const response = await request(app).get('/auth/discord/profile');
  expect(response.status).toBe(302);
  const stateWrite = mockRedis.set.mock.calls.find(([key]) => key.startsWith('oauth_state:'));
  expect(JSON.parse(stateWrite[1])).toMatchObject({ intent: 'profile', sessionId: 'browser-a', linkUserId: 'account-a' });
  mockBrowserSession = {};
  expect((await request(app).get('/auth/discord/profile')).status).toBe(401);
});

test('Steam profile can change only its own chat name', async () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  prismaStub.user.findUnique.mockResolvedValue({ id, username: 'Dweller', isBanned: false });
  expect((await request(app).patch(`/api/users/${id}/chat-name`).send({ chatName: 'Dweller' })).status).toBe(200);
  expect((await request(app).patch('/api/users/123e4567-e89b-12d3-a456-426614174001/chat-name').send({ chatName: 'Dweller' })).status).toBe(403);
});


test.each([
  [{ username: 'pending-install', steamDisplayName: 'Steam Dweller' }, 'Steam Dweller'],
  [{ username: 'Chosen Name', steamDisplayName: 'Steam Dweller' }, 'Chosen Name'],
  [{ username: 'pending-install', chatName: 'Chat Name', steamDisplayName: 'Steam Dweller' }, 'Chat Name'],
  [{ username: 'pending-install', steamDisplayName: null }, 'Wanderer'],
])('Steam account display name respects explicit names and safe fallback: %j', async (identity, expected) => {
  prismaStub.user.findFirst.mockResolvedValueOnce({ id: 'account-a', isBanned: false, ...identity });
  const response = await request(app).get('/auth/me');
  expect(response.status).toBe(200);
  expect(response.body.data.username).toBe(expected);
});
