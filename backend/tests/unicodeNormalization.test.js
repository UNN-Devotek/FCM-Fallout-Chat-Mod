'use strict';

/**
 * Tests for Unicode canonicalization in the automod, name-filter, and Discord
 * relay pipelines.
 *
 * Bare NFC normalization is largely ineffective against combining-diacritic
 * bypass: a denylist phrase compiled as /\bcafé\b/i never matches user-supplied
 * "café" because é is not an ASCII word char, so the trailing \b boundary cannot
 * form, and NFC leaves the visible accent in place so ASCII denylist phrases miss
 * diacritic-padded variants. The fix canonicalises with
 *   canon(s) = s.normalize('NFD').replace(/\p{M}/gu, '')
 * at ALL filter entry points (filterContent, findProhibitedPhrase, the engine,
 * nameBlacklistService, and stripMentions) — matching on the canonical form while
 * STORING / broadcasting the original.
 *
 * These tests exercise the REAL implementations (src/* transpiled on the fly via
 * the esbuild Jest transform), so reverting any part of the fix fails the suite.
 *
 * NFD inputs are built from explicit code points (base letter + U+0301 COMBINING
 * ACUTE ACCENT) so the source encoding is unambiguous: 'café' is the
 * decomposed "café", distinct from the precomposed 'café'.
 */

// U+0301 COMBINING ACUTE ACCENT
const ACUTE = '́';

// ── Prisma mock ────────────────────────────────────────────────────────────────
const mockWordFilterRows = [];
const mockNameBlacklistRows = [];
const mockAutoModRuleRows = [];
// Captures the data passed to autoModViolation.create so the engine test can assert
// the PERSISTED message is the original (not the canon form).
const mockViolationCreate = jest.fn().mockResolvedValue({});

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    wordFilter: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockWordFilterRows)),
    },
    nameBlacklistEntry: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockNameBlacklistRows)),
    },
    moderationSetting: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    autoModRule: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockAutoModRuleRows)),
    },
    autoModViolation: {
      create: jest.fn().mockImplementation((args) => mockViolationCreate(args)),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { on: jest.fn() },
  healthCheck: jest.fn().mockResolvedValue(true),
}));

const mockRedisMultiResult = [0, 1, 1, 1];
const mockMulti = {
  zRemRangeByScore: jest.fn().mockReturnThis(),
  zAdd: jest.fn().mockReturnThis(),
  zCard: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(mockRedisMultiResult),
};
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  publish: jest.fn().mockResolvedValue(1),
  multi: jest.fn().mockReturnValue(mockMulti),
  zCard: jest.fn().mockResolvedValue(0),
};
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedis),
}));

// ── discordService heavy-dependency mocks ───────────────────────────────────────
// stripMentions is a pure function on discordService, but the module pulls in
// discord.js + the Bull message queue + several sub-services at import time. Mock
// those so `require('../src/services/discordService')` resolves without opening a
// real Redis/Bull connection or a Discord gateway. None of these are exercised by
// stripMentions itself — we call the REAL exported stripMentions below.
jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn(), login: jest.fn(), destroy: jest.fn(),
    channels: { fetch: jest.fn() },
    guilds: { cache: { first: jest.fn() }, fetch: jest.fn() },
  })),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 8, GuildMembers: 16, GuildMessageReactions: 32 },
  Partials: { Message: 'Message', Channel: 'Channel', Reaction: 'Reaction' },
  TextChannel: jest.fn(),
  EmbedBuilder: jest.fn().mockImplementation(() => ({
    setTitle: jest.fn().mockReturnThis(), setDescription: jest.fn().mockReturnThis(),
    setColor: jest.fn().mockReturnThis(), setTimestamp: jest.fn().mockReturnThis(),
    addFields: jest.fn().mockReturnThis(),
  })),
  ActivityType: { Playing: 0 },
}));
jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: { DISCORD_TOKEN: '', DISCORD_CHANNEL_ID: 'default-discord-ch', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));
jest.mock('../src/config/logger', () => {
  // Real logger module sets BOTH `export default logger` and `module.exports =
  // logger`, so consumers see logger methods on `.default`. Mirror that shape
  // (with __esModule) so esbuild's __toESM interop resolves `.default.warn` to a fn.
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  return { __esModule: true, default: log, ...log };
});
jest.mock('../src/queues/messagePersist', () => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() }));
jest.mock('../src/services/voiceService', () => ({ default: { register: jest.fn(), handleVoiceStateUpdate: jest.fn() } }));
jest.mock('../src/services/reactionRoleService', () => ({ default: { register: jest.fn(), handleReactionAdd: jest.fn(), handleReactionRemove: jest.fn() } }));
jest.mock('../src/services/ticketService', () => ({ default: { register: jest.fn(), openReportThread: jest.fn() } }));
jest.mock('../src/services/wikiCatalogService', () => ({ getEntry: jest.fn(), bestMatch: jest.fn() }));

// ── autoModEngine action-side dependency mocks ──────────────────────────────────
// The engine's TIMEOUT/MUTE_OVERLAY actions call muteUser, and every check is
// short-circuited for staff via isProtectedTarget. Stub both so the engine test
// exercises the REAL matching + persistence path without touching Discord/DB mutes.
const mockMuteUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/moderationActionsService', () => ({
  muteUser: (...args) => mockMuteUser(...args),
}));
const mockIsProtectedTarget = jest.fn().mockResolvedValue(false);
jest.mock('../src/services/userRoleService', () => ({
  isProtectedTarget: (...args) => mockIsProtectedTarget(...args),
}));

const { canon } = require('../src/utils/textCanon');
const {
  filterContent,
  findProhibitedPhrase,
  resetCache,
} = require('../src/services/autoModService');
const nameBlacklist = require('../src/services/nameBlacklistService');
// Real, exported stripMentions — NOT a reimplementation. Reverting the canon()
// detection branch in discordService.stripMentions fails the LOAD-BEARING test below.
const discordService = require('../src/services/discordService');
const { stripMentions } = discordService;
// Real engine + cache invalidator — engineEvaluate is invoked directly below so the
// matchContent=canon(content) change and the persist/broadcast-the-original fix are
// genuinely exercised. Reverting either fails an assertion.
const { engineEvaluate, invalidateRulesCache } = require('../src/services/autoModEngine');

beforeEach(() => {
  mockWordFilterRows.length = 0;
  mockNameBlacklistRows.length = 0;
  mockAutoModRuleRows.length = 0;
  jest.clearAllMocks();
  mockMulti.exec.mockResolvedValue(mockRedisMultiResult);
  mockViolationCreate.mockResolvedValue({});
  mockMuteUser.mockResolvedValue(undefined);
  mockIsProtectedTarget.mockResolvedValue(false);
  // The word-filter is cached at module scope with a 60s TTL; without an explicit
  // reset, rows pushed in one test bleed into the next (and the cache from a prior
  // test's getWordFilter() call would mask freshly-pushed rows). resetCache()
  // clears the compiled cache + generation counter so each test sees ONLY its rows.
  resetCache();
  // The engine caches automod_rules for 30s — bust it so each test sees ONLY the
  // rows it pushed (otherwise a rule from a prior test bleeds across).
  invalidateRulesCache();
});

// ── canon() — the canonicalization primitive ───────────────────────────────────

describe('canon()', () => {
  it('strips a combining acute accent to the base letter', () => {
    expect(canon('cafe' + ACUTE)).toBe('cafe');
  });

  it('reduces a precomposed accented letter to its base', () => {
    expect(canon('café')).toBe('cafe'); // precomposed é → e
  });

  it('is a no-op on plain ASCII', () => {
    expect(canon('hello world')).toBe('hello world');
  });

  it('strips diacritic padding from an ASCII slur', () => {
    // n + combining-acute + igger  →  nigger
    expect(canon('n' + ACUTE + 'igger')).toBe('nigger');
  });
});

// ── filterContent — canonical matching ─────────────────────────────────────────

describe('filterContent — canonical (NFD + strip-marks) matching', () => {
  it('blocks an ASCII word-filter phrase (no diacritics)', async () => {
    mockWordFilterRows.push({ phrase: 'test', isRegex: false, testMode: false });
    const result = await filterContent('this is a test phrase');
    expect(result.blocked).toBe(true);
  });

  it('does NOT block clean content (no false positive)', async () => {
    const result = await filterContent('normal message without prohibited content');
    expect(result.blocked).toBe(false);
  });

  it('LOAD-BEARING: blocks a word-filter phrase against NFD-decomposed input', async () => {
    // Filter phrase "café" (precomposed). Input is DECOMPOSED: "cafe" + U+0301.
    // Bare NFC of the input is "café", which /\bcafé\b/i (no u flag) FAILS to
    // match because the trailing \b cannot form after the non-ASCII é. The canon
    // form collapses both phrase and input to "cafe", and the u-flagged \bcafe\b
    // matches. Reverting to NFC makes this assertion fail.
    mockWordFilterRows.push({ phrase: 'café', isRegex: false, testMode: false });
    const result = await filterContent('I went to cafe' + ACUTE + ' yesterday');
    expect(result.blocked).toBe(true);
  });

  it('blocks a BASELINE_DENYLIST slur padded with a combining diacritic', async () => {
    // "fuck" with a combining acute on the u — bypasses a bare NFC/ASCII filter,
    // canon collapses it back to "fuck" which the baseline denylist catches.
    const result = await filterContent('go fu' + ACUTE + 'ck yourself');
    expect(result.blocked).toBe(true);
  });

  it('cache does not bleed: a phrase from a prior test is gone after resetCache', async () => {
    // No rows pushed this test; with resetCache() in beforeEach the "test"/"café"
    // phrases from earlier tests must not still be cached.
    const result = await filterContent('this is a test phrase');
    expect(result.blocked).toBe(false);
  });
});

// ── findProhibitedPhrase — usernames / party names ─────────────────────────────

describe('findProhibitedPhrase — canonical matching on identifiers', () => {
  it('returns null for a clean username', async () => {
    expect(await findProhibitedPhrase('FriendlyWanderer')).toBeNull();
  });

  it('rejects a slur embedded in an identifier (baseline, no diacritics)', async () => {
    // 5+ char slurs use substring matching in BASELINE_DENYLIST_NAMES.
    expect(await findProhibitedPhrase('nigger76')).toBe('nigger');
  });

  it('LOAD-BEARING: rejects an NFD-decomposed slur in a username', async () => {
    // "nigger" with a combining acute on the first n: n + U+0301 + igger76.
    // Un-normalized matching (the pre-fix findProhibitedPhrase) would MISS this;
    // canon collapses it to "nigger76" and the baseline denylist catches it.
    const candidate = 'n' + ACUTE + 'igger76';
    expect(await findProhibitedPhrase(candidate)).toBe('nigger');
  });

  it('rejects an NFD-decomposed slur in a party name via DB word_filter', async () => {
    mockWordFilterRows.push({ phrase: 'badword', isRegex: false, testMode: false });
    // "badword" decomposed via a combining mark on the a.
    const partyName = 'ba' + ACUTE + 'dword squad';
    expect(await findProhibitedPhrase(partyName)).toBe('badword');
  });
});

// ── nameBlacklistService — canonical matching ──────────────────────────────────

describe('nameBlacklistService — canonical (NFD + strip-marks) matching', () => {
  it('contains-match rejects an NFD-decomposed candidate', async () => {
    mockNameBlacklistRows.push({ id: '1', pattern: 'griefer', matchType: 'contains', enabled: true });
    await nameBlacklist.loadBlacklist();
    // "griefer" with a combining acute on the e — decomposed.
    const candidate = 'Xx_grie' + ACUTE + 'fer_xX';
    expect(nameBlacklist.isBlacklisted(candidate)).toBe(true);
    const match = nameBlacklist.findBlacklistMatch(candidate);
    expect(match && match.pattern).toBe('griefer');
  });

  it('exact-match rejects an NFD-decomposed candidate', async () => {
    mockNameBlacklistRows.push({ id: '2', pattern: 'café', matchType: 'exact', enabled: true });
    await nameBlacklist.loadBlacklist();
    expect(nameBlacklist.isBlacklisted('cafe' + ACUTE)).toBe(true);
  });

  it('regex-match (u-flag) rejects an NFD-decomposed candidate', async () => {
    mockNameBlacklistRows.push({ id: '3', pattern: '^spammer\\d+$', matchType: 'regex', enabled: true });
    await nameBlacklist.loadBlacklist();
    // "spammer" decomposed: spa + combining-acute + mmer123
    const candidate = 'spa' + ACUTE + 'mmer123';
    expect(nameBlacklist.isBlacklisted(candidate)).toBe(true);
  });

  it('does NOT flag a clean name (no false positive)', async () => {
    mockNameBlacklistRows.push({ id: '4', pattern: 'griefer', matchType: 'contains', enabled: true });
    await nameBlacklist.loadBlacklist();
    expect(nameBlacklist.isBlacklisted('FriendlyVaultDweller')).toBe(false);
  });
});

// ── stripMentions — canonical @everyone / @here neutralization ──────────────────

// These call the REAL discordService.stripMentions (now exported), NOT a local
// reimplementation. Reverting the canon()-detection branch in production (back to
// a bare `/@(everyone|here)/.test(text)` against the un-canonicalised string) makes
// the LOAD-BEARING test below fail, proving the coverage is genuine.
describe('stripMentions (real discordService export) — canonical contract', () => {
  it('is the real exported function, not a stub', () => {
    expect(typeof stripMentions).toBe('function');
  });

  it('strips a plain @everyone ping', () => {
    expect(stripMentions('@everyone hello')).toBe('everyone hello');
    expect(stripMentions('@here check this')).toBe('here check this');
  });

  it('LOAD-BEARING: strips a combining-diacritic-padded @everyone', () => {
    // @ + e + combining-acute + veryone — bare NFC leaves the accent so the
    // literal /@(everyone|here)/ never matches; canon collapses it and the ping
    // is neutralised before reaching Discord. With the production canon-detection
    // branch reverted, the live @everyone would survive (Discord renders the
    // U+0301 inert) and this assertion fails.
    const padded = '@e' + ACUTE + 'veryone get in here';
    expect(stripMentions(padded)).toBe('everyone get in here');
  });

  it('leaves innocent accented text byte-faithful when no ping is present', () => {
    const msg = 'meet at the cafe' + ACUTE + ' near vault 76';
    // No @everyone/@here token → original (decomposed) text is preserved verbatim.
    expect(stripMentions(msg)).toBe(msg);
  });

  it('resolves user / role / channel mention tokens', () => {
    expect(stripMentions('<@123456789012345678>')).toBe('[user]');
    expect(stripMentions('<@&123456789012345678>')).toBe('[role]');
    expect(stripMentions('<#123456789012345678>')).toBe('[channel]');
  });
});

// ── autoModEngine.engineEvaluate — canon match, original persist/broadcast ───────

// Drives the REAL engineEvaluate (not a mock) with a KEYWORD rule (BLOCK + ALERT)
// and a DECOMPOSED (NFD) message that only matches once collapsed by canon().
// Asserts the two production behaviours the brief mandated:
//   (a) the engine BLOCKS on the canonical form (matchContent = canon(content)),
//   (b) the persisted violation row AND the broadcast ALERT embed carry the
//       ORIGINAL (decomposed) content, never the canon form — the persist/broadcast
//       divergence fix.
// Reverting matchContent back to the raw `content` makes (a) fail (the NFD message
// no longer matches the "badword" keyword); reverting the persist to store
// canon(content) makes (b) fail.
describe('autoModEngine.engineEvaluate — canon matching, original persisted/broadcast', () => {
  // KEYWORD rule that blocks on "badword" and posts a mod-log ALERT.
  function pushBlockAlertKeywordRule() {
    mockAutoModRuleRows.push({
      id: 'rule-1',
      name: 'No badwords',
      enabled: true,
      triggerType: 'KEYWORD',
      triggerMetadata: { keyword_filter: ['badword'], regex_patterns: [], allow_list: [] },
      actions: [
        { type: 'BLOCK', metadata: { customMessage: 'Message blocked by auto-mod.' } },
        { type: 'ALERT' },
      ],
      exemptChannelIds: [],
      exemptRoles: [],
    });
  }

  const user = { id: 'user-1', username: 'VaultDweller' };

  it('LOAD-BEARING: BLOCKS an NFD-decomposed keyword and persists the ORIGINAL content', async () => {
    pushBlockAlertKeywordRule();
    // Spy on the REAL postModAlert to capture the ALERT embed content (broadcast
    // evidence). It is non-throwing/fire-and-forget in prod; resolve it here.
    const alertSpy = jest
      .spyOn(discordService, 'postModAlert')
      .mockResolvedValue(undefined);

    // "badword" decomposed via a combining mark on the a: ba + U+0301 + dword.
    // canon() collapses it to "badword" (matches the keyword); the raw string does
    // NOT contain the literal "badword", so reverting matchContent makes this miss.
    const original = 'you are a ba' + ACUTE + 'dword for real';

    const result = await engineEvaluate(original, 'channel-1', user);

    // (a) blocked on the canonical form
    expect(result.block).toBe(true);
    expect(result.customMessage).toBe('Message blocked by auto-mod.');
    expect(result.matches.length).toBeGreaterThan(0);

    // (b1) the PERSISTED violation row stores the ORIGINAL (decomposed) content,
    // not the canon form.
    expect(mockViolationCreate).toHaveBeenCalledTimes(1);
    const persisted = mockViolationCreate.mock.calls[0][0].data.messageContent;
    expect(persisted).toBe(original);
    expect(persisted).toContain(ACUTE); // the combining mark survived into storage
    expect(persisted).not.toBe(canon(original));

    // (b2) the BROADCAST ALERT embed shows the ORIGINAL content, not the canon form.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const embed = alertSpy.mock.calls[0][0];
    const contentField = embed.fields.find((f) => f.name === 'Content');
    expect(contentField.value).toContain(original);
    expect(contentField.value).not.toContain(canon(original) + ' for'); // canon form absent

    alertSpy.mockRestore();
  });

  it('does NOT block clean content (no false positive through the engine)', async () => {
    pushBlockAlertKeywordRule();
    const result = await engineEvaluate('a perfectly nice message', 'channel-1', user);
    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });
});
