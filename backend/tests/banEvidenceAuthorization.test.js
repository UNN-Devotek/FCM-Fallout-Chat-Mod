'use strict';

/**
 * Tests for the per-ban authorization guard added to streamBanEvidenceHandler.
 *
 * Strategy: mock Prisma and the evidence storage service; drive the handler
 * directly with a synthetic req/res/next triple so no HTTP server is needed.
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
    },
    adminUser: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
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
const { streamBanEvidenceHandler } = require('../src/controllers/moderationActionsController');

const VALID_BAN_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_FILE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACTOR_USER_ID = 'actor-user-uuid';
const OTHER_USER_ID = 'other-user-uuid';

function makeReq({ role, adminUserId = ACTOR_USER_ID } = {}) {
  return {
    params: { id: VALID_BAN_ID, fileId: VALID_FILE_ID },
    adminUser: { id: adminUserId, role: role || 'moderator' },
  };
}

function makeRes() {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: ban exists, evidence exists, storage works
  prisma.ban.findUnique.mockResolvedValue(mockBan);
  prisma.banEvidence.findFirst.mockResolvedValue(mockEvidence);
  prisma.user.findUnique.mockResolvedValue({ id: ACTOR_USER_ID });
  prisma.user.upsert.mockResolvedValue({ id: ACTOR_USER_ID });
  downloadEvidence.mockResolvedValue(mockDownload);
});

describe('streamBanEvidenceHandler — per-ban authorization', () => {
  it('moderator who issued the ban can access evidence', async () => {
    const next = jest.fn();
    await streamBanEvidenceHandler(makeReq({ role: 'moderator' }), makeRes(), next);
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('moderator who did NOT issue the ban receives 403', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeReq({ role: 'moderator' }), makeRes(), next);
    const err = next.mock.calls[0]?.[0];
    expect(err?.status ?? err?.statusCode).toBe(403);
  });

  it('admin can access evidence for any ban regardless of who issued it', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeReq({ role: 'admin' }), makeRes(), next);
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('owner can access evidence for any ban regardless of who issued it', async () => {
    prisma.ban.findUnique.mockResolvedValue({ bannedById: OTHER_USER_ID });
    const next = jest.fn();
    await streamBanEvidenceHandler(makeReq({ role: 'owner' }), makeRes(), next);
    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('moderator requesting a non-existent ban receives 404', async () => {
    prisma.ban.findUnique.mockResolvedValue(null);
    const next = jest.fn();
    await streamBanEvidenceHandler(makeReq({ role: 'moderator' }), makeRes(), next);
    const err = next.mock.calls[0]?.[0];
    expect(err?.status ?? err?.statusCode).toBe(404);
  });
});
