'use strict';

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn(),
}));
jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: {
    ADMIN_API_KEY: 'test-api-key',
    OWNER_ROLE_ID: 'owner-role-id',
    ADMIN_ROLE_ID: 'admin-role-id',
    MODERATOR_ROLE_ID: 'moderator-role-id',
  },
}));
jest.mock('../src/services/roleVerificationService', () => ({
  getCachedRole: jest.fn().mockResolvedValue(null),
  resolveRole: jest.fn(),
}));
jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn() },
}));

const prisma = require('../src/config/prisma').default;
const { getCachedRole, resolveRole } = require('../src/services/roleVerificationService');
const { requireDiscordRole } = require('../src/middleware/auth');

const ROLE_IDS = {
  owner: 'owner-role-id',
  admin: 'admin-role-id',
  moderator: 'moderator-role-id',
};

function makeRequest({ roles = [], role = 'member' } = {}) {
  return {
    headers: {},
    session: {
      discordUser: {
        id: 'discord-user-id',
        username: 'VaultEller',
        roles,
        role,
      },
    },
  };
}

async function runGate(allowedRoles, requestOptions = {}) {
  const next = jest.fn();
  await requireDiscordRole(...allowedRoles)(makeRequest(requestOptions), {}, next);
  return next;
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.adminUser.findUnique.mockResolvedValue(null);
  getCachedRole.mockResolvedValue(null);
  resolveRole.mockImplementation((roles) => {
    if (roles.includes(ROLE_IDS.owner)) return 'owner';
    if (roles.includes(ROLE_IDS.admin)) return 'admin';
    if (roles.includes(ROLE_IDS.moderator)) return 'moderator';
    return null;
  });
});

describe('requireDiscordRole', () => {
  it('does not let a cached admin role pass an owner-only gate', async () => {
    getCachedRole.mockResolvedValue('admin');

    const next = await runGate([ROLE_IDS.owner]);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });

  it('allows an owner cached role through an admin gate', async () => {
    getCachedRole.mockResolvedValue('owner');

    const next = await runGate([ROLE_IDS.admin]);

    expect(next).toHaveBeenCalledWith();
  });

  it('does not let a database moderator role pass an admin gate', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'moderator' });

    const next = await runGate([ROLE_IDS.admin]);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });

  it('uses the same privilege hierarchy for fresh session role IDs', async () => {
    const next = await runGate([ROLE_IDS.admin], { roles: [ROLE_IDS.owner] });

    expect(next).toHaveBeenCalledWith();
  });

  it('supports literal role names used by admin routes', async () => {
    getCachedRole.mockResolvedValue('admin');

    const next = await runGate(['owner', 'admin']);

    expect(next).toHaveBeenCalledWith();
  });
});
