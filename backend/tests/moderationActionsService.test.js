'use strict';

/**
 * Unit tests for moderationActionsService — focused on the reverseBan
 * TOCTOU fix (updateMany atomic guard).
 */

// ── Prisma mock ────────────────────────────────────────────────────────────────
const mockBan = { userId: 'user-uuid-1' };

const prismaMock = {
  ban: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
  moderationSetting: { findUnique: jest.fn(), createMany: jest.fn(), updateMany: jest.fn() },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
  $transaction: jest.fn(callback => callback(prismaMock)),
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

jest.mock('../src/services/discordService', () => ({
  getDiscordClient: jest.fn().mockReturnValue(null),
  postModAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/userRoleService', () => ({
  isProtectedTarget: jest.fn().mockResolvedValue(false),
  getEffectiveRole: jest.fn().mockResolvedValue('user'),
}));

// ── Tests ──────────────────────────────────────────────────────────────────────
const { reverseBan, deleteMessageById } = require('../src/services/moderationActionsService');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: updateMany succeeds (count=1), findUniqueOrThrow returns ban with userId
  prismaMock.ban.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ban.findUniqueOrThrow.mockResolvedValue(mockBan);
  prismaMock.ban.findUnique.mockResolvedValue(null);
  prismaMock.user.findUnique.mockResolvedValue({ isBanned: false, savedDiscordRoles: [], discordId: null });
  prismaMock.user.update.mockResolvedValue({});
  prismaMock.$executeRaw.mockResolvedValue(1);
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

  test('throws "Ban not found" when updateMany matches 0 rows and ban does not exist', async () => {
    prismaMock.ban.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ban.findUnique.mockResolvedValue(null);

    await expect(reverseBan('missing-id', 'actor-id', 'reason')).rejects.toThrow('Ban not found');
  });

  test('throws "Ban already reversed" when updateMany matches 0 rows and ban has reversedAt set', async () => {
    prismaMock.ban.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ban.findUnique.mockResolvedValue({ reversedAt: new Date('2025-01-01') });

    await expect(reverseBan('ban-id', 'actor-id', 'reason')).rejects.toThrow('Ban already reversed');
  });

  test('concurrent calls: only first wins — second call sees count=0 and throws', async () => {
    // Simulate race: first call gets count=1, second gets count=0 (already reversed)
    prismaMock.ban.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prismaMock.ban.findUnique.mockResolvedValue({ reversedAt: new Date() });

    const [first, second] = await Promise.allSettled([
      reverseBan('ban-id', 'actor-a', 'first'),
      reverseBan('ban-id', 'actor-b', 'second'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(second.reason.message).toBe('Ban already reversed');
  });

  test('clears user ban state when user.isBanned is true', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      isBanned: true,
      savedDiscordRoles: [],
      discordId: null,
    });

    await reverseBan('ban-id', 'actor-id', 'reason');

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBan.userId },
        data: expect.objectContaining({ isBanned: false }),
      }),
    );
  });

  test('skips user state update when user.isBanned is false (ban was superseded)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      isBanned: false,
      savedDiscordRoles: [],
      discordId: null,
    });

    await reverseBan('ban-id', 'actor-id', 'reason');

    expect(prismaMock.user.update).not.toHaveBeenCalled();
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

  test('does not broadcast when the message is already deleted or missing', async () => {
    prismaMock.$executeRaw.mockResolvedValueOnce(0);
    await expect(deleteMessageById('11111111-1111-4111-8111-111111111111', 'actor-id', 'spam'))
      .rejects.toThrow('Message not found');
    expect(require('../src/websocket/handlers').broadcastMessageDeletion).not.toHaveBeenCalled();
  });
});

describe('HUD auto-event mute API', () => {
  const express = require('express');
  const request = require('supertest');
  const app = express();
  const actorId = '11111111-1111-4111-8111-111111111111';
  const targetId = '22222222-2222-4222-8222-222222222222';
  const path = `/api/moderation/users/${targetId}/hud-auto-event-mute`;
  const put = () => request(app).put(path).set('X-Test-Role', 'moderator');
  const globalPath = '/api/moderation/hud-auto-event-mute';

  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get('X-Test-Role');
    if (role) req.session = { discordUser: { id: 'moderator-discord-id', role, roles: [] } };
    next();
  });
  app.use('/api/moderation', require('../src/routes/moderationActions'));
  app.use(require('../src/middleware/errorHandler').errorHandler);

  beforeEach(() => {
    prismaMock.user.findFirst.mockResolvedValue({ id: actorId });
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
  });

  test.each([true, false])('sets the HUD auto-event mute to %s and audits the change', async (muted) => {
    const res = await put().send({ muted }).expect(200);

    expect(res.body).toEqual({ data: { hudAutoEventsMuted: muted } });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: targetId, hudAutoEventsMuted: !muted }, data: { hudAutoEventsMuted: muted },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({ data: {
      actorId, targetId, targetType: 'user', action: muted ? 'mute_hud_auto_events' : 'unmute_hud_auto_events',
    } });
    expect(require('../src/websocket/handlers').markClientMuted).not.toHaveBeenCalled();
    expect(require('../src/services/discordService').getDiscordClient).not.toHaveBeenCalled();
  });

  test('repeating the same state does not add a duplicate audit entry', async () => {
    prismaMock.user.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user.findUnique.mockResolvedValueOnce({ hudAutoEventsMuted: true });

    const res = await put().send({ muted: true }).expect(200);

    expect(res.body).toEqual({ data: { hudAutoEventsMuted: true } });
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  test('returns 404 for a missing account', async () => {
    prismaMock.user.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    await put().send({ muted: true }).expect(404);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  test('rejects unsigned users, non-staff roles, invalid state, and protected targets', async () => {
    await request(app).put(path).send({ muted: true }).expect(401);
    await request(app).put(path).set('X-Test-Role', 'developer').send({ muted: true }).expect(403);
    await put().send({ muted: 'true' }).expect(400);
    require('../src/services/userRoleService').isProtectedTarget.mockResolvedValueOnce(true);
    await put().send({ muted: true }).expect(409);

    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  test('admins can mute and unmute everyone with one audit entry per change', async () => {
    let value = null;
    const setting = prismaMock.moderationSetting;
    setting.findUnique.mockImplementation(async () => value === null ? null : { value });
    setting.createMany.mockImplementation(async ({ data }) => {
      if (value !== null) return { count: 0 };
      value = data.value;
      return { count: 1 };
    });
    setting.updateMany.mockImplementation(async ({ where, data }) => {
      if (value === where.value.not) return { count: 0 };
      value = data.value;
      return { count: 1 };
    });

    const read = () => request(app).get(globalPath).set('X-Test-Role', 'moderator');
    await read().expect(200, { data: { muted: false } });
    for (const muted of [true, true, false]) {
      await request(app).put(globalPath).set('X-Test-Role', 'admin').send({ muted }).expect(200, { data: { muted } });
      await read().expect(200, { data: { muted } });
    }
    expect(prismaMock.auditLog.create.mock.calls.map(([args]) => [args.data.actorId, args.data.action])).toEqual([
      [actorId, 'mute_hud_auto_events_globally'],
      [actorId, 'unmute_hud_auto_events_globally'],
    ]);
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });

  test('server-wide mute rejects unauthorized writes and invalid state', async () => {
    await request(app).get(globalPath).expect(401);
    await request(app).put(globalPath).set('X-Test-Role', 'moderator').send({ muted: true }).expect(403);
    await request(app).put(globalPath).set('X-Test-Role', 'admin').send({ muted: 'false' }).expect(400);
    expect(prismaMock.moderationSetting.updateMany).not.toHaveBeenCalled();
  });

  test('desktop session uses the signed-in account for role checks and audit attribution', async () => {
    const redis = await require('../src/config/redis').getRedisClient();
    const { getEffectiveRole } = require('../src/services/userRoleService');
    const desktop = (method, url, role) => {
      redis.get.mockResolvedValueOnce(actorId);
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: actorId, isBanned: false });
      getEffectiveRole.mockResolvedValueOnce(role);
      return request(app)[method](url).set('X-Auth-Token', 'desktop-test-session');
    };

    await request(app).get(path).set('X-Auth-Token', 'expired').expect(401);
    await desktop('get', path, 'user').expect(403);
    await desktop('put', globalPath, 'moderator').send({ muted: true }).expect(403);

    const findMute = desktop('get', path, 'moderator');
    prismaMock.user.findUnique.mockResolvedValueOnce({ hudAutoEventsMuted: false });
    await findMute.expect(200, { data: { hudAutoEventsMuted: false } });
    await desktop('put', path, 'moderator').send({ muted: true }).expect(200, { data: { hudAutoEventsMuted: true } });

    prismaMock.moderationSetting.createMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.moderationSetting.updateMany.mockResolvedValueOnce({ count: 1 });
    await desktop('put', globalPath, 'admin').send({ muted: true }).expect(200, { data: { muted: true } });
    expect(getEffectiveRole).toHaveBeenCalledWith(actorId);
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create.mock.calls.map(([args]) => [args.data.actorId, args.data.action])).toEqual([
      [actorId, 'mute_hud_auto_events'],
      [actorId, 'mute_hud_auto_events_globally'],
    ]);
  });
});
