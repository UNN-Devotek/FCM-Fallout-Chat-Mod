'use strict';
// Comprehensive Prisma stub for tests that load server.ts.
// Each model gets its OWN jest.fn() instances so tests can stub one model
// without accidentally overriding another (they used to share noopNull etc.).

function modelStub(overrides = {}) {
  return {
    findUnique:  jest.fn().mockResolvedValue(null),
    findFirst:   jest.fn().mockResolvedValue(null),
    findMany:    jest.fn().mockResolvedValue([]),
    create:      jest.fn().mockResolvedValue({}),
    update:      jest.fn().mockResolvedValue({}),
    updateMany:  jest.fn().mockResolvedValue({ count: 0 }),
    upsert:      jest.fn().mockResolvedValue({}),
    delete:      jest.fn().mockResolvedValue({}),
    deleteMany:  jest.fn().mockResolvedValue({ count: 0 }),
    count:       jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

module.exports = {
  __esModule: true,
  default: {
    user: modelStub(),
    channel: modelStub(),
    chatRoom: modelStub(),
    party: modelStub(),
    partyMember: modelStub(),
    partyInvite: modelStub(),
    privateConversation: modelStub(),
    privateMessage: modelStub(),
    campItem: modelStub(),
    wordFilter: modelStub(),
    moderationSetting: modelStub(),
    auditLog: modelStub(),
    wikiEntry: modelStub(),
    onlineSnapshot: modelStub(),
    moderationLog: modelStub(),
    report: modelStub(),
    device: modelStub(),
    release: modelStub(),
    mcpApiKey: modelStub(),
    nameBlacklist: modelStub(),
    session: modelStub(),
    adminUser: modelStub(),
    message: modelStub(),
    application: modelStub(),
    simUser: modelStub(),
    playerReport: modelStub(),
    chatCommand: modelStub(),
    hudIdentityBlock: modelStub(),
    linkedIdentity: modelStub(),
    hudPairingToken: modelStub(),
    $transaction: jest.fn(async (arg) => typeof arg === 'function' ? arg(module.exports.default) : Promise.all(arg)),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
};
