'use strict';

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn() },
    autoModRule: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  },
}));

jest.mock('../src/services/autoModEngine', () => ({
  invalidateRulesCache: jest.fn(),
}));

const prisma = require('../src/config/prisma').default;
const {
  createAutoModRule,
  updateAutoModRule,
} = require('../src/controllers/autoModRulesController');

const INTERNAL_USER_ID = '11111111-1111-4111-8111-111111111111';
const DISCORD_ID = '123456789012345678';
const RULE_ID = '22222222-2222-4222-8222-222222222222';

function response() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function rule(overrides = {}) {
  return {
    id: RULE_ID,
    name: 'AI moderation',
    enabled: false,
    triggerType: 'AI_MODERATION',
    triggerMetadata: {},
    actions: [{ type: 'BLOCK' }],
    exemptChannelIds: [],
    exemptRoles: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findFirst.mockResolvedValue({ id: INTERNAL_USER_ID });
  prisma.autoModRule.create.mockResolvedValue(rule());
  prisma.autoModRule.findUnique.mockResolvedValue(rule());
  prisma.autoModRule.update.mockResolvedValue(rule());
  prisma.autoModRule.delete.mockResolvedValue(rule());
  prisma.auditLog.create.mockResolvedValue({});
});

describe('AutoMod rule management', () => {
  test('accepts AI_MODERATION and resolves a Discord actor to the internal UUID', async () => {
    const req = {
      adminUser: { id: DISCORD_ID },
      body: {
        name: 'AI moderation',
        triggerType: 'AI_MODERATION',
        triggerMetadata: {},
        actions: [{ type: 'BLOCK' }],
      },
    };
    const res = response();
    const next = jest.fn();

    await createAutoModRule(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.autoModRule.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        triggerType: 'AI_MODERATION',
        createdById: INTERNAL_USER_ID,
      }),
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('accepts AI_MODERATION updates and records the resolved actor UUID', async () => {
    const req = {
      params: { id: RULE_ID },
      adminUser: { id: DISCORD_ID },
      body: { triggerType: 'AI_MODERATION', triggerMetadata: {} },
    };
    const res = response();
    const next = jest.fn();

    await updateAutoModRule(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.autoModRule.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ triggerType: 'AI_MODERATION' }),
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: INTERNAL_USER_ID }),
    }));
  });

  test('stores a null actor for API-key requests instead of an invalid UUID', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const req = {
      adminUser: { id: 'api-key' },
      body: {
        name: 'Keyword rule',
        triggerType: 'KEYWORD',
        triggerMetadata: { keyword_filter: ['example'] },
        actions: [{ type: 'BLOCK' }],
      },
    };
    const res = response();
    const next = jest.fn();

    await createAutoModRule(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.autoModRule.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ createdById: null }),
    }));
  });
});
