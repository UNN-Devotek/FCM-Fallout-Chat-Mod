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
const { getRedisClient } = require('../src/config/redis');
const { getCachedRole, resolveRole } = require('../src/services/roleVerificationService');
const { requireDiscordRole, requireStaffRole } = require('../src/middleware/auth');

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

describe('requireStaffRole (overlay X-Auth-Token path)', () => {
  const MOD_GATE = [ROLE_IDS.owner, ROLE_IDS.admin, ROLE_IDS.moderator];
  const STAFF_USER_ID = '11111111-1111-4111-8111-111111111111';

  function tokenRequest() {
    return { headers: { 'x-auth-token': 'overlay-token' }, session: {} };
  }

  // users.findUnique is called by requireAuth (ban/mute fields), by the gate
  // (discordId) and by getEffectiveRole (discordId). Merge them into one row.
  function mockTokenUser(row) {
    getRedisClient.mockResolvedValue({ get: jest.fn().mockResolvedValue(row ? row.id : null) });
    prisma.user.findUnique.mockResolvedValue(row);
  }

  async function runStaffGate(allowedRoles, req) {
    const next = jest.fn();
    await requireStaffRole(...allowedRoles)(req, {}, next);
    return next;
  }

  const baseUser = {
    id: STAFF_USER_ID, username: 'Overseer', isBanned: false, bannedUntil: null,
    banReason: null, banCategory: null, isMuted: false, muteExpiresAt: null,
    discordId: '123456789012345678', discordUsername: 'overseer', discordDisplayName: 'Overseer',
  };

  it('lets a moderator token through and records the Discord identity as the actor', async () => {
    mockTokenUser(baseUser);
    prisma.adminUser.findUnique.mockResolvedValue({ role: 'moderator' });
    const req = tokenRequest();

    const next = await runStaffGate(MOD_GATE, req);

    expect(next).toHaveBeenCalledWith();
    expect(req.adminUser).toMatchObject({ id: '123456789012345678', role: 'moderator', userId: STAFF_USER_ID });
  });

  it('rejects a plain user token with 403', async () => {
    mockTokenUser(baseUser);
    prisma.adminUser.findUnique.mockResolvedValue(null);
    const req = tokenRequest();

    const next = await runStaffGate(MOD_GATE, req);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
    expect(req.adminUser).toBeUndefined();
  });

  it('rejects a token user with no linked Discord account', async () => {
    mockTokenUser({ ...baseUser, discordId: null });
    const next = await runStaffGate(MOD_GATE, tokenRequest());
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });

  it('applies the same hierarchy as web sessions (moderator fails an admin gate)', async () => {
    mockTokenUser(baseUser);
    getCachedRole.mockResolvedValue('moderator');
    const next = await runStaffGate(['owner', 'admin'], tokenRequest());
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });

  it('rejects a banned staff token even with an owner role', async () => {
    mockTokenUser({ ...baseUser, isBanned: true });
    getCachedRole.mockResolvedValue('owner');
    const req = tokenRequest();

    const next = await runStaffGate(MOD_GATE, req);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
    expect(JSON.parse(next.mock.calls[0][0].message)).toMatchObject({ type: 'banned' });
    expect(req.adminUser).toBeUndefined();
  });

  it('rejects an expired or unknown token with 401', async () => {
    mockTokenUser(null);
    const next = await runStaffGate(MOD_GATE, tokenRequest());
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it('keeps the web-session path unchanged when a session cookie is present', async () => {
    getCachedRole.mockResolvedValue('moderator');
    const req = makeRequest();
    req.headers['x-auth-token'] = 'ignored-token';

    const next = await runStaffGate(MOD_GATE, req);

    expect(next).toHaveBeenCalledWith();
    expect(req.adminUser).toMatchObject({ id: 'discord-user-id', role: 'moderator' });
    expect(getRedisClient).not.toHaveBeenCalled();
  });

  it('still returns the web 401 when no credentials are sent', async () => {
    const next = await runStaffGate(MOD_GATE, { headers: {}, session: {} });
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 });
  });
});
