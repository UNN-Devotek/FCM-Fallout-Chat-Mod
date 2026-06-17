'use strict';

/**
 * Unit tests for the latestReleaseVersion cache module.
 *
 * Tests:
 *   (a) init / get / set behaviour
 *   (b) initLatestVersion populates the cache from Prisma
 *   (c) initLatestVersion is non-fatal on DB error
 */

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Re-require the module fresh for each test to reset module state.
// We use jest.isolateModules to get a clean module on each require.

describe('latestReleaseVersion cache module', () => {
  let mod;
  let prismaMock;

  beforeEach(() => {
    jest.resetModules();
    // Re-apply the prisma mock after resetModules
    jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
    jest.mock('../src/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    mod = require('../src/services/latestReleaseVersion');
    prismaMock = require('../src/config/prisma').default;
  });

  // (a) get / set
  it('getLatestVersion returns null before any set or init', () => {
    expect(mod.getLatestVersion()).toBeNull();
  });

  it('setLatestVersion updates the value returned by getLatestVersion', () => {
    mod.setLatestVersion('1.3.90');
    expect(mod.getLatestVersion()).toBe('1.3.90');
  });

  it('setLatestVersion overwrites a previously cached value', () => {
    mod.setLatestVersion('1.3.90');
    mod.setLatestVersion('1.4.0');
    expect(mod.getLatestVersion()).toBe('1.4.0');
  });

  // (b) initLatestVersion populates from DB
  it('initLatestVersion sets the version from the latest DB release', async () => {
    prismaMock.release.findFirst.mockResolvedValue({ version: '1.3.85', publishedAt: new Date() });
    await mod.initLatestVersion();
    expect(mod.getLatestVersion()).toBe('1.3.85');
    expect(prismaMock.release.findFirst).toHaveBeenCalledWith({ orderBy: { publishedAt: 'desc' } });
  });

  it('initLatestVersion leaves cache null when no release exists in DB', async () => {
    prismaMock.release.findFirst.mockResolvedValue(null);
    await mod.initLatestVersion();
    expect(mod.getLatestVersion()).toBeNull();
  });

  // (c) non-fatal on DB error
  it('initLatestVersion does not throw when DB query fails', async () => {
    prismaMock.release.findFirst.mockRejectedValue(new Error('DB connection lost'));
    await expect(mod.initLatestVersion()).resolves.toBeUndefined();
    expect(mod.getLatestVersion()).toBeNull();
  });
});
