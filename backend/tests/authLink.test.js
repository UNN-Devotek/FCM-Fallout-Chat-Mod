'use strict';

const { generateLinkCode, normalizeLinkCode } = require('../src/services/linkCodeService');

describe('linkCodeService', () => {
  const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  describe('generateLinkCode', () => {
    it('generates an 8-character code', () => {
      const code = generateLinkCode();
      expect(code).toHaveLength(8);
    });

    it('only uses Crockford base32 alphabet (no I, L, O, U)', () => {
      for (let i = 0; i < 100; i++) {
        const code = generateLinkCode();
        for (const ch of code) {
          expect(CROCKFORD_ALPHABET).toContain(ch);
        }
        expect(code).not.toMatch(/[ILOU]/);
      }
    });

    it('generates different codes each call', () => {
      const codes = new Set(Array.from({ length: 20 }, () => generateLinkCode()));
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe('normalizeLinkCode', () => {
    it('uppercases and strips hyphens', () => {
      expect(normalizeLinkCode('abcd-efgh')).toBe('ABCDEFGH');
    });

    it('strips spaces', () => {
      expect(normalizeLinkCode('ABCD EFGH')).toBe('ABCDEFGH');
    });

    it('handles already-normalized codes', () => {
      expect(normalizeLinkCode('ABCDEFGH')).toBe('ABCDEFGH');
    });
  });
});

describe('linkedIdentityService', () => {
  describe('isBannedIdentity (unit — mocked Prisma)', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('returns false when no ban row exists', async () => {
      jest.mock('../src/config/prisma', () => ({
        bannedIdentity: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      }));
      const { isBannedIdentity } = require('../src/services/linkedIdentityService');
      const result = await isBannedIdentity('discord', '12345');
      expect(result).toBe(false);
    });

    it('returns true when a ban row exists', async () => {
      jest.mock('../src/config/prisma', () => ({
        bannedIdentity: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'uuid',
            provider: 'discord',
            providerUid: '12345',
          }),
        },
      }));
      const { isBannedIdentity } = require('../src/services/linkedIdentityService');
      const result = await isBannedIdentity('discord', '12345');
      expect(result).toBe(true);
    });
  });

  describe('unlinkProviderIdentity — refuses last provider', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('refuses to unlink when nexus is not linked (deleteMany returns count 0)', async () => {
      jest.mock('../src/config/prisma', () => ({
        user: {
          findUnique: jest.fn().mockResolvedValue({ discordId: 'disc123' }),
        },
        linkedIdentity: {
          count: jest.fn().mockResolvedValue(0),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          findFirst: jest.fn().mockResolvedValue({ provider: 'discord' }),
        },
        bannedIdentity: { findUnique: jest.fn().mockResolvedValue(null) },
      }));
      const { unlinkProviderIdentity } = require('../src/services/linkedIdentityService');
      const result = await unlinkProviderIdentity('user-uuid', 'nexus');
      expect(result.ok).toBe(false);
    });

    it('refuses when unlinking nexus would leave no providers', async () => {
      jest.mock('../src/config/prisma', () => ({
        user: {
          findUnique: jest.fn().mockResolvedValue({ discordId: null }),
        },
        linkedIdentity: {
          count: jest.fn().mockResolvedValue(0),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn().mockResolvedValue({ provider: 'nexus' }),
        },
        bannedIdentity: { findUnique: jest.fn().mockResolvedValue(null) },
      }));
      const { unlinkProviderIdentity } = require('../src/services/linkedIdentityService');
      const result = await unlinkProviderIdentity('user-uuid', 'nexus');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('last_provider');
    });
  });
});

// ---- redeemLinkCode unit tests -----------------------------------------------
// Flow: relay issues code per relayUserId; authed FCM user redeems on /link.
// redeemLinkCode(rawCode, redeemedByUserId) — requireAuth on the route.
// On success: sets usedAt + redeemedByUserId; returns { ok: true, relayUserId }.
// Relay polls WHERE code = $1 AND used_at IS NOT NULL; reads redeemed_by_user_id.

describe('redeemLinkCode unit tests', () => {
  const FCM_USER_ID = 'fcm-user-uuid';

  beforeEach(() => {
    jest.resetModules();
  });

  it('returns not_found when code does not exist', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
    }));
    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('NOTEXIST', FCM_USER_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('returns expired when code is past expiresAt', async () => {
    const pastDate = new Date(Date.now() - 1000);
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          expiresAt: pastDate,
          usedAt: null,
          attempts: 0,
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    }));
    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('ABCDEFGH', FCM_USER_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('returns already_used when usedAt is set', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          expiresAt: new Date(Date.now() + 60000),
          usedAt: new Date(),
          attempts: 0,
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    }));
    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('ABCDEFGH', FCM_USER_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_used');
  });

  it('returns max_attempts when attempts >= 5', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          expiresAt: new Date(Date.now() + 60000),
          usedAt: null,
          attempts: 5,
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    }));
    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('ABCDEFGH', FCM_USER_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('max_attempts');
  });

  it('happy path: returns ok with relayUserId and marks used with redeemedByUserId', async () => {
    const mockUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          expiresAt: new Date(Date.now() + 60000),
          usedAt: null,
          attempts: 0,
        }),
        update: jest.fn(),
        updateMany: mockUpdateMany,
      },
    }));
    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('ABCDEFGH', FCM_USER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relayUserId).toBe('relay-user-1');
    }
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'uuid',
        usedAt: null,
        attempts: { lt: 5 },
        expiresAt: { gt: expect.any(Date) },
      },
      data: {
        attempts: { increment: 1 },
        usedAt: expect.any(Date),
        redeemedByUserId: FCM_USER_ID,
      },
    });
  });

  it('reports already_used when a concurrent redeemer wins the conditional update', async () => {
    const live = {
      id: 'uuid',
      code: 'ABCDEFGH',
      relayUserId: 'relay-user-1',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      attempts: 0,
    };
    const used = { ...live, usedAt: new Date(), redeemedByUserId: 'other-user' };
    const mockFindUnique = jest.fn()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(used);
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: mockFindUnique,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    }));

    const { redeemLinkCode } = require('../src/services/linkCodeService');
    const result = await redeemLinkCode('ABCDEFGH', FCM_USER_ID);
    expect(result).toEqual({ ok: false, reason: 'already_used' });
  });
});

// ---- validateAndConsume unit tests -------------------------------------------
// Relay-side seam: read-only poll to check if a code has been redeemed.

describe('validateAndConsume unit tests', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns not_found when code does not exist', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: { findUnique: jest.fn().mockResolvedValue(null) },
    }));
    const { validateAndConsume } = require('../src/services/linkCodeService');
    const result = await validateAndConsume('NOTEXIST');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('returns not_redeemed when usedAt is null', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          redeemedByUserId: null,
          usedAt: null,
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
    }));
    const { validateAndConsume } = require('../src/services/linkCodeService');
    const result = await validateAndConsume('ABCDEFGH');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_redeemed');
  });

  it('returns ok with relayUserId and redeemedByUserId when code is redeemed', async () => {
    jest.mock('../src/config/prisma', () => ({
      hudLinkCode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'uuid',
          code: 'ABCDEFGH',
          relayUserId: 'relay-user-1',
          redeemedByUserId: 'fcm-user-uuid',
          usedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        }),
      },
    }));
    const { validateAndConsume } = require('../src/services/linkCodeService');
    const result = await validateAndConsume('ABCDEFGH');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relayUserId).toBe('relay-user-1');
      expect(result.redeemedByUserId).toBe('fcm-user-uuid');
    }
  });
});
