'use strict';

// Mock database and prisma BEFORE requiring the service
jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  healthCheck: jest.fn().mockResolvedValue(true),
  withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    release: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}));

const svc = require('../src/services/communityStatsService');

describe('communityStats — versionDistribution removed', () => {
  it('getCommunityStats returns an object WITHOUT a versionDistribution key', async () => {
    const result = await svc.getCommunityStats('90d');
    expect(result).not.toHaveProperty('versionDistribution');
  });

  it('getCommunityStats shape still has downloadsPerVersion and messageSplit', async () => {
    const result = await svc.getCommunityStats('90d');
    expect(result).toHaveProperty('downloadsPerVersion');
    expect(result).toHaveProperty('messageSplit');
  });
});
