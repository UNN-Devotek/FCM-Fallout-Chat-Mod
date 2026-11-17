'use strict';

/**
 * resolveTargetProtection: the fail-closed staff check used by moderation.
 * getEffectiveRole keeps its fail-open ('user') behaviour for other callers.
 */
const prismaMock = {
  user: { findUnique: jest.fn() },
  adminUser: { findUnique: jest.fn() },
};
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
jest.mock('../src/config/environment', () => ({ __esModule: true, default: {
  DISCORD_SERVER_ID: 'guild-1', OWNER_ROLE_ID: 'r-owner', ADMIN_ROLE_ID: 'r-admin', MODERATOR_ROLE_ID: 'r-mod',
} }));
const getCachedRole = jest.fn();
jest.mock('../src/services/roleVerificationService', () => ({ getCachedRole: (...a) => getCachedRole(...a) }));
let memberRoles = null;
jest.mock('../src/services/discordService', () => ({
  getDiscordClient: () => ({ guilds: { cache: new Map([['guild-1', { members: { cache: new Map(memberRoles ? [['d1', { roles: { cache: new Set(memberRoles) } }]] : []) } }]]) } }),
}));

const { resolveTargetProtection, getEffectiveRole } = require('../src/services/userRoleService');

beforeEach(() => {
  jest.clearAllMocks();
  memberRoles = null;
  getCachedRole.mockResolvedValue(null);
  prismaMock.user.findUnique.mockResolvedValue({ discordId: 'd1' });
  prismaMock.adminUser.findUnique.mockResolvedValue(null);
});

test('throws (fails closed) when the user lookup fails, while getEffectiveRole still degrades to user', async () => {
  prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));
  await expect(resolveTargetProtection('u1')).rejects.toThrow('db down');
  await expect(getEffectiveRole('u1')).resolves.toBe('user');
});

test('throws when the admin_users lookup fails', async () => {
  prismaMock.adminUser.findUnique.mockRejectedValue(new Error('db down'));
  await expect(resolveTargetProtection('u1')).rejects.toThrow('db down');
});

test('an admin_users staff row protects the target', async () => {
  prismaMock.adminUser.findUnique.mockResolvedValue({ role: 'admin' });
  await expect(resolveTargetProtection('u1')).resolves.toEqual({ found: true, role: 'admin' });
});

test('a non-protected cached role does not hide an admin_users staff row', async () => {
  getCachedRole.mockResolvedValue('member');
  prismaMock.adminUser.findUnique.mockResolvedValue({ role: 'moderator' });
  await expect(resolveTargetProtection('u1')).resolves.toEqual({ found: true, role: 'moderator' });
});

test('a staff Discord role in the bot member cache protects staff with no admin_users row', async () => {
  memberRoles = ['r-mod'];
  await expect(resolveTargetProtection('u1')).resolves.toEqual({ found: true, role: 'moderator' });
});

test('a regular member is not protected; a missing user is reported as not found', async () => {
  memberRoles = ['some-other-role'];
  await expect(resolveTargetProtection('u1')).resolves.toEqual({ found: true, role: null });
  prismaMock.user.findUnique.mockResolvedValue(null);
  await expect(resolveTargetProtection('u1')).resolves.toEqual({ found: false, role: null });
});
