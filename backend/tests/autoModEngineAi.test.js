'use strict';

/**
 * engineEvaluate — AI moderation path.
 *
 * The two invariants that matter most here:
 *   1. A healthy AI verdict SUPERSEDES the keyword layers; a degraded one hands
 *      enforcement straight back to them (fail open, never fail silent).
 *   2. Shadow mode is strictly side-effect-free — no block, no mute, no alert.
 */

const mockAutoModRuleRows = [];
const mockViolationCreate = jest.fn().mockResolvedValue({});
const mockFilterContent = jest.fn().mockResolvedValue({ blocked: false, reason: null });
const mockDetectSpam = jest.fn().mockResolvedValue({ spamDetected: false });
const mockIsProtectedTarget = jest.fn().mockResolvedValue(false);
const mockPostModAlert = jest.fn().mockResolvedValue(undefined);
const mockMuteUser = jest.fn().mockResolvedValue(undefined);
const mockClassifyContent = jest.fn();
const mockGetSettings = jest.fn();

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    autoModRule: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockAutoModRuleRows)),
    },
    autoModViolation: {
      create: jest.fn().mockImplementation((args) => mockViolationCreate(args)),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

jest.mock('../src/config/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  return { __esModule: true, default: log, ...log };
});

jest.mock('../src/services/discordService', () => ({
  postModAlert: (...args) => mockPostModAlert(...args),
}));

jest.mock('../src/services/autoModService', () => ({
  filterContent: (...args) => mockFilterContent(...args),
  detectSpam: (...args) => mockDetectSpam(...args),
}));

jest.mock('../src/services/moderationActionsService', () => ({
  muteUser: (...args) => mockMuteUser(...args),
}));

jest.mock('../src/services/userRoleService', () => ({
  isProtectedTarget: (...args) => mockIsProtectedTarget(...args),
}));

// Keep the REAL evaluateVerdict / thresholds — only the network call and the
// settings read are stubbed, so threshold logic is exercised end to end.
jest.mock('../src/services/aiModerationService', () => {
  const actual = jest.requireActual('../src/services/aiModerationService');
  return {
    ...actual,
    classifyContent: (...args) => mockClassifyContent(...args),
    getAiModerationSettings: (...args) => mockGetSettings(...args),
  };
});

const { engineEvaluate, invalidateRulesCache } = require('../src/services/autoModEngine');
const { DEFAULT_THRESHOLDS, DEFAULT_IDENTIFIER_THRESHOLDS } = require('../src/services/aiModerationService');

const USER = { id: '11111111-1111-4111-8111-111111111111', username: 'Vaultie' };

function settings(overrides = {}) {
  return {
    enabled: true,
    mode: 'enforce',
    thresholds: DEFAULT_THRESHOLDS,
    identifierThresholds: DEFAULT_IDENTIFIER_THRESHOLDS,
    ...overrides,
  };
}

function verdict(scores, flagged = true) {
  const entries = Object.entries(scores);
  const top = entries.slice().sort((a, b) => b[1] - a[1])[0];
  return {
    flagged,
    categories: Object.fromEntries(entries.map(([k, v]) => [k, v >= 0.5])),
    scores,
    maxScore: top ? top[1] : 0,
    topCategory: top ? top[0] : null,
  };
}

function pushRule(overrides = {}) {
  mockAutoModRuleRows.push({
    id: 'a0000000-0000-0000-0000-000000000004',
    name: 'AI content moderation',
    enabled: true,
    triggerType: 'AI_MODERATION',
    triggerMetadata: {},
    actions: [{ type: 'BLOCK', metadata: { customMessage: 'Message blocked by auto-mod.' } }, { type: 'ALERT' }],
    exemptChannelIds: [],
    exemptRoles: [],
    ...overrides,
  });
  invalidateRulesCache();
}

beforeEach(() => {
  mockAutoModRuleRows.length = 0;
  invalidateRulesCache();
  jest.clearAllMocks();
  mockFilterContent.mockResolvedValue({ blocked: false, reason: null });
  mockDetectSpam.mockResolvedValue({ spamDetected: false });
  mockIsProtectedTarget.mockResolvedValue(false);
  mockGetSettings.mockResolvedValue(settings());
  mockClassifyContent.mockResolvedValue(null);
});

describe('AI supersedes the keyword layers when healthy', () => {
  test('a healthy verdict skips the legacy word_filter entirely', async () => {
    mockClassifyContent.mockResolvedValue(verdict({ hate: 0.01 }, false));

    await engineEvaluate('hello wasteland', 'chan-1', USER);

    expect(mockClassifyContent).toHaveBeenCalledTimes(1);
    expect(mockFilterContent).not.toHaveBeenCalled();
  });

  test('a degraded verdict falls back to the legacy word_filter', async () => {
    mockClassifyContent.mockResolvedValue(null); // timeout / non-200 / breaker open
    mockFilterContent.mockResolvedValue({ blocked: true, reason: 'Matched prohibited phrase' });

    const res = await engineEvaluate('a slur', 'chan-1', USER);

    expect(mockFilterContent).toHaveBeenCalled();
    expect(res.block).toBe(true);
    expect(res.customMessage).toBe('Message blocked by content filter.');
  });

  test('AI disabled behaves exactly like today — word_filter runs, no API call', async () => {
    mockGetSettings.mockResolvedValue(settings({ enabled: false }));
    mockFilterContent.mockResolvedValue({ blocked: true, reason: 'Matched prohibited phrase' });

    const res = await engineEvaluate('a slur', 'chan-1', USER);

    expect(mockClassifyContent).not.toHaveBeenCalled();
    expect(mockFilterContent).toHaveBeenCalled();
    expect(res.block).toBe(true);
  });

  test('KEYWORD_PRESET rules are skipped while AI is healthy', async () => {
    mockClassifyContent.mockResolvedValue(verdict({ hate: 0.01 }, false));
    mockAutoModRuleRows.push({
      id: 'preset-rule',
      name: 'Block flagged words',
      enabled: true,
      triggerType: 'KEYWORD_PRESET',
      triggerMetadata: { presets: ['SLURS'] },
      actions: [{ type: 'BLOCK' }],
      exemptChannelIds: [],
      exemptRoles: [],
    });
    invalidateRulesCache();

    const res = await engineEvaluate('you are a whore', 'chan-1', USER);
    expect(res.block).toBe(false);
  });

  test('KEYWORD_PRESET rules come back when AI is degraded', async () => {
    mockClassifyContent.mockResolvedValue(null);
    mockAutoModRuleRows.push({
      id: 'preset-rule',
      name: 'Block flagged words',
      enabled: true,
      triggerType: 'KEYWORD_PRESET',
      triggerMetadata: { presets: ['SLURS'] },
      actions: [{ type: 'BLOCK' }],
      exemptChannelIds: [],
      exemptRoles: [],
    });
    invalidateRulesCache();

    const res = await engineEvaluate('you are a whore', 'chan-1', USER);
    expect(res.block).toBe(true);
  });

  test('admin-authored KEYWORD rules still run while AI is healthy', async () => {
    // A moderator's escape hatch for terms the classifier misses must NOT be
    // superseded — only the curated preset lists are.
    mockClassifyContent.mockResolvedValue(verdict({ hate: 0.01 }, false));
    mockAutoModRuleRows.push({
      id: 'kw-rule',
      name: 'Block a specific troll phrase',
      enabled: true,
      triggerType: 'KEYWORD',
      triggerMetadata: { keyword_filter: ['griefermcgriefface'] },
      actions: [{ type: 'BLOCK' }],
      exemptChannelIds: [],
      exemptRoles: [],
    });
    invalidateRulesCache();

    const res = await engineEvaluate('hi griefermcgriefface', 'chan-1', USER);
    expect(res.block).toBe(true);
  });
});

describe('staff exemption', () => {
  test('staff content is never transmitted to OpenAI', async () => {
    mockIsProtectedTarget.mockResolvedValue(true);

    const res = await engineEvaluate('anything at all', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(mockClassifyContent).not.toHaveBeenCalled();
    expect(mockFilterContent).not.toHaveBeenCalled();
  });
});

describe('enforcement', () => {
  test('ignores flagged profanity and game-content categories instead of alerting', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({
      harassment: 0.99,
      sexual: 0.99,
      violence: 0.99,
      'self-harm/instructions': 0.99,
    }));

    const res = await engineEvaluate('this game is bullshit; that deathclaw hit hard', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
    expect(mockPostModAlert).not.toHaveBeenCalled();
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  test('blocks high-confidence targeted harassment when directly addressed', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ harassment: 0.99 }));

    const res = await engineEvaluate('you are a worthless griefer', 'chan-1', USER);

    expect(res.block).toBe(true);
    expect(res.matches[0].matchedKeyword).toBe('harassment');
  });

  test.each([
    ['@Vaultie you are trash', 'harassment'],
    ['<@123456789012345678> you are trash', 'harassment/threatening'],
  ])('recognizes an explicit target form: %s', async (content, category) => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ [category]: 0.99 }));

    const res = await engineEvaluate(content, 'chan-1', USER);

    expect(res.block).toBe(true);
    expect(res.matches[0].matchedKeyword).toBe(category);
  });

  test('does not match a high score when OpenAI says the verdict is unflagged', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ harassment: 0.99 }, false));

    const res = await engineEvaluate('you are trash', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  test('does not let an unaddressed harassment score hide an enforceable hate score', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ harassment: 0.99, hate: 0.96 }));

    const res = await engineEvaluate('that group is disgusting', 'chan-1', USER);

    expect(res.block).toBe(true);
    expect(res.matches[0].matchedKeyword).toBe('hate');
  });

  test('blocks a category that meets its enforce threshold', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ 'hate/threatening': 0.9 }));

    const res = await engineEvaluate('threatening hate', 'chan-1', USER);

    expect(res.block).toBe(true);
    expect(res.customMessage).toBe('Message blocked by auto-mod.');
    expect(res.matches[0].triggerType).toBe('AI_MODERATION');
    expect(res.matches[0].matchedKeyword).toBe('hate/threatening');
  });

  test('a flagged but sub-threshold category is ignored entirely', async () => {
    pushRule();
    // `violence` is deliberately outside the targeted-attack policy.
    mockClassifyContent.mockResolvedValue(verdict({ violence: 0.97 }));

    const res = await engineEvaluate('I will nuke your camp', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
    expect(mockPostModAlert).not.toHaveBeenCalled();
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  test('a below-threshold targeted category is ignored rather than alerted', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ harassment: 0.949 }));

    const res = await engineEvaluate('you are a loser', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
    expect(mockPostModAlert).not.toHaveBeenCalled();
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  test('ordinary game violence does not block', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ violence: 0.93, 'violence/graphic': 0.81 }));

    const res = await engineEvaluate('killed 40 Scorched at the nuke zone', 'chan-1', USER);
    expect(res.block).toBe(false);
  });

  test('an unflagged clean verdict produces no match at all', async () => {
    pushRule();
    mockClassifyContent.mockResolvedValue(verdict({ violence: 0.02 }, false));

    const res = await engineEvaluate('anyone want to trade plans', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  test('a per-rule threshold override wins within the targeted-attack category set', async () => {
    pushRule({ triggerMetadata: { thresholds: { harassment: 0.9 } } });
    mockClassifyContent.mockResolvedValue(verdict({ harassment: 0.95 }));

    const res = await engineEvaluate('you are a violent griefer', 'chan-1', USER);
    expect(res.block).toBe(true);
    expect(res.matches[0].matchedKeyword).toBe('harassment');
  });
});

describe('shadow mode', () => {
  test('never blocks, even far above the threshold', async () => {
    pushRule();
    mockGetSettings.mockResolvedValue(settings({ mode: 'shadow' }));
    mockClassifyContent.mockResolvedValue(verdict({ 'sexual/minors': 0.99 }));

    const res = await engineEvaluate('the worst possible message', 'chan-1', USER);
    expect(res.block).toBe(false);
  });

  test('is side-effect-free — no alert, no mute — but still records the violation', async () => {
    pushRule({ actions: [{ type: 'BLOCK' }, { type: 'ALERT' }, { type: 'TIMEOUT' }] });
    mockGetSettings.mockResolvedValue(settings({ mode: 'shadow' }));
    mockClassifyContent.mockResolvedValue(verdict({ 'hate/threatening': 0.95 }));

    await engineEvaluate('threatening hate', 'chan-1', USER);

    expect(mockPostModAlert).not.toHaveBeenCalled();
    expect(mockMuteUser).not.toHaveBeenCalled();
    expect(mockViolationCreate).toHaveBeenCalledTimes(1);
    expect(mockViolationCreate.mock.calls[0][0].data.actionsTaken).toEqual([
      { type: 'SHADOW', success: true, detail: 'shadow mode — logged, not enforced' },
    ]);
  });
});

describe('violation record', () => {
  test('carries the full category map, the peak score, and the original text', async () => {
    pushRule();
    const scores = { 'hate/threatening': 0.9, violence: 0.4 };
    mockClassifyContent.mockResolvedValue(verdict(scores));

    await engineEvaluate('threatening hate', 'chan-1', USER);

    const data = mockViolationCreate.mock.calls[0][0].data;
    expect(data.aiCategories).toEqual(scores);
    expect(data.aiMaxScore).toBeCloseTo(0.9);
    expect(data.messageContent).toBe('threatening hate');
    expect(data.ruleId).toBe('a0000000-0000-0000-0000-000000000004');
  });

  test('non-AI rules leave the AI columns unset', async () => {
    mockClassifyContent.mockResolvedValue(null);
    mockAutoModRuleRows.push({
      id: 'kw-rule',
      name: 'Keyword rule',
      enabled: true,
      triggerType: 'KEYWORD',
      triggerMetadata: { keyword_filter: ['badword'] },
      actions: [{ type: 'BLOCK' }],
      exemptChannelIds: [],
      exemptRoles: [],
    });
    invalidateRulesCache();

    await engineEvaluate('this has badword in it', 'chan-1', USER);

    const data = mockViolationCreate.mock.calls[0][0].data;
    expect(data.aiCategories).toBeUndefined();
    expect(data.aiMaxScore).toBeUndefined();
  });
});

describe('exemptions still apply to the AI rule', () => {
  test('exempt channel skips the rule', async () => {
    pushRule({ exemptChannelIds: ['chan-exempt'] });
    mockClassifyContent.mockResolvedValue(verdict({ 'hate/threatening': 0.99 }));

    const res = await engineEvaluate('threatening hate', 'chan-exempt', USER);
    expect(res.block).toBe(false);
    expect(res.matches).toHaveLength(0);
  });

  test('exempt role skips the rule', async () => {
    pushRule({ exemptRoles: ['role-123'] });
    mockClassifyContent.mockResolvedValue(verdict({ 'hate/threatening': 0.99 }));

    const res = await engineEvaluate('threatening hate', 'chan-1', { ...USER, roles: ['role-123'] });
    expect(res.block).toBe(false);
  });
});

describe('spam detection is unaffected by AI health', () => {
  test('still blocks while the AI verdict is healthy and clean', async () => {
    mockClassifyContent.mockResolvedValue(verdict({ hate: 0.01 }, false));
    mockDetectSpam.mockResolvedValue({ spamDetected: true });

    const res = await engineEvaluate('spam spam spam', 'chan-1', USER);

    expect(res.block).toBe(true);
    expect(res.customMessage).toContain('Spam');
  });
});

describe('fail open', () => {
  test('a throwing classifier degrades to the keyword filter instead of crashing', async () => {
    mockClassifyContent.mockRejectedValue(new Error('boom'));
    mockFilterContent.mockResolvedValue({ blocked: false, reason: null });

    const res = await engineEvaluate('some message', 'chan-1', USER);

    expect(res.block).toBe(false);
    expect(mockFilterContent).toHaveBeenCalled();
  });
});
