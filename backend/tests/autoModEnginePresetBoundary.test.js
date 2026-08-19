'use strict';

const mockAutoModRuleRows = [];
const mockViolationCreate = jest.fn().mockResolvedValue({});
const mockFilterContent = jest.fn().mockResolvedValue({ blocked: false, reason: null });
const mockDetectSpam = jest.fn().mockResolvedValue({ spamDetected: false });

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    autoModRule: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockAutoModRuleRows)),
    },
    autoModViolation: {
      create: jest.fn().mockImplementation((args) => mockViolationCreate(args)),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../src/config/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  return { __esModule: true, default: log, ...log };
});

jest.mock('../src/services/discordService', () => ({
  postModAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/autoModService', () => ({
  filterContent: (...args) => mockFilterContent(...args),
  detectSpam: (...args) => mockDetectSpam(...args),
}));

jest.mock('../src/services/moderationActionsService', () => ({
  muteUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/userRoleService', () => ({
  isProtectedTarget: jest.fn().mockResolvedValue(false),
}));

// AI moderation state is explicit here rather than incidental: these cases pin
// the keyword preset boundary, which only applies in FALLBACK mode (AI disabled
// or degraded). `mockAiSettings`/`mockAiVerdict` let each block choose.
let mockAiSettings = { enabled: false, mode: 'shadow', thresholds: {}, identifierThresholds: {} };
let mockAiVerdict = null;

jest.mock('../src/services/aiModerationService', () => {
  const actual = jest.requireActual('../src/services/aiModerationService');
  return {
    ...actual,
    getAiModerationSettings: jest.fn(() => Promise.resolve(mockAiSettings)),
    classifyContent: jest.fn(() => Promise.resolve(mockAiVerdict)),
  };
});

const { engineEvaluate, invalidateRulesCache } = require('../src/services/autoModEngine');

function pushPresetRule(presets) {
  mockAutoModRuleRows.push({
    id: 'preset-rule-1',
    name: 'Block flagged words',
    enabled: true,
    triggerType: 'KEYWORD_PRESET',
    triggerMetadata: { presets },
    actions: [{ type: 'BLOCK', metadata: { customMessage: 'Message blocked by auto-mod.' } }],
    exemptChannelIds: [],
    exemptRoles: [],
  });
}

describe('autoModEngine KEYWORD_PRESET profanity/slur boundary', () => {
  const user = { id: 'user-1', username: 'VaultDweller' };

  beforeEach(() => {
    mockAutoModRuleRows.length = 0;
    jest.clearAllMocks();
    invalidateRulesCache();
    mockFilterContent.mockResolvedValue({ blocked: false, reason: null });
    mockDetectSpam.mockResolvedValue({ spamDetected: false });
    mockViolationCreate.mockResolvedValue({});
    // AI off — the presets are the enforcing layer, as they were before the
    // OpenAI integration landed.
    mockAiSettings = { enabled: false, mode: 'shadow', thresholds: {}, identifierThresholds: {} };
    mockAiVerdict = null;
  });

  it('allows common profanity when the default seeded rule uses only the slur preset', async () => {
    pushPresetRule(['SLURS']);

    const result = await engineEvaluate('this jackass is full of bullshit', 'channel-1', user);

    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  it('blocks a slur through the SLURS preset without depending on PROFANITY', async () => {
    pushPresetRule(['SLURS']);

    const result = await engineEvaluate('you nigger', 'channel-1', user);

    expect(result.block).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedKeyword).toBe('nigger');
    expect(mockViolationCreate).toHaveBeenCalledTimes(1);
  });

  it('allows a standalone profanity/slur token without a direct target in fallback mode', async () => {
    pushPresetRule(['SLURS']);

    const result = await engineEvaluate('bitch', 'channel-1', user);

    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  it('does not classify slurs as PROFANITY anymore', async () => {
    pushPresetRule(['PROFANITY']);

    const result = await engineEvaluate('you nigger', 'channel-1', user);

    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  it('allows non-targeted sexual-content discussion', async () => {
    pushPresetRule(['SEXUAL_CONTENT']);

    const result = await engineEvaluate('that message mentions rape', 'channel-1', user);

    expect(result.block).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  it('still blocks targeted sexual-content language in fallback mode', async () => {
    pushPresetRule(['SEXUAL_CONTENT']);

    const result = await engineEvaluate('@Vaultie send nudes', 'channel-1', user);

    expect(result.block).toBe(true);
    expect(result.matches[0].matchedKeyword).toBe('nudes');
  });

  it('supports an explicit admin opt-out from target gating', async () => {
    mockAutoModRuleRows.push({
      id: 'broad-preset-rule',
      name: 'Explicit broad preset override',
      enabled: true,
      triggerType: 'KEYWORD_PRESET',
      triggerMetadata: { presets: ['SLURS'], require_target: false },
      actions: [{ type: 'BLOCK' }],
      exemptChannelIds: [],
      exemptRoles: [],
    });
    invalidateRulesCache();

    const result = await engineEvaluate('bitch', 'channel-1', user);

    expect(result.block).toBe(true);
    expect(result.matches[0].matchedKeyword).toBe('bitch');
  });

  // ── Fallback-mode guarantees ───────────────────────────────────────────────
  // The presets are now a fallback rather than the primary check. These pin that
  // the boundary above still holds in the two ways fallback is entered — and
  // that it correctly stands down when the classifier is healthy.

  it('still holds when AI is ENABLED but degraded (null verdict)', async () => {
    mockAiSettings = { enabled: true, mode: 'enforce', thresholds: {}, identifierThresholds: {} };
    mockAiVerdict = null; // timeout / non-200 / circuit breaker open
    pushPresetRule(['SLURS']);

    const result = await engineEvaluate('you nigger', 'channel-1', user);

    expect(result.block).toBe(true);
    expect(result.matches[0].matchedKeyword).toBe('nigger');
  });

  it('still allows common profanity in fallback mode', async () => {
    mockAiSettings = { enabled: true, mode: 'enforce', thresholds: {}, identifierThresholds: {} };
    mockAiVerdict = null;
    pushPresetRule(['SEXUAL_CONTENT', 'SLURS']);

    const result = await engineEvaluate('this jackass is full of bullshit', 'channel-1', user);

    expect(result.block).toBe(false);
  });

  it('stands down entirely once the AI verdict is healthy', async () => {
    mockAiSettings = { enabled: true, mode: 'enforce', thresholds: {}, identifierThresholds: {} };
    mockAiVerdict = { flagged: false, categories: {}, scores: { hate: 0.01 }, maxScore: 0.01, topCategory: 'hate' };
    pushPresetRule(['SLURS']);

    const result = await engineEvaluate('you nigger', 'channel-1', user);

    // The classifier owns this call now. With an empty thresholds map and an
    // unflagged verdict there is nothing to enforce, so the preset does not fire.
    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });
});
