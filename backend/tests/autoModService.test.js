'use strict';

// ── Prisma mock — the service uses prisma.wordFilter / prisma.moderationSetting
const mockWordFilterRows = [];
const mockModerationSettingRows = [];
jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    wordFilter: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockWordFilterRows)),
    },
    moderationSetting: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockModerationSettingRows)),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'));

// Keep database mock so server.ts imports don't blow up
jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { on: jest.fn() },
  healthCheck: jest.fn().mockResolvedValue(true),
}));

const mockRedisMultiResult = [0, 1, 1, 1]; // [zRemRange, zAdd, zCard, expire]
const mockMulti = {
  zRemRangeByScore: jest.fn().mockReturnThis(),
  zAdd: jest.fn().mockReturnThis(),
  zCard: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(mockRedisMultiResult),
};
const mockRedis = {
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  multi: jest.fn().mockReturnValue(mockMulti),
  zRemRangeByScore: jest.fn(),
  zAdd: jest.fn(),
  zCard: jest.fn(),
  expire: jest.fn(),
};

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedis),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

const { filterContent, detectSpam, resetCache, findProhibitedPhrase } = require('../src/services/autoModService');
const prismaModule = require('../src/config/prisma');
const prisma = prismaModule.default || prismaModule;

describe('filterContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWordFilterRows.length = 0;
    mockModerationSettingRows.length = 0;
    // Restore mock implementations after clearAllMocks resets them
    prisma.wordFilter.findMany.mockImplementation(() => Promise.resolve(mockWordFilterRows));
    prisma.moderationSetting.findMany.mockImplementation(() => Promise.resolve(mockModerationSettingRows));
    prisma.auditLog.create.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});
    resetCache(); // clear module-level filter cache between tests
  });

  it('allows clean content when filter is empty', async () => {
    const result = await filterContent('Hello wasteland!');
    expect(result.blocked).toBe(false);
  });

  it('blocks content matching a prohibited phrase', async () => {
    mockWordFilterRows.push({ phrase: 'badword', isRegex: false, testMode: false });
    const result = await filterContent('You said badword here');
    expect(result.blocked).toBe(true);
  });

  it('is case-insensitive for phrase matching', async () => {
    mockWordFilterRows.push({ phrase: 'badword', isRegex: false, testMode: false });
    const result = await filterContent('BADWORD is blocked');
    expect(result.blocked).toBe(true);
  });

  it('blocks content matching a regex filter', async () => {
    mockWordFilterRows.push({ phrase: 'b[a4]d', isRegex: true, testMode: false });
    const result = await filterContent('this is b4d content');
    expect(result.blocked).toBe(true);
  });

  it('ignores malformed regex filters gracefully', async () => {
    mockWordFilterRows.push({ phrase: '[invalid(', isRegex: true, testMode: false });
    const result = await filterContent('safe content');
    expect(result.blocked).toBe(false);
  });

  it('does not block word containing phrase as substring (word-boundary regression)', async () => {
    // "ass" should not block "class" — word-boundary matching prevents false positives
    mockWordFilterRows.push({ phrase: 'ass', isRegex: false, testMode: false });
    const result = await filterContent('I attended a class today');
    expect(result.blocked).toBe(false);
  });

  it('blocks exact word match at word boundary', async () => {
    mockWordFilterRows.push({ phrase: 'ass', isRegex: false, testMode: false });
    const result = await filterContent('You are an ass for doing that');
    expect(result.blocked).toBe(true);
  });

  it('skips regex phrases exceeding max length', async () => {
    const longRegex = 'a'.repeat(501);
    mockWordFilterRows.push({ phrase: longRegex, isRegex: true, testMode: false });
    const result = await filterContent('aaa');
    expect(result.blocked).toBe(false);
  });
});

describe('findProhibitedPhrase (names denylist)', () => {
  // findProhibitedPhrase uses BASELINE_DENYLIST_NAMES which applies substring
  // matching for long terms but word-boundary matching for short terms (≤ 4 chars)
  // to prevent false positives on innocent words.

  // ── False-positive regressions ────────────────────────────────────────────
  it('does not block "Ninpheas raid school" — "ho" substring in "school"', async () => {
    const match = await findProhibitedPhrase('Ninpheas raid school');
    expect(match).toBeNull();
  });

  it('does not block "raccoon hunters" — "coon" substring in "raccoon"', async () => {
    const match = await findProhibitedPhrase('raccoon hunters');
    expect(match).toBeNull();
  });

  it('does not block "grape raiders" — "rape" substring in "grape"', async () => {
    const match = await findProhibitedPhrase('grape raiders');
    expect(match).toBeNull();
  });

  it('does not block "peacock patrol" — "cock" substring in "peacock"', async () => {
    const match = await findProhibitedPhrase('peacock patrol');
    expect(match).toBeNull();
  });

  // ── Short terms still blocked as standalone words ─────────────────────────
  it('blocks "ho" as a standalone word in a party name', async () => {
    const match = await findProhibitedPhrase('the ho patrol');
    expect(match).toBe('ho');
  });

  it('blocks "rape" as a standalone word', async () => {
    const match = await findProhibitedPhrase('no rape allowed');
    expect(match).toBe('rape');
  });

  it('blocks "coon" as a standalone word', async () => {
    const match = await findProhibitedPhrase('dirty coon clan');
    expect(match).toBe('coon');
  });

  // ── Long slurs still caught as substrings ─────────────────────────────────
  it('blocks "nigger" embedded in a concatenated name like "nigger76"', async () => {
    const match = await findProhibitedPhrase('nigger76');
    expect(match).toBe('nigger');
  });

  it('blocks "whore" (5 chars) embedded without spaces like "whore76"', async () => {
    const match = await findProhibitedPhrase('whore76');
    expect(match).toBe('whore');
  });
});

describe('detectSpam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMulti.exec.mockResolvedValue([0, 1, 1, 1]); // zCard = 1 (under limit)
    prisma.wordFilter.findMany.mockImplementation(() => Promise.resolve([]));
    prisma.moderationSetting.findMany.mockImplementation(() => Promise.resolve(mockModerationSettingRows));
  });

  it('does not flag normal message rate', async () => {
    const { spamDetected } = await detectSpam('user-123');
    expect(spamDetected).toBe(false);
  });

  it('flags when message count exceeds limit', async () => {
    mockMulti.exec.mockResolvedValueOnce([0, 1, 10, 1]); // zCard = 10 (> 6 limit)
    const { spamDetected } = await detectSpam('user-123');
    expect(spamDetected).toBe(true);
  });
});
