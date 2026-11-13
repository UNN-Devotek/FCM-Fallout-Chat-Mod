'use strict';

/**
 * Unit tests for moderationActionsService: reverseBan (atomic guard and
 * active-ban scoping), the already-banned guard, the provider deny-list,
 * fail-closed protection, and expiry role restoration.
 */

// ── Prisma mock ────────────────────────────────────────────────────────────────
const mockBan = { userId: 'user-uuid-1', bannedUntil: null };

const prismaMock = {
  ban: {
    create: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  linkedIdentity: { findMany: jest.fn() },
  message: { findFirst: jest.fn() },
  bannedIdentity: { upsert: jest.fn(), deleteMany: jest.fn() },
  device: { updateMany: jest.fn() },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'));

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { on: jest.fn() },
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  }),
}));

jest.mock('../src/websocket/handlers', () => ({
  broadcast: jest.fn(),
  broadcastMessageDeletion: jest.fn(),
  disconnectByUserId: jest.fn().mockReturnValue(0),
  markClientMuted: jest.fn(),
  notifyAndDisconnect: jest.fn().mockReturnValue(0),
}));

// Discord guild fake: member cache + bans, so role strip / restore is observable.
const member = {
  roles: { cache: new Map(), remove: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue(undefined) },
  voice: { channelId: null, disconnect: jest.fn() },
};
const guild = {
  id: 'guild-1',
  members: { fetch: jest.fn(), fetchMe: jest.fn() },
  bans: { create: jest.fn().mockResolvedValue(undefined), remove: jest.fn().mockResolvedValue(undefined), fetch: jest.fn() },
  roles: { cache: new Map() },
};
let discordConnected = false;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { DISCORD_SERVER_ID: 'guild-1' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/services/discordService', () => ({
  getDiscordClient: jest.fn(() => (discordConnected ? { guilds: { fetch: jest.fn().mockResolvedValue(guild) } } : null)),
  postModAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/userRoleService', () => ({
  resolveTargetProtection: jest.fn().mockResolvedValue({ found: true, role: null }),
  getEffectiveRole: jest.fn().mockResolvedValue('user'),
}));
jest.mock('../src/services/relay/tokenService', () => ({ revokeTokensForLinkedUser: jest.fn() }));
jest.mock('../src/services/relay/relayHandler', () => ({ evictRelayUser: jest.fn().mockResolvedValue(0) }));

// ── Tests ──────────────────────────────────────────────────────────────────────
const { reverseBan, deleteMessageById, createBan, kickUser, sweepExpired, unbanUser, ModerationError } = require('../src/services/moderationActionsService');
const { resolveTargetProtection } = require('../src/services/userRoleService');

const STEAM_ID = '76561198000000001';
const evidence = [{ type: 'text', textContent: 'evidence' }];

beforeEach(() => {
  jest.clearAllMocks();
  discordConnected = false;
  resolveTargetProtection.mockResolvedValue({ found: true, role: null });
  prismaMock.ban.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ban.findUnique.mockResolvedValue(mockBan);
  prismaMock.ban.findFirst.mockResolvedValue(null);
  guild.bans.fetch.mockRejectedValue(new Error('Unknown Ban'));
  prismaMock.ban.findMany.mockResolvedValue([]);
  prismaMock.ban.count.mockResolvedValue(0);
  prismaMock.ban.create.mockResolvedValue({ id: 'new-ban' });
  prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: null, discordId: null, steamId: null });
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.update.mockResolvedValue({});
  prismaMock.user.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.linkedIdentity.findMany.mockResolvedValue([]);
  prismaMock.bannedIdentity.upsert.mockResolvedValue({});
  prismaMock.bannedIdentity.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.device.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.$executeRaw.mockResolvedValue(1);
  member.roles.cache = new Map();
  guild.members.fetch.mockResolvedValue(member);
  guild.members.fetchMe.mockResolvedValue({ roles: { highest: { position: 100 } } });
  guild.roles.cache = new Map([['role-a', { id: 'role-a', managed: false, position: 5 }]]);
});

describe('reverseBan', () => {
  test('succeeds when updateMany matches one row', async () => {
    await expect(reverseBan('ban-id', 'actor-id', 'pardoned')).resolves.toBeUndefined();
    expect(prismaMock.ban.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ban-id', reversedAt: null },
      }),
    );
  });

  test('throws BanNotFound when the ban does not exist', async () => {
    prismaMock.ban.findUnique.mockResolvedValue(null);

    await expect(reverseBan('missing-id', 'actor-id', 'reason')).rejects.toMatchObject({ code: 'BanNotFound', message: 'Ban not found' });
    expect(prismaMock.ban.updateMany).not.toHaveBeenCalled();
  });

  test('reversing an already-reversed ban is a BanAlreadyReversed error and changes nothing', async () => {
    prismaMock.ban.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: ['role-a'], discordId: 'd1' });

    const err = await reverseBan('ban-id', 'actor-id', 'reason').catch((e) => e);
    expect(err).toBeInstanceOf(ModerationError);
    expect(err.code).toBe('BanAlreadyReversed');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  test('concurrent calls: only first wins — second call sees count=0 and throws', async () => {
    prismaMock.ban.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.allSettled([
      reverseBan('ban-id', 'actor-a', 'first'),
      reverseBan('ban-id', 'actor-b', 'second'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(second.reason.message).toBe('Ban already reversed');
  });

  test('clears user ban state when the reversed ban is the active one', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: [], discordId: null });

    await reverseBan('ban-id', 'actor-id', 'reason');

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBan.userId },
        data: expect.objectContaining({ isBanned: false }),
      }),
    );
  });

  test('reversing an expired old ban never lifts the current active ban', async () => {
    prismaMock.ban.findUnique.mockResolvedValue({ userId: 'user-uuid-1', bannedUntil: new Date(Date.now() - 86_400_000) });
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: ['role-a'], discordId: 'd1' });
    discordConnected = true;

    await reverseBan('old-ban', 'actor-id', 'cleanup');

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(guild.bans.remove).not.toHaveBeenCalled();
  });

  test('reversing one active ban while another active ban remains keeps the user banned', async () => {
    prismaMock.ban.count.mockResolvedValue(1);
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: ['role-a'], discordId: 'd1' });
    discordConnected = true;

    await reverseBan('ban-id', 'actor-id', 'reason');

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(guild.bans.remove).not.toHaveBeenCalled();
    expect(prismaMock.bannedIdentity.deleteMany).not.toHaveBeenCalled();
  });

  test('reversing the last permanent ban removes the deny-listed provider identities', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: [], discordId: 'd1', steamId: STEAM_ID });
    prismaMock.linkedIdentity.findMany.mockResolvedValue([{ provider: 'nexus', providerUid: 'nx-1' }]);

    await reverseBan('ban-id', 'actor-id', 'appeal accepted');

    expect(prismaMock.bannedIdentity.deleteMany).toHaveBeenCalledWith({ where: { OR: [
      { reason: { startsWith: 'ban:ban-id' } },
      { provider: 'discord', providerUid: 'd1' },
      { provider: 'steam', providerUid: STEAM_ID },
      { provider: 'nexus', providerUid: 'nx-1' },
    ] } });
  });
});

describe('createBan', () => {
  test('refuses a second ban while one is active (AlreadyBanned) without writing a bans row', async () => {
    prismaMock.ban.findFirst.mockResolvedValue({ id: 'active-ban' });
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, bannedUntil: null, savedDiscordRoles: ['role-a'], discordId: 'd1' });

    await expect(createBan('target', 'actor', 'Spam', 'again', null, evidence)).rejects.toMatchObject({ code: 'AlreadyBanned' });
    expect(prismaMock.ban.create).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  test('a stale ban row left by the old legacy unban does not block a new ban', async () => {
    prismaMock.ban.findFirst.mockResolvedValue({ id: 'stale-row' });
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: null, discordId: null, steamId: null });

    await createBan('target', 'actor', 'Spam', 'again', null, evidence);
    expect(prismaMock.ban.create).toHaveBeenCalled();
  });

  test('never overwrites a non-empty role snapshot with an empty strip result', async () => {
    // A lazily-expired temp ban: flags cleared, roles still stripped and saved.
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: ['role-a', 'role-b'], discordId: 'd1' });
    discordConnected = true;

    await createBan('target', 'actor', 'Spam', 'spam', new Date(Date.now() + 3_600_000), evidence);

    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isBanned: true, savedDiscordRoles: ['role-a', 'role-b'] }),
    }));
  });

  test('a permanent ban deny-lists the Discord, Steam and Nexus identities', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: null, discordId: 'd1', steamId: STEAM_ID, installToken: null });
    prismaMock.linkedIdentity.findMany.mockResolvedValue([{ provider: 'nexus', providerUid: 'nx-1' }]);

    const result = await createBan('target', 'actor', 'Cheating', 'aimbot', null, evidence);

    expect(result.identitiesDenyListed).toBe(3);
    const written = prismaMock.bannedIdentity.upsert.mock.calls.map(([args]) => args.create);
    expect(written).toEqual([
      { provider: 'discord', providerUid: 'd1', reason: 'ban:new-ban Cheating' },
      { provider: 'steam', providerUid: STEAM_ID, reason: 'ban:new-ban Cheating' },
      { provider: 'nexus', providerUid: 'nx-1', reason: 'ban:new-ban Cheating' },
    ]);
  });

  test('a temporary ban does not deny-list identities', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, bannedUntil: null, savedDiscordRoles: null, discordId: 'd1', steamId: STEAM_ID });

    await createBan('target', 'actor', 'Spam', 'spam', new Date(Date.now() + 3_600_000), evidence);

    expect(prismaMock.bannedIdentity.upsert).not.toHaveBeenCalled();
  });
});

describe('protected-target check fails closed', () => {
  test('a role lookup failure refuses the action instead of treating the target as a user', async () => {
    resolveTargetProtection.mockRejectedValue(new Error('db down'));

    await expect(kickUser('target', 'actor', 'spam')).rejects.toMatchObject({ code: 'ProtectionCheckFailed' });
    await expect(createBan('target', 'actor', 'Spam', 'spam', null, evidence)).rejects.toMatchObject({ code: 'ProtectionCheckFailed' });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.ban.create).not.toHaveBeenCalled();
  });

  test('a staff target is refused with ProtectedTarget', async () => {
    resolveTargetProtection.mockResolvedValue({ found: true, role: 'moderator' });

    await expect(kickUser('target', 'actor', 'spam')).rejects.toMatchObject({ code: 'ProtectedTarget', name: 'ProtectedTargetError' });
  });

  test('a missing target is TargetNotFound', async () => {
    resolveTargetProtection.mockResolvedValue({ found: false, role: null });

    await expect(kickUser('target', 'actor', 'spam')).rejects.toMatchObject({ code: 'TargetNotFound' });
  });
});

describe('ban expiry restores Discord roles', () => {
  test('sweep clears an expired temp ban and re-adds the saved roles', async () => {
    discordConnected = true;
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1', discordId: 'd1', savedDiscordRoles: ['role-a'] }]) // expired bans
      .mockResolvedValueOnce([]) // orphaned snapshots
      .mockResolvedValueOnce([]); // expired mutes
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 });

    await sweepExpired();

    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: expect.objectContaining({ isBanned: false }),
    }));
    expect(member.roles.add).toHaveBeenCalledWith(['role-a'], expect.any(String));
  });

  test('sweep restores roles for a recently expired temp ban that was lazily cleared elsewhere', async () => {
    discordConnected = true;
    prismaMock.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'u2', discordId: 'd2', savedDiscordRoles: ['role-a'] }])
      .mockResolvedValueOnce([]);
    prismaMock.ban.findFirst.mockResolvedValue({ id: 'expired-temp' });
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await sweepExpired();

    expect(result.rolesRestored).toBe(1);
    expect(member.roles.add).toHaveBeenCalledWith(['role-a'], expect.any(String));
  });

  test('expiry lifts a guild ban FCM placed but keeps one placed for Discord conduct', async () => {
    discordConnected = true;
    guild.members.fetch.mockResolvedValue(member);
    const expired = () => prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1', discordId: 'd1', savedDiscordRoles: [] }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 });

    expired();
    guild.bans.fetch.mockResolvedValueOnce({ reason: 'Raiding in general' });
    prismaMock.ban.findFirst.mockResolvedValueOnce(null);
    await sweepExpired();
    expect(guild.bans.remove).not.toHaveBeenCalled();

    expired();
    guild.bans.fetch.mockResolvedValueOnce({ reason: 'spam links' });
    prismaMock.ban.findFirst.mockResolvedValueOnce({ id: 'fcm-ban' });
    await sweepExpired();
    expect(guild.bans.remove).toHaveBeenCalledWith('d1', 'Ban reversed');
  });

  test('orphan pass does not restore roles when a new ban won the race', async () => {
    discordConnected = true;
    guild.members.fetch.mockResolvedValue(member);
    prismaMock.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'u2', discordId: 'd2', savedDiscordRoles: ['role-a'] }])
      .mockResolvedValueOnce([]);
    prismaMock.ban.findFirst.mockResolvedValue({ id: 'expired-temp' });
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 });
    const result = await sweepExpired();
    expect(result.rolesRestored).toBe(0);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  test('sweep drops an old orphaned snapshot without re-granting roles', async () => {
    discordConnected = true;
    prismaMock.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'u3', discordId: 'd3', savedDiscordRoles: ['role-a'] }])
      .mockResolvedValueOnce([]);
    prismaMock.ban.findFirst.mockResolvedValue(null);
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await sweepExpired();

    expect(result.rolesRestored).toBe(0);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u3', isBanned: false } }));
  });
});

describe('unbanUser (legacy by-user unban)', () => {
  test('reverses the active ban row', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isBanned: true, savedDiscordRoles: [], discordId: null });
    prismaMock.ban.findMany.mockResolvedValue([{ id: 'ban-id' }]);

    await expect(unbanUser('user-uuid-1', 'actor', 'appeal')).resolves.toEqual({ reversedBanIds: ['ban-id'] });
    expect(prismaMock.ban.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ban-id', reversedAt: null } }));
  });

  test('a user with no active ban is NotBanned', async () => {
    await expect(unbanUser('user-uuid-1', 'actor', 'x')).rejects.toMatchObject({ code: 'NotBanned' });
  });
});

describe('deleteMessageById', () => {
  test('soft-deletes the message, audits, and broadcasts deletion', async () => {
    await expect(deleteMessageById('11111111-1111-4111-8111-111111111111', 'actor-id', 'spam'))
      .resolves.toBeUndefined();
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'delete_message',
        targetId: '11111111-1111-4111-8111-111111111111',
        targetType: 'message',
        reason: 'spam',
      }),
    });
    expect(require('../src/websocket/handlers').broadcastMessageDeletion)
      .toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  test('posts a mod-log entry naming actor, author, channel and an excerpt', async () => {
    prismaMock.message.findFirst.mockResolvedValueOnce({
      content: 'x'.repeat(400),
      user: { username: 'pending-abc', steamDisplayName: 'godagarah' },
      channel: { name: 'general' },
    });
    prismaMock.user.findUnique.mockResolvedValueOnce({ username: 'discord:1', discordDisplayName: 'MouseyPaige' });
    await deleteMessageById('11111111-1111-4111-8111-111111111111', 'actor-id', 'spam');
    const { postModAlert } = require('../src/services/discordService');
    const fields = postModAlert.mock.calls.at(-1)[0].fields;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['Deleted by']).toBe('MouseyPaige');
    expect(byName.Author).toBe('godagarah');
    expect(byName.Channel).toBe('#general');
    expect(byName.Message).toHaveLength(300);
  });

  test('does not broadcast when the message is already deleted or missing', async () => {
    prismaMock.$executeRaw.mockResolvedValueOnce(0);
    await expect(deleteMessageById('11111111-1111-4111-8111-111111111111', 'actor-id', 'spam'))
      .rejects.toThrow('Message not found');
    expect(require('../src/websocket/handlers').broadcastMessageDeletion).not.toHaveBeenCalled();
  });
});
