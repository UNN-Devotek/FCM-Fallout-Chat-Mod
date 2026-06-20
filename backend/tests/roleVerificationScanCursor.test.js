'use strict';

/**
 * Regression test for the redis v4 -> v6 SCAN cursor change.
 *
 * node-redis v5+ returns the SCAN cursor as a STRING ('0'), not a number (0).
 * destroyAdminSessions() loops `do { ... } while (cursor !== 0)`, so without
 * coercing the cursor to a number, '0' !== 0 is always true and the loop spins
 * forever on every role revocation. This test pins the termination contract by
 * driving the loop with a string cursor and failing fast (the mock throws after
 * a few calls) if the cursor never terminates.
 */

const DISCORD_ID = '111111111111111111';
const MATCH_KEY = 'sess:match';
const NOMATCH_KEY = 'sess:nomatch';

let scanCalls = 0;
const del = jest.fn().mockResolvedValue(1);

const mockRedis = {
  // v5+ returns cursor as a string. First page returns one matching + one
  // non-matching session and the terminal cursor '0'. If the caller fails to
  // coerce and loops, we throw on the 4th call so the test fails fast instead
  // of hanging the worker.
  scan: jest.fn(async () => {
    scanCalls += 1;
    if (scanCalls > 3) throw new Error('SCAN cursor never terminated (string "0" not coerced)');
    return scanCalls === 1
      ? { cursor: '0', keys: [MATCH_KEY, NOMATCH_KEY] }
      : { cursor: '0', keys: [] };
  }),
  get: jest.fn(async (key) =>
    key === MATCH_KEY
      ? JSON.stringify({ discordUser: { id: DISCORD_ID } })
      : JSON.stringify({ discordUser: { id: 'someone-else' } })),
  del,
};

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedis),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

const { destroyAdminSessions } = require('../src/services/roleVerificationService');

describe('roleVerificationService.destroyAdminSessions — SCAN cursor termination', () => {
  beforeEach(() => {
    scanCalls = 0;
    del.mockClear();
    mockRedis.scan.mockClear();
  });

  it('terminates after one page when the cursor is the string "0"', async () => {
    await destroyAdminSessions(DISCORD_ID);
    // The terminal '0' cursor must end the loop on the first page.
    expect(mockRedis.scan).toHaveBeenCalledTimes(1);
  });

  it('deletes only the sessions belonging to the revoked Discord user', async () => {
    await destroyAdminSessions(DISCORD_ID);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith([MATCH_KEY]);
  });
});
