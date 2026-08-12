'use strict';

/** Overlay cosmetics endpoints are self-only: the server derives the target from
 * X-Auth-Token's req.user, never from a renderer-supplied path or body id. */
const prismaMock = {
  user: { findUnique: jest.fn() },
  userCosmetic: { findUnique: jest.fn() },
  adminUser: { findUnique: jest.fn() },
};

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'), { virtual: true });
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: { SUPPORTER_TIER_ENABLED: true, DISCORD_SERVER_SHOP_URL: 'https://support.invalid' },
}));
jest.mock('../src/services/supporterService', () => ({
  getSupporterStatus: jest.fn().mockResolvedValue({
    tier: 'supporter', entitledTier: 'supporter', privilegesActive: true,
    hasEntitlement: true, status: 'active', source: 'manual',
  }),
}));
jest.mock('../src/services/cosmetics/cosmeticsService', () => ({
  resolveCosmetics: jest.fn().mockResolvedValue({
    userId: 'session-user', nameColor: '#57DBDB', effectId: null, tag: null,
    badges: ['supporter'], tier: 'supporter',
  }),
  applyCosmetics: jest.fn(),
  resetCosmetics: jest.fn(),
}));

const controller = require('../src/controllers/cosmeticsController');
const cosmetics = require('../src/services/cosmetics/cosmeticsService');

function response() {
  return { json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'session-user', discordId: 'discord-1', chatName: 'VaultDweller', username: 'fallback-name',
  });
  prismaMock.userCosmetic.findUnique.mockResolvedValue({
    colorPresetId: 'cryo', customColorHex: null, effectId: null, customTag: null, cosmeticsEnabled: true,
  });
});

describe('overlay cosmetics controller', () => {
  it('preserves null versus omitted cosmetic patch fields', () => {
    expect(controller.parseCosmeticPatch({ colorPresetId: null, effectId: 'glow-soft', ignored: 'x' }))
      .toEqual({ colorPresetId: null, effectId: 'glow-soft' });
  });

  it('gets appearance only for the install-token account', async () => {
    const res = response();
    const next = jest.fn();
    await controller.getOverlayCosmetics({ user: { id: 'session-user' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'session-user' } }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ displayName: 'VaultDweller', supporter: expect.objectContaining({ tier: 'supporter' }) }),
    }));
  });

  it('writes only the install-token account through the shared cosmetics service', async () => {
    cosmetics.applyCosmetics.mockResolvedValue({
      ok: true,
      cosmetics: { userId: 'session-user', nameColor: '#57DBDB', effectId: null, tag: null, badges: [], tier: 'supporter' },
      changed: ['colorPresetId'],
    });
    const res = response();
    const next = jest.fn();
    await controller.patchOverlayCosmetics(
      { user: { id: 'session-user' }, body: { colorPresetId: 'cryo', userId: 'someone-else' } },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(cosmetics.applyCosmetics).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'session-user', patch: { colorPresetId: 'cryo' }, actor: { kind: 'self', discordId: 'discord-1' },
    }));
  });
});
