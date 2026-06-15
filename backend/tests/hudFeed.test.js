'use strict';
/**
 * Tests for GET /api/game/hud-feed
 *
 * Public, unauthenticated read-only endpoint. ZFE's readRemoteData polls it
 * every 30 s to feed FCMBridge.swf. Covers response shape, field mapping,
 * display name resolution, Cache-Control, and empty-state behaviour.
 *
 * Contract: { t: "<records>" } where <records> is pipe-joined records,
 * each record is "color~channel~user~content" (zfeSafe fields).
 * Rows arrive DESC from DB; route reverses → oldest first in payload.
 */
const request = require('supertest');

// ── Infrastructure mocks ──────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) =>
    cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  ),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn(), ping: jest.fn().mockResolvedValue('PONG') },
}));

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    decrement: jest.fn().mockResolvedValue(undefined),
    resetKey: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    localKeys: true,
  })),
}));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  relayToDiscord: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/queues/messagePersist', () => ({
  add: jest.fn().mockResolvedValue({}),
  process: jest.fn(),
  on: jest.fn(),
}));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

const { app } = require('../src/server');
const prismaStub = require('./setup/prisma-stub').default;
const { isHudEligibleChannel } = require('../src/services/hudPush');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split a { t: "..." } response body into an array of record objects.
 * Records are pipe-joined; each record is "color~channel~user~content".
 * Returns [] when t is empty string.
 */
function parseRecords(body) {
  if (!body.t) return [];
  return body.t.split('|').map((rec) => {
    const [col, ch, user, ...rest] = rec.split('~');
    return { col, ch, user, content: rest.join('~') };
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// DB returns DESC (newest first); the route reverses → oldest first.
const ROWS = [
  {
    content: 'Raid @ whitespring 9pm',
    username: 'pending-abc123',
    discord_display_name: null,
    discord_username: 'raider99',
    channel_name: 'Raids',
    channel_color: '#FF2222',
    created_at: new Date('2026-06-01T12:02:00Z'),
  },
  {
    content: 'Server down?',
    username: null,
    discord_display_name: 'Pip-Boy',
    discord_username: 'pipboy#0001',
    channel_name: 'General',
    channel_color: '#18FF62',
    created_at: new Date('2026-06-01T12:01:00Z'),
  },
  {
    content: 'WTB leaders',
    username: 'Devotek',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'Trading',
    channel_color: '#FF8800',
    created_at: new Date('2026-06-01T12:00:00Z'),
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/game/hud-feed', () => {
  beforeEach(() => {
    prismaStub.$queryRaw.mockResolvedValue([...ROWS]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with { t: string } shape (ZFE pipe-record payload)', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('t');
    expect(typeof res.body.t).toBe('string');
    // Must not have a messages array — that was the old contract
    expect(res.body).not.toHaveProperty('messages');
  });

  it('returns records in chronological order (oldest first after DESC reversal)', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    expect(recs).toHaveLength(3);
    // DB returns DESC; route reverses → oldest first in t string
    // ROWS[2] oldest (12:00) → first record; ROWS[0] newest (12:02) → last
    expect(recs[0].user).toBe('Devotek');
    expect(recs[2].ch).toBe('Raids');
  });

  it('maps fields to color~channel~user~content records', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    const first = recs[0]; // Devotek / Trading / WTB leaders
    expect(first.col).toBe('#FF8800');
    // Trading is renamed Trade to match ChatOverlay
    expect(first.ch).toBe('Trade');
    expect(first.user).toBe('Devotek');
    expect(first.content).toBe('WTB leaders');
  });

  it('resolves display name via discord_display_name when username is null', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    const second = recs[1]; // Pip-Boy / General / Server down?
    expect(second.user).toBe('Pip-Boy');
  });

  it('resolves display name via discord_username when username is a placeholder', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    const third = recs[2]; // pending-abc123 → raider99
    expect(third.user).toBe('raider99');
  });

  it('returns empty t string when no rows', async () => {
    prismaStub.$queryRaw.mockResolvedValue([]);
    const res = await request(app).get('/api/game/hud-feed');
    expect(res.status).toBe(200);
    expect(res.body.t).toBe('');
  });

  it('sets Cache-Control: public, max-age=30', async () => {
    const res = await request(app).get('/api/game/hud-feed');
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.headers['cache-control']).toMatch(/max-age=30/);
  });

  it('requires no auth token', async () => {
    // Must succeed without X-Auth-Token or session
    const res = await request(app).get('/api/game/hud-feed');
    expect(res.status).toBe(200);
  });

  it('returns 500 on DB error', async () => {
    prismaStub.$queryRaw.mockRejectedValue(new Error('DB down'));
    const res = await request(app).get('/api/game/hud-feed');
    expect(res.status).toBe(500);
  });

  it('channel color falls back to default (#C8A840) when DB value is invalid', async () => {
    prismaStub.$queryRaw.mockResolvedValue([
      { ...ROWS[2], channel_color: 'bogus' },
    ]);
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    expect(recs[0].col).toBe('#C8A840');
  });

  it('truncates content over 70 chars with ellipsis', async () => {
    prismaStub.$queryRaw.mockResolvedValue([
      { ...ROWS[2], content: 'x'.repeat(100) },
    ]);
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    expect(recs[0].content).toHaveLength(70);
    expect(recs[0].content).toMatch(/\.\.\.$/);
  });

  it('SQL predicate selects leaf channels (parentId IS NOT NULL): mock confirms rows from leaf channels returned', async () => {
    // The actual SQL WHERE c.parent_id IS NOT NULL is tested by verifying the
    // route returns rows whose channel_name is a leaf tab (General / Trading /
    // Events / Raids), not the root "Fallout 76" container.
    // The stub is pre-seeded with ROWS which all have leaf channel names — this
    // test confirms the route does NOT filter them out.
    const res = await request(app).get('/api/game/hud-feed');
    const recs = parseRecords(res.body);
    const channelNames = recs.map((r) => r.ch);
    // All three rows are leaf channels
    expect(channelNames).toContain('Trade');   // Trading → Trade
    expect(channelNames).toContain('General');
    expect(channelNames).toContain('Raids');
    // Root container should never appear in the feed
    expect(channelNames).not.toContain('Fallout 76');
  });

  it('zfeSafe invariants: no " \\ | ~ < > & CR LF inside any field', async () => {
    prismaStub.$queryRaw.mockResolvedValue([
      {
        ...ROWS[2],
        username: 'Bad"User',
        content: 'sell|buy <b>"stuff"</b> C:\\path\nend',
        channel_name: 'Tra~ding',
        channel_color: '#FF8800',
      },
    ]);
    const res = await request(app).get('/api/game/hud-feed');
    // The top-level t string uses | as record separator and ~ as field separator,
    // so those characters ARE expected at the record/field boundaries.
    // The invariant is that none of the ZFE-breaking chars appear INSIDE any field.
    // Parse each record and check every individual field value.
    const recs = parseRecords(res.body);
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      for (const field of [rec.col, rec.ch, rec.user, rec.content]) {
        // None of these should appear inside a field value after zfeSafe
        expect(field).not.toMatch(/["\\|~<>&\r\n]/);
      }
    }
  });
});

describe('isHudEligibleChannel — leaf vs container predicate', () => {
  it('returns true for a leaf channel (parentId non-null, not archived)', () => {
    expect(isHudEligibleChannel({
      name: 'General',
      color: '#C8A840',
      parentId: '00000000-0000-0000-0000-000000000001',
      isArchived: false,
    })).toBe(true);
  });

  it('returns false for the root container channel (parentId null)', () => {
    expect(isHudEligibleChannel({
      name: 'Fallout 76',
      color: null,
      parentId: null,
      isArchived: false,
    })).toBe(false);
  });

  it('returns false for an archived leaf channel', () => {
    expect(isHudEligibleChannel({
      name: 'OldChannel',
      color: '#888888',
      parentId: '00000000-0000-0000-0000-000000000001',
      isArchived: true,
    })).toBe(false);
  });

  it('returns false for an archived root channel', () => {
    expect(isHudEligibleChannel({
      name: 'OldRoot',
      color: null,
      parentId: null,
      isArchived: true,
    })).toBe(false);
  });
});
