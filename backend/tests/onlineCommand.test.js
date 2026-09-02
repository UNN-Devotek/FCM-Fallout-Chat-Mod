describe('/online command', () => {
  let tryHandleCommand;
  let mockGetGlobalOnlineCount;
  let mockGetServerPlayersForUser;

  beforeEach(() => {
    jest.resetModules();

    mockGetGlobalOnlineCount = jest.fn();
    mockGetServerPlayersForUser = jest.fn();

    jest.doMock('../src/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    jest.doMock('../src/config/prisma', () => ({
      __esModule: true,
      default: { chatCommand: { findMany: jest.fn().mockResolvedValue([]) } },
    }));
    jest.doMock('../src/services/serverStatusService', () => ({ __esModule: true, getServerStatus: jest.fn() }));
    jest.doMock('../src/services/nukeCodesService', () => ({ __esModule: true, getNukeCodes: jest.fn() }));
    jest.doMock('../src/services/campService', () => ({ __esModule: true, getCampItem: jest.fn() }));
    jest.doMock('../src/services/onlinePresenceService', () => ({
      __esModule: true,
      getGlobalOnlineCount: mockGetGlobalOnlineCount,
    }));
    jest.doMock('../src/services/playerListService', () => ({
      __esModule: true,
      getServerPlayersForUser: mockGetServerPlayersForUser,
    }));
    jest.doMock('../src/services/giveawayService', () => ({
      __esModule: true,
      createGiveaway: jest.fn(),
      joinGiveaway: jest.fn(),
      leaveGiveaway: jest.fn(),
      cancelGiveaway: jest.fn(),
      listActive: jest.fn().mockResolvedValue([]),
      listRecent: jest.fn().mockResolvedValue([]),
      GiveawayError: class GiveawayError extends Error {},
    }));

    ({ tryHandleCommand } = require('../src/services/commandService'));
  });

  test('returns a private online reply with global chat count and world count when available', async () => {
    mockGetGlobalOnlineCount.mockResolvedValue(42);
    mockGetServerPlayersForUser.mockResolvedValue({
      endpoint: 'session:sess-1',
      players: ['Alpha', 'Bravo', 'Charlie'],
      updatedAt: Date.now(),
    });

    const result = await tryHandleCommand('/online', 'user-1', 'Dweller', 'chan-1', 'General', null, 7, null);

    expect(result).toMatchObject({
      handled: true,
      actionType: 'private',
      targetChannelId: 'chan-1',
      metadata: { type: 'online_status', totalOnline: 42, worldPlayerCount: 3 },
    });
    expect(result.botMessage).toBe('42 users online in chat. 3 players in your world.');
    expect(mockGetGlobalOnlineCount).toHaveBeenCalledWith(7);
    expect(mockGetServerPlayersForUser).toHaveBeenCalledWith('user-1');
  });

  test('omits the world line when no player list is known', async () => {
    mockGetGlobalOnlineCount.mockResolvedValue(5);
    mockGetServerPlayersForUser.mockResolvedValue(null);

    const result = await tryHandleCommand('/online', 'user-2', 'Dweller', 'chan-2', 'General');

    expect(result).toMatchObject({
      handled: true,
      actionType: 'private',
      metadata: { type: 'online_status', totalOnline: 5, worldPlayerCount: null },
    });
    expect(result.botMessage).toBe('5 users online in chat.');
  });

  test('lists /online in the built-in help output', async () => {
    const result = await tryHandleCommand('/help', 'user-3', 'Dweller', 'chan-3', 'General');

    expect(result).toMatchObject({ handled: true, actionType: 'private' });
    expect(result.botMessage).toContain('/online — Show total users online in chat');
  });
});
