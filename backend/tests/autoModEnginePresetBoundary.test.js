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
  });

  it('allows common profanity when the default seeded rule uses only sexual-content and slur presets', async () => {
    pushPresetRule(['SEXUAL_CONTENT', 'SLURS']);

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

  it('does not classify slurs as PROFANITY anymore', async () => {
    pushPresetRule(['PROFANITY']);

    const result = await engineEvaluate('you nigger', 'channel-1', user);

    expect(result.block).toBe(false);
    expect(mockViolationCreate).not.toHaveBeenCalled();
  });

  it('keeps sexual-content preset behavior unchanged', async () => {
    pushPresetRule(['SEXUAL_CONTENT']);

    const result = await engineEvaluate('that message mentions rape', 'channel-1', user);

    expect(result.block).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedKeyword).toBe('rape');
    expect(mockViolationCreate).toHaveBeenCalledTimes(1);
  });
});
