'use strict';

describe('/minerva command metadata', () => {
  let buildMinervaResponse;

  beforeEach(() => {
    jest.resetModules();
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
      getGlobalOnlineCount: jest.fn(),
    }));
    jest.doMock('../src/services/playerListService', () => ({
      __esModule: true,
      getServerPlayersForUser: jest.fn(),
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

    ({ buildMinervaResponse } = require('../src/services/commandService'));
  });

  test('includes a structured attribution link for the overlay card', () => {
    const result = buildMinervaResponse();

    expect(result.metadata).toMatchObject({
      type: 'minerva',
      sourceName: 'Fallout Builds',
      sourceUrl: 'https://www.falloutbuilds.com/fo76/minerva',
    });
    expect(result.text).toContain('More info at falloutbuilds.com/fo76/minerva');
  });
});
