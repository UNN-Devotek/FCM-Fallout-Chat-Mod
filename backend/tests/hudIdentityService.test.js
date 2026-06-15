'use strict';
/**
 * Unit tests for hudIdentityService (M7 identity resolution).
 *
 * Coverage:
 *  - deriveIdentityHash: deterministic HMAC output
 *  - resolveHudIdentity: Priority 1 (existing hash), name reconcile
 *  - resolveHudIdentity: Priority 2 (auto-pair by character name, exactly 1 match)
 *  - resolveHudIdentity: Priority 2 ambiguity guard (2+ matches → fall through to #3)
 *  - resolveHudIdentity: Priority 3 (auto-provision new user)
 *  - Character name change on reconnect updates fo76CharacterName, keeps same userId/hash
 *  - getActiveBlock: returns ban/mute, respects expiresAt
 *  - blockHash / unblockHash smoke test
 */

// ── Mock heavy deps ───────────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({ ping: jest.fn().mockResolvedValue('PONG'), on: jest.fn() }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn(), isOpen: false },
  subscriberClient: { on: jest.fn(), isOpen: false },
}));

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  setBroadcast: jest.fn(),
  relayToDiscord: jest.fn(),
}));

jest.mock('../src/queues/messagePersist', () => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() }));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

// ── Imports ───────────────────────────────────────────────────────────────────

const { deriveIdentityHash, resolveHudIdentity, getActiveBlock, blockHash, unblockHash,
  usingDefaultIdentitySecret, DEV_DEFAULT_IDENTITY_SECRET } =
  require('../src/services/hudIdentityService');
// environment.ts ends with `module.exports = env`, so require() returns env itself.
const env = require('../src/config/environment');
const prismaStub = require('./setup/prisma-stub').default;

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no existing user
  prismaStub.user.findUnique.mockResolvedValue(null);
  prismaStub.user.findMany.mockResolvedValue([]);
  prismaStub.user.create.mockImplementation(({ data }) => Promise.resolve({ id: data.id ?? 'new-user-id', ...data }));
  prismaStub.user.update.mockResolvedValue({});
  prismaStub.hudIdentityBlock.findMany.mockResolvedValue([]);
  prismaStub.hudIdentityBlock.create.mockResolvedValue({});
  prismaStub.hudIdentityBlock.deleteMany.mockResolvedValue({ count: 1 });
});

// ── deriveIdentityHash ────────────────────────────────────────────────────────

describe('deriveIdentityHash', () => {
  it('returns a 64-char hex string', () => {
    const hash = deriveIdentityHash('TestAccount');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input produces same output', () => {
    expect(deriveIdentityHash('Devotek-')).toBe(deriveIdentityHash('Devotek-'));
  });

  it('is sensitive to input — different accounts produce different hashes', () => {
    expect(deriveIdentityHash('AccountA')).not.toBe(deriveIdentityHash('AccountB'));
  });
});

// ── resolveHudIdentity ────────────────────────────────────────────────────────

describe('resolveHudIdentity — Priority 1: existing hash', () => {
  it('returns existing userId when hash already linked', async () => {
    const hash = deriveIdentityHash('MyAccount');
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'existing-user',
      fo76CharacterName: 'SameChar',
      identityHash: hash,
    });

    const result = await resolveHudIdentity('MyAccount', 'SameChar');
    expect(result).toEqual({ userId: 'existing-user', identityHash: hash });
    expect(prismaStub.user.update).not.toHaveBeenCalled(); // no rename needed
  });

  it('updates fo76CharacterName when character name changes on reconnect', async () => {
    const hash = deriveIdentityHash('MyAccount');
    prismaStub.user.findUnique.mockResolvedValue({
      id: 'existing-user',
      fo76CharacterName: 'OldChar',
      identityHash: hash,
    });
    prismaStub.user.update.mockResolvedValue({});

    const result = await resolveHudIdentity('MyAccount', 'NewChar');
    expect(result.userId).toBe('existing-user');
    expect(result.identityHash).toBe(hash);
    // identityHash and userId are unchanged — only the name was reconciled
    expect(prismaStub.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'existing-user' },
      data: { fo76CharacterName: 'NewChar' },
    }));
  });
});

describe('resolveHudIdentity — Priority 2: auto-pair by character name', () => {
  it('attaches identityHash to existing user when exactly one match', async () => {
    prismaStub.user.findUnique.mockResolvedValue(null); // no hash match
    prismaStub.user.findMany.mockResolvedValue([{ id: 'discord-user' }]); // exactly 1

    const result = await resolveHudIdentity('NewAccount', 'ExistingChar');
    const expectedHash = deriveIdentityHash('NewAccount');
    expect(result).toEqual({ userId: 'discord-user', identityHash: expectedHash });
    expect(prismaStub.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'discord-user' },
      data: expect.objectContaining({ identityHash: expectedHash, fo76AccountName: 'NewAccount', fo76CharacterName: 'ExistingChar' }),
    }));
    expect(prismaStub.user.create).not.toHaveBeenCalled();
  });

  it('does NOT auto-pair when two+ users claim the same character name', async () => {
    prismaStub.user.findUnique.mockResolvedValue(null);
    prismaStub.user.findMany.mockResolvedValue([{ id: 'user-a' }, { id: 'user-b' }]); // 2 matches
    prismaStub.user.create.mockResolvedValue({ id: 'new-provisional' });

    const result = await resolveHudIdentity('SomeAccount', 'AmbiguousChar');
    // Must provision a new user, not attach to either existing one.
    expect(result.userId).toBe('new-provisional');
    // Verify update was NOT called with either of the ambiguous user IDs (no auto-pair)
    const updateCalls = prismaStub.user.update.mock.calls;
    const pairedToA = updateCalls.some(([args]) => args?.where?.id === 'user-a');
    const pairedToB = updateCalls.some(([args]) => args?.where?.id === 'user-b');
    expect(pairedToA).toBe(false);
    expect(pairedToB).toBe(false);
  });
});

describe('resolveHudIdentity — Priority 2b: auto-pair by accountName (username/discordUsername match)', () => {
  it('attaches identityHash when accountName matches username of one unlinked user (no char-name match)', async () => {
    prismaStub.user.findUnique.mockResolvedValue(null); // no hash match
    // findMany call 1: character name match → 0
    // findMany call 2: accountName match → 1
    prismaStub.user.findMany
      .mockResolvedValueOnce([])             // Priority 2a: no char-name matches
      .mockResolvedValueOnce([{ id: 'discord-user-no-charname' }]); // Priority 2b: 1 match

    const result = await resolveHudIdentity('Devotek-', 'Devotek');
    const expectedHash = deriveIdentityHash('Devotek-');
    expect(result).toEqual({ userId: 'discord-user-no-charname', identityHash: expectedHash });
    expect(prismaStub.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'discord-user-no-charname' },
      data: expect.objectContaining({
        identityHash: expectedHash,
        fo76AccountName: 'Devotek-',
        fo76CharacterName: 'Devotek',
      }),
    }));
    expect(prismaStub.user.create).not.toHaveBeenCalled();
  });

  it('does NOT auto-pair by accountName when two+ users match', async () => {
    prismaStub.user.findUnique.mockResolvedValue(null);
    prismaStub.user.findMany
      .mockResolvedValueOnce([])                                        // 2a: no char matches
      .mockResolvedValueOnce([{ id: 'user-a' }, { id: 'user-b' }]);   // 2b: 2 matches → ambiguous
    prismaStub.user.create.mockResolvedValue({ id: 'provisioned' });

    const result = await resolveHudIdentity('AmbigAccount', 'SomeChar');
    expect(result.userId).toBe('provisioned');
    expect(prismaStub.user.update).not.toHaveBeenCalled();
  });

  it('skips 2b when 2a already matched (exactly 1 char-name match)', async () => {
    prismaStub.user.findUnique.mockResolvedValue(null);
    // 2a fires with 1 match — 2b should never be reached
    prismaStub.user.findMany.mockResolvedValueOnce([{ id: 'char-match-user' }]);

    const result = await resolveHudIdentity('SomeAccount', 'SomeChar');
    expect(result.userId).toBe('char-match-user');
    // findMany should only have been called once (2a), not a second time for 2b
    expect(prismaStub.user.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('resolveHudIdentity — Priority 3: auto-provision', () => {
  it('creates a new user when no hash match and no name match', async () => {
    prismaStub.user.findUnique
      .mockResolvedValueOnce(null)   // no existing hash
      .mockResolvedValueOnce(null);  // no username collision
    prismaStub.user.findMany.mockResolvedValue([]); // no name matches

    const provisioned = { id: 'brand-new-user' };
    prismaStub.user.create.mockResolvedValue(provisioned);

    const result = await resolveHudIdentity('BrandNewAccount', 'BrandNewChar');
    expect(result.userId).toBe('brand-new-user');
    expect(prismaStub.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fo76AccountName: 'BrandNewAccount',
        fo76CharacterName: 'BrandNewChar',
        identityHash: deriveIdentityHash('BrandNewAccount'),
      }),
    }));
  });
});

// ── getActiveBlock ────────────────────────────────────────────────────────────

describe('getActiveBlock', () => {
  it('returns null when no blocks exist', async () => {
    prismaStub.hudIdentityBlock.findMany.mockResolvedValue([]);
    const result = await getActiveBlock('some-hash');
    expect(result).toBeNull();
  });

  it('returns ban block when present (ban > mute)', async () => {
    const now = new Date();
    prismaStub.hudIdentityBlock.findMany.mockResolvedValue([
      { id: '1', identityHash: 'h', type: 'mute', reason: null, createdBy: null, createdAt: now, expiresAt: null },
      { id: '2', identityHash: 'h', type: 'ban',  reason: 'cheating', createdBy: null, createdAt: now, expiresAt: null },
    ]);
    const result = await getActiveBlock('h');
    expect(result.type).toBe('ban');
  });

  it('returns mute block when only mute exists', async () => {
    const now = new Date();
    prismaStub.hudIdentityBlock.findMany.mockResolvedValue([
      { id: '1', identityHash: 'h', type: 'mute', reason: 'spam', createdBy: null, createdAt: now, expiresAt: null },
    ]);
    const result = await getActiveBlock('h');
    expect(result.type).toBe('mute');
  });
});

// ── blockHash / unblockHash ───────────────────────────────────────────────────

describe('blockHash and unblockHash', () => {
  it('calls prisma.hudIdentityBlock.create with correct fields', async () => {
    await blockHash({ identityHash: 'h', type: 'mute', reason: 'spam', createdBy: 'mod-1' });
    expect(prismaStub.hudIdentityBlock.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ identityHash: 'h', type: 'mute', reason: 'spam', createdBy: 'mod-1' }),
    }));
  });

  it('calls prisma.hudIdentityBlock.deleteMany with identityHash filter', async () => {
    const count = await unblockHash({ identityHash: 'h', type: 'mute' });
    expect(prismaStub.hudIdentityBlock.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ identityHash: 'h', type: 'mute' }) }),
    );
    expect(count).toBe(1);
  });
});

// ── usingDefaultIdentitySecret (SR-003) ───────────────────────────────────────

describe('usingDefaultIdentitySecret', () => {
  const original = env.HUD_IDENTITY_SECRET;
  afterEach(() => { env.HUD_IDENTITY_SECRET = original; });

  it('returns true when the secret is the public dev default', () => {
    env.HUD_IDENTITY_SECRET = DEV_DEFAULT_IDENTITY_SECRET;
    expect(usingDefaultIdentitySecret()).toBe(true);
  });

  it('returns true when the secret is empty/unset', () => {
    env.HUD_IDENTITY_SECRET = '';
    expect(usingDefaultIdentitySecret()).toBe(true);
  });

  it('returns false when a real secret is configured', () => {
    env.HUD_IDENTITY_SECRET = 'a-strong-production-secret-value';
    expect(usingDefaultIdentitySecret()).toBe(false);
  });

  it('DEV_DEFAULT_IDENTITY_SECRET stays in sync with environment.ts default', () => {
    // If this fails, the literal default in config/environment.ts changed and the
    // guard sentinel must be updated to match.
    expect(DEV_DEFAULT_IDENTITY_SECRET).toBe('dev-hud-identity-secret-change-me');
  });
});
