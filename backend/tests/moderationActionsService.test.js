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
    findUnique: jest.fn(),
    update: jest.fn(),
  },
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
