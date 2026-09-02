'use strict';
/**
 * Free chat-name write path. The profile endpoint and Discord `/name` modal both
 * call this service, so these tests lock down validation, storage and live refresh
 * in one place rather than testing two transports with duplicated rules.
 */

const prismaMock = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
};
const refreshClientIdentity = jest.fn();
const findBlacklistMatch = jest.fn();
const findProhibitedPhrase = jest.fn();

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'), { virtual: true });
jest.mock('../src/services/nameBlacklistService', () => ({ findBlacklistMatch }));
jest.mock('../src/services/autoModService', () => ({ findProhibitedPhrase }));
jest.mock('../src/websocket/handlers', () => ({ refreshClientIdentity }));

const { setChatName } = require('../src/services/chatNameService');

const USER = {
  id: 'user-1',
  chatName: null,
  username: 'FalloutName',
  discordUsername: 'vaultdweller',
  discordDisplayName: 'Vault Dweller',
  installToken: 'install-token',
};

describe('setChatName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ ...USER });
    prismaMock.user.update.mockImplementation(async ({ data }) => ({ ...USER, chatName: data.chatName }));
    findBlacklistMatch.mockReturnValue(null);
    findProhibitedPhrase.mockResolvedValue(null);
  });

  it('stores a normalized free name and refreshes connected clients', async () => {
    const result = await setChatName({ userId: USER.id, chatName: '  Vault  Dweller  ', source: 'website' });

    expect(result).toEqual({ ok: true, chatName: 'Vault Dweller', changed: true });
    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: USER.id }, data: { chatName: 'Vault Dweller' },
    }));
    expect(refreshClientIdentity).toHaveBeenCalledWith(
      USER.id, USER.username, USER.discordUsername, USER.discordDisplayName,
      USER.installToken, 'Vault Dweller',
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'chat_name_updated', metadata: { source: 'website', cleared: false } }),
    }));
  });

  it('clears to the normal Fallout 76 / Discord-derived identity', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...USER, chatName: 'Old Name' });
    const result = await setChatName({ userId: USER.id, chatName: null, source: 'discord' });

    expect(result).toEqual({ ok: true, chatName: null, changed: true });
    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { chatName: null } }));
    expect(refreshClientIdentity).toHaveBeenCalledWith(
      USER.id, USER.username, USER.discordUsername, USER.discordDisplayName, USER.installToken, null,
    );
  });

  it('rejects invalid or blacklisted names before it writes', async () => {
    const invalid = await setChatName({ userId: USER.id, chatName: 'x', source: 'website' });
    expect(invalid).toMatchObject({ ok: false, reason: 'invalid_name', code: 'too_short' });

    findBlacklistMatch.mockReturnValue({ pattern: 'blocked' });
    const blocked = await setChatName({ userId: USER.id, chatName: 'blocked-name', source: 'discord' });
    expect(blocked).toMatchObject({ ok: false, reason: 'blacklisted' });
    expect(blocked.message).not.toContain('blocked');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
