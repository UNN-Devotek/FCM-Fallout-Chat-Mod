'use strict';

/**
 * Tests for the per-ban evidence authorization guard shared across
 * streamBanEvidenceHandler, getBanHandler and listEvidenceHandler.
 *
 * Rule under test (assertBanEvidenceAccess / isEvidencePrivileged):
 *   - owners/admins  -> may access ANY ban's evidence
 *   - every other persona (moderator, supporter, developer, ...) -> only the
 *     evidence for bans they personally issued (ban.bannedById === actor)
 *   - denial (or non-existent ban) on the stream endpoint -> 404 (NOT 403),
 *     to avoid a ban-existence oracle, and the object is NOT streamed
 *
 * Strategy: mock Prisma and the evidence storage service; drive the handlers
 * directly with a synthetic req/res/next triple so no HTTP server is needed.
 * The prisma.user mock mirrors what actorUserId() actually calls
 * (findFirst + create), so the guard exercises real production code.
 */

const mockBan = { bannedById: 'actor-user-uuid' };
const mockEvidence = { objectKey: 'ban-evidence/test.png', mime: 'image/png' };
const mockStream = { pipe: jest.fn() };
const mockDownload = { stream: mockStream, mime: 'image/png', sizeBytes: 1024 };

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    ban: {
      findUnique: jest.fn(),
    },
    banEvidence: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    adminUser: {
      findUnique: jest.fn(),
    },
    user: {
      // actorUserId() resolves the internal user UUID via findFirst, and
      // creates a discord-only row via create when none exists.
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'));

jest.mock('../src/services/banEvidenceStorage', () => ({
  downloadEvidence: jest.fn(),
  uploadEvidence: jest.fn(),
}));

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { on: jest.fn() },
  healthCheck: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  }),
}));

const prisma = require('../src/config/prisma').default;
const { downloadEvidence } = require('../src/services/banEvidenceStorage');
const {
  streamBanEvidenceHandler,
  getBanHandler,
  listEvidenceHandler,
} = require('../src/controllers/moderationActionsController');

const VALID_BAN_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_FILE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACTOR_USER_ID = 'actor-user-uuid';
const OTHER_USER_ID = 'other-user-uuid';

function makeStreamReq({ role, adminUserId = 'discord-actor' } = {}) {
  return {
    params: { id: VALID_BAN_ID, fileId: VALID_FILE_ID },
    adminUser: { id: adminUserId, role: role || 'moderator' },
  };
}

function makeGetReq({ role, adminUserId = 'discord-actor' } = {}) {
  return {
    params: { id: VALID_BAN_ID },
    adminUser: { id: adminUserId, role: role || 'moderator' },
  };
}

function makeListReq({ role, adminUserId = 'discord-actor' } = {}) {
  return {
    params: {},
    query: {},
    adminUser: { id: adminUserId, role: role || 'moderator' },
  };
}

function makeRes() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function errStatus(next) {
  const err = next.mock.calls[0]?.[0];
  return err?.status ?? err?.statusCode;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: ban exists & issued by the actor, evidence exists, storage works.
  prisma.ban.findUnique.mockResolvedValue(mockBan);
  prisma.banEvidence.findFirst.mockResolvedValue(mockEvidence);
  prisma.banEvidence.findMany.mockResolvedValue([]);
  // actorUserId(): existing discord-only user row resolves to ACTOR_USER_ID.
  prisma.user.findFirst.mockResolvedValue({ id: ACTOR_USER_ID });
  prisma.user.create.mockResolvedValue({ id: ACTOR_USER_ID });
  downloadEvidence.mockResolvedValue(mockDownload);
});

describe('streamBanEvidenceHandler — per-ban authorization', () => {
  it('moderator who issued the ban streams the evidence (pipe called)', async () => {
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'moderator' }), makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(downloadEvidence).toHaveBeenCalledTimes(1);
    expect(mockStream.pipe).toHaveBeenCalledTimes(1);
  });

  it('moderator who did NOT issue the ban gets 404 and the object is NOT streamed', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'moderator' }), makeRes(), next);
    expect(errStatus(next)).toBe(404);
    expect(downloadEvidence).not.toHaveBeenCalled();
    expect(mockStream.pipe).not.toHaveBeenCalled();
  });

  it('supporter who did NOT issue the ban gets 404 and the object is NOT streamed', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'supporter' }), makeRes(), next);
    expect(errStatus(next)).toBe(404);
    expect(downloadEvidence).not.toHaveBeenCalled();
    expect(mockStream.pipe).not.toHaveBeenCalled();
  });

  it('developer who did NOT issue the ban gets 404 and the object is NOT streamed', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'developer' }), makeRes(), next);
    expect(errStatus(next)).toBe(404);
    expect(downloadEvidence).not.toHaveBeenCalled();
    expect(mockStream.pipe).not.toHaveBeenCalled();
  });

  it('admin streams evidence for a ban issued by someone else (pipe called)', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'admin' }), makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mockStream.pipe).toHaveBeenCalledTimes(1);
    // Privileged path must not perform a per-ban ownership lookup.
    expect(prisma.ban.findUnique).not.toHaveBeenCalled();
  });

  it('owner streams evidence for a ban issued by someone else (pipe called)', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'owner' }), makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mockStream.pipe).toHaveBeenCalledTimes(1);
    expect(prisma.ban.findUnique).not.toHaveBeenCalled();
  });

  it('non-existent ban returns 404 (no existence oracle) for a moderator', async () => {
    prisma.ban.findUnique.mockResolvedValue(null);
    const next = jest.fn();
    await streamBanEvidenceHandler(makeStreamReq({ role: 'moderator' }), makeRes(), next);
    expect(errStatus(next)).toBe(404);
    expect(downloadEvidence).not.toHaveBeenCalled();
  });
});

describe('getBanHandler — evidence relation scoping', () => {
  const banRow = () => ({
    id: VALID_BAN_ID,
    bannedById: ACTOR_USER_ID,
    evidence: [
      { id: 'e1', type: 'text', textContent: 'secret notes' },
      { id: 'e2', type: 'image', objectKey: 'ban-evidence/x.png' },
    ],
  });

  it('moderator who issued the ban keeps the full evidence relation', async () => {
    prisma.ban.findUnique.mockResolvedValue(banRow());
    const res = makeRes();
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'moderator' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.evidence).toHaveLength(2);
  });

  it('moderator who did NOT issue the ban gets the row with evidence stripped', async () => {
    const row = banRow();
    row.bannedById = OTHER_USER_ID;
    prisma.ban.findUnique.mockResolvedValue(row);
    const res = makeRes();
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'moderator' }), res, next);
    expect(next).not.toHaveBeenCalled();
    const data = res.json.mock.calls[0][0].data;
    expect(data.evidence).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('secret notes');
    expect(JSON.stringify(data)).not.toContain('ban-evidence/x.png');
  });

  it('supporter who did NOT issue the ban gets the row with evidence stripped', async () => {
    const row = banRow();
    row.bannedById = OTHER_USER_ID;
    prisma.ban.findUnique.mockResolvedValue(row);
    const res = makeRes();
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'supporter' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.evidence).toEqual([]);
  });

  it('admin keeps the full evidence relation for any ban', async () => {
    const row = banRow();
    row.bannedById = OTHER_USER_ID;
    prisma.ban.findUnique.mockResolvedValue(row);
    const res = makeRes();
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'admin' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.evidence).toHaveLength(2);
  });

  it('owner keeps the full evidence relation for any ban', async () => {
    const row = banRow();
    row.bannedById = OTHER_USER_ID;
    prisma.ban.findUnique.mockResolvedValue(row);
    const res = makeRes();
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'owner' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.evidence).toHaveLength(2);
  });

  it('non-existent ban returns 404', async () => {
    prisma.ban.findUnique.mockResolvedValue(null);
    const next = jest.fn();
    await getBanHandler(makeGetReq({ role: 'moderator' }), makeRes(), next);
    expect(errStatus(next)).toBe(404);
  });
});

describe('listEvidenceHandler — gallery scoping', () => {
  it('owner lists all evidence (no where filter)', async () => {
    const res = makeRes();
    const next = jest.fn();
    await listEvidenceHandler(makeListReq({ role: 'owner' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.banEvidence.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.banEvidence.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it('admin lists all evidence (no where filter)', async () => {
    const res = makeRes();
    const next = jest.fn();
    await listEvidenceHandler(makeListReq({ role: 'admin' }), res, next);
    expect(prisma.banEvidence.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it('moderator list is scoped to bans they issued (where ban.bannedById === actor)', async () => {
    const res = makeRes();
    const next = jest.fn();
    await listEvidenceHandler(makeListReq({ role: 'moderator' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.banEvidence.findMany.mock.calls[0][0].where)
      .toEqual({ ban: { bannedById: ACTOR_USER_ID } });
  });

  it('supporter list is scoped to bans they issued', async () => {
    const res = makeRes();
    const next = jest.fn();
    await listEvidenceHandler(makeListReq({ role: 'supporter' }), res, next);
    expect(prisma.banEvidence.findMany.mock.calls[0][0].where)
      .toEqual({ ban: { bannedById: ACTOR_USER_ID } });
  });

  it('developer list is scoped to bans they issued', async () => {
    const res = makeRes();
    const next = jest.fn();
    await listEvidenceHandler(makeListReq({ role: 'developer' }), res, next);
    expect(prisma.banEvidence.findMany.mock.calls[0][0].where)
      .toEqual({ ban: { bannedById: ACTOR_USER_ID } });
  });
});
