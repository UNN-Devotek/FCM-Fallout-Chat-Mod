'use strict';

/**
 * Legacy /api/users/:id/{mute,kick,ban} handlers must go through
 * moderationActionsService: protected-target refusal, bans row + evidence,
 * live socket kick. (Previously they wrote users flags directly, so an admin
 * could ban the owner and no bans row / live kick happened.)
 */
const mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn(), on: jest.fn() };
jest.mock('../src/config/redis', () => ({ client: mockRedis, getRedisClient: jest.fn().mockResolvedValue(mockRedis), healthCheck: jest.fn() }));
jest.mock('../src/config/database', () => ({ query: jest.fn(), pool: { on: jest.fn() }, healthCheck: jest.fn() }));
jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
jest.mock('../src/services/discordService', () => ({ getDiscordClient: jest.fn(() => null), postModAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/websocket/handlers', () => ({
  notifyAndDisconnect: jest.fn(() => 1), markClientMuted: jest.fn(), broadcastMessageDeletion: jest.fn(),
  refreshClientIdentity: jest.fn(), resolveDisplayName: jest.fn(),
}));
jest.mock('../src/services/userRoleService', () => ({ resolveTargetProtection: jest.fn() }));
jest.mock('../src/services/relay/relayHandler', () => ({ evictRelayUser: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/services/relay/tokenService', () => ({ revokeTokensForLinkedUser: jest.fn() }));

const prisma = require('./setup/prisma-stub').default;
// The shared stub predates the bans tables; add the models this path touches.
for (const model of ['ban', 'linkedIdentity', 'bannedIdentity', 'device']) {
  prisma[model] = prisma[model] || { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), upsert: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
}
const { resolveTargetProtection } = require('../src/services/userRoleService');
const { notifyAndDisconnect } = require('../src/websocket/handlers');
const { banUser, kickUser } = require('../src/controllers/usersController');

const TARGET = '11111111-1111-4111-8111-111111111111';

function call(handler, body = {}) {
  const req = { params: { id: TARGET }, body, adminUser: { id: '123456789012345678', role: 'admin' } };
  const res = { json: jest.fn() };
  const next = jest.fn();
  return handler(req, res, next).then(() => ({ res, next }));
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findFirst.mockResolvedValue({ id: 'actor-uuid' });
  prisma.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: null, discordId: null });
  prisma.user.update.mockResolvedValue({ discordId: null });
  prisma.ban.findFirst.mockResolvedValue(null);
  prisma.ban.create.mockResolvedValue({ id: 'ban-1' });
  resolveTargetProtection.mockResolvedValue({ found: true, role: null });
});

test('legacy ban of a protected target (owner) is refused with 409 and writes nothing', async () => {
  resolveTargetProtection.mockResolvedValue({ found: true, role: 'owner' });

  const { res, next } = await call(banUser, { reason: 'abuse' });

  expect(res.json).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'ProtectedTarget' }));
  expect(prisma.ban.create).not.toHaveBeenCalled();
  expect(prisma.user.update).not.toHaveBeenCalled();
});

test('legacy ban writes a bans row with the reason as text evidence and kicks live sockets', async () => {
  const { res, next } = await call(banUser, { reason: 'abuse' });

  expect(next).not.toHaveBeenCalled();
  expect(prisma.ban.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ userId: TARGET, bannedById: 'actor-uuid', reasonText: 'abuse', bannedUntil: null,
      evidence: { create: [expect.objectContaining({ type: 'text', textContent: 'abuse' })] } }),
  }));
  expect(notifyAndDisconnect).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: 'user:banned' }), 4002, 'Banned');
  expect(res.json).toHaveBeenCalledWith({ data: expect.objectContaining({ banned: true, banId: 'ban-1' }) });
});

test('legacy kick applies the kick cooldown and live disconnect instead of only ending the saved login', async () => {
  const { res } = await call(kickUser);

  expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TARGET }, data: { kickedUntil: expect.any(Date) } }));
  expect(notifyAndDisconnect).toHaveBeenCalledWith(TARGET, expect.objectContaining({ type: 'user:kicked' }), 4002, expect.any(String));
  expect(res.json).toHaveBeenCalledWith({ data: expect.objectContaining({ kicked: true }) });
});
