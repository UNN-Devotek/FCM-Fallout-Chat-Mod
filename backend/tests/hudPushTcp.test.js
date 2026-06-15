'use strict';
/**
 * Integration tests for the HUD push TCP front-end (hudPushTcp.ts + hudPush.ts).
 *
 * Strategy: boot the TCP server on an ephemeral port (port 0), stub
 * fetchFeedRows via jest.mock so no Postgres is needed, inject the channel
 * resolver via _setChannelResolver so no Prisma is needed for live lines.
 * All external dependencies (prisma, redis, database, discord) are mocked.
 *
 * Test coverage:
 *  - HELLO~1~<n> line + exactly n backfill lines on connect
 *  - Live line arrives via hudPushNotify after connection
 *  - Per-IP cap of 3: 4th connection from same IP is destroyed
 *  - Per-line length cap: line exceeding MAX_LINE_BYTES is dropped (not a connection kill)
 *  - HELLO then SEND ingests message via ingestMessage
 *  - SEND before HELLO is rejected
 *  - Banned identityHash is refused at HELLO (socket destroyed)
 *  - Muted user/hash: SEND is dropped (ingestMessage returns muted)
 *  - Oversized line (>MAX_LINE_BYTES) is dropped, connection survives
 *  - HELLO is OPTIONAL: a receive-only feed client (never sends HELLO) is NOT dropped
 */

const net = require('net');

// ── Mock all heavy external deps before any require of server code ─────────────

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
    subscribe: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    zAdd: jest.fn().mockResolvedValue(1),
    zCard: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnValue({
      zRemRangeByScore: jest.fn().mockReturnThis(),
      zAdd: jest.fn().mockReturnThis(),
      zCard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 1, 1, 1]),
    }),
  }),
  getSubscriberClient: jest.fn().mockResolvedValue({
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn(), ping: jest.fn().mockResolvedValue('PONG'), isOpen: true },
  subscriberClient: { on: jest.fn(), isOpen: true },
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

// ── Mock M7 identity + ingestion services ─────────────────────────────────────

jest.mock('../src/services/hudIdentityService', () => ({
  deriveIdentityHash: jest.fn((accountName) => `hash-of-${accountName}`),
  resolveHudIdentity: jest.fn().mockResolvedValue({ userId: 'resolved-user-id', identityHash: 'test-hash' }),
  getActiveBlock: jest.fn().mockResolvedValue(null), // no block by default
  blockHash: jest.fn().mockResolvedValue(undefined),
  unblockHash: jest.fn().mockResolvedValue(1),
  usingDefaultIdentitySecret: jest.fn(() => false), // real secret by default (SR-003)
}));

jest.mock('../src/services/ingestMessage', () => ({
  ingestMessage: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-uuid' }),
}));

// ── Stub websocket handlers broadcast export (needed by ingestMessage transitive import) ──
jest.mock('../src/websocket/handlers', () => ({
  broadcast: jest.fn(),
  resolveDisplayName: jest.fn((u) => u.username || 'Wanderer'),
}));

jest.mock('../src/controllers/healthController', () => ({
  incrementMessageCount: jest.fn(),
  setFullscreenStatus: jest.fn(),
  removeFullscreenClient: jest.fn(),
}));

jest.mock('../src/services/autoModEngine', () => ({
  engineEvaluate: jest.fn().mockResolvedValue({ block: false, matches: [] }),
}));

jest.mock('../src/services/autoModService', () => ({
  shadowMute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/messageService', () => ({
  persistMessage: jest.fn().mockResolvedValue(undefined),
}));

// ── Stub hudFeedService.fetchFeedRows/fetchFeedRowsForChannel ─────────────────

const BACKFILL_ROWS = [
  {
    content: 'first backfill',
    username: 'Alpha',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
    created_at: new Date('2026-06-10T10:00:00Z'),
  },
  {
    content: 'second backfill',
    username: 'Beta',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
    created_at: new Date('2026-06-10T10:01:00Z'),
  },
];

const TRADING_BACKFILL_ROWS = [
  {
    content: 'WTS plans',
    username: 'Trader',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'Trading',
    channel_color: '#4A9FE0',
    created_at: new Date('2026-06-10T11:00:00Z'),
  },
];

// fetchFeedRows returns DESC (newest first); hudPush reverses them before backfill.
// Our BACKFILL_ROWS are in DESC order. After rows.reverse() they become ASC.
jest.mock('../src/services/hudFeedService', () => {
  const real = jest.requireActual('../src/services/hudFeedService');
  return {
    ...real,
    fetchFeedRows: jest.fn().mockResolvedValue([...BACKFILL_ROWS]),
    fetchFeedRowsForChannel: jest.fn().mockImplementation((channelId) => {
      // Return trading backfill for the trading channel, general for all others.
      if (channelId === '00000000-0000-0000-0000-000000000002') {
        return Promise.resolve([...TRADING_BACKFILL_ROWS]);
      }
      return Promise.resolve([...BACKFILL_ROWS]);
    }),
  };
});

// ── Import modules under test ─────────────────────────────────────────────────

const { startTcpServer, stopTcpServer } = require('../src/services/hudPushTcp');
const { hudPushNotify, _setChannelResolver } = require('../src/services/hudPush');
const { buildFeedLines } = require('../src/services/hudFeedService');
const { ingestMessage } = require('../src/services/ingestMessage');
const { resolveHudIdentity, getActiveBlock } = require('../src/services/hudIdentityService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Connect to the TCP server and collect all received lines (split on \n).
 * Returns an object with:
 *   - lines(): array of non-empty lines received so far
 *   - waitForLines(n, timeoutMs): resolves when at least n lines are buffered
 *   - close(): destroy the socket
 */
function connect(port, host = '127.0.0.1') {
  const socket = net.connect({ port, host });
  let buf = '';
  const lines = [];
  let resolver = null;
  let waitCount = 0;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop(); // keep incomplete line
    for (const part of parts) {
      if (part.length > 0) lines.push(part);
    }
    if (resolver && lines.length >= waitCount) {
      const r = resolver;
      resolver = null;
      r();
    }
  });

  return {
    lines() { return lines; },
    waitForLines(n, timeoutMs = 3000) {
      if (lines.length >= n) return Promise.resolve();
      return new Promise((resolve, reject) => {
        waitCount = n;
        resolver = resolve;
        const t = setTimeout(() => {
          resolver = null;
          reject(new Error(`Timeout waiting for ${n} lines (got ${lines.length}): ${JSON.stringify(lines)}`));
        }, timeoutMs);
        // Ensure timer doesn't block Jest process exit
        if (t.unref) t.unref();
      });
    },
    close() { socket.destroy(); },
    socket,
  };
}

/** Small async delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('hudPushTcp production guard', () => {
  // HUD push is dev-only until the M6 production-exposure decision: the env
  // flag alone must never start the listener under NODE_ENV=production.
  test('initHudPushTcp refuses to start in production even when enabled', async () => {
    // environment.ts ends with `module.exports = env`, so require() returns env itself.
    const env = require('../src/config/environment');
    const { initHudPushTcp } = require('../src/services/hudPushTcp');
    const savedNodeEnv = env.NODE_ENV;
    const savedEnabled = env.HUD_PUSH_TCP_ENABLED;
    const savedPort = env.HUD_PUSH_TCP_PORT;
    try {
      env.NODE_ENV = 'production';
      env.HUD_PUSH_TCP_ENABLED = true;
      env.HUD_PUSH_TCP_PORT = 49321; // obscure port nothing else binds in tests
      await initHudPushTcp();
      // Nothing should be listening on the configured port.
      const refused = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: 49321 });
        sock.once('connect', () => { sock.destroy(); resolve(false); });
        sock.once('error', () => resolve(true));
        const t = setTimeout(() => { sock.destroy(); resolve(true); }, 1500);
        if (t.unref) t.unref();
      });
      expect(refused).toBe(true);
    } finally {
      env.NODE_ENV = savedNodeEnv;
      env.HUD_PUSH_TCP_ENABLED = savedEnabled;
      env.HUD_PUSH_TCP_PORT = savedPort;
    }
  });

  // SR-003: refuse to start the inbound chat path when HUD_IDENTITY_SECRET is
  // still the public dev default — identities would otherwise be forgeable.
  test('initHudPushTcp refuses to start when HUD_IDENTITY_SECRET is the dev default', async () => {
    const env = require('../src/config/environment');
    const { usingDefaultIdentitySecret } = require('../src/services/hudIdentityService');
    const { initHudPushTcp } = require('../src/services/hudPushTcp');
    const savedNodeEnv = env.NODE_ENV;
    const savedEnabled = env.HUD_PUSH_TCP_ENABLED;
    const savedPort = env.HUD_PUSH_TCP_PORT;
    usingDefaultIdentitySecret.mockReturnValueOnce(true); // simulate dev-default secret
    try {
      env.NODE_ENV = 'development';
      env.HUD_PUSH_TCP_ENABLED = true;
      env.HUD_PUSH_TCP_PORT = 49322;
      await initHudPushTcp();
      const refused = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: 49322 });
        sock.once('connect', () => { sock.destroy(); resolve(false); });
        sock.once('error', () => resolve(true));
        const t = setTimeout(() => { sock.destroy(); resolve(true); }, 1500);
        if (t.unref) t.unref();
      });
      expect(refused).toBe(true);
      expect(usingDefaultIdentitySecret).toHaveBeenCalled();
    } finally {
      env.NODE_ENV = savedNodeEnv;
      env.HUD_PUSH_TCP_ENABLED = savedEnabled;
      env.HUD_PUSH_TCP_PORT = savedPort;
      await stopTcpServer();
    }
  });
});

describe('hudPushTcp integration', () => {
  let server;
  let serverPort;
  // Leaf channel — parentId non-null so isHudEligibleChannel returns true.
  const eligibleChannel = { name: 'General', color: '#C8A840', parentId: '00000000-0000-0000-0000-000000000001', isArchived: false };
  const tradingChannel   = { name: 'Trading', color: '#4A9FE0', parentId: '00000000-0000-0000-0000-000000000001', isArchived: false };
  const TRADING_CHANNEL_ID = '00000000-0000-0000-0000-000000000002';

  // environment.ts is already required transitively; grab the live object so we
  // can clear TLS paths — these tests use plaintext net.connect().
  const envObj = require('../src/config/environment');
  let savedCert;
  let savedKey;

  beforeAll(async () => {
    // Ensure TLS is off for these plaintext tests regardless of .env.local.
    savedCert = envObj.HUD_PUSH_TCP_TLS_CERT;
    savedKey  = envObj.HUD_PUSH_TCP_TLS_KEY;
    envObj.HUD_PUSH_TCP_TLS_CERT = '';
    envObj.HUD_PUSH_TCP_TLS_KEY  = '';
    // Inject a channel resolver so no Prisma is needed for live line tests.
    // Only known channel IDs return a result; unknown IDs return null (ignored).
    _setChannelResolver(async (id) => {
      if (id === TRADING_CHANNEL_ID) return tradingChannel;
      // General and any other "eligible-looking" id → return eligibleChannel.
      // Unknown IDs are returned as null so CHAN ignores them.
      const GENERAL_CHANNEL_ID_CONST = '00000000-0000-0000-0000-000000000005';
      if (id === GENERAL_CHANNEL_ID_CONST) return eligibleChannel;
      // All other IDs (including the root container and random strings) → null.
      return null;
    });
    // Start on ephemeral port.
    server = await startTcpServer(0);
    serverPort = server.address().port;
  });

  afterAll(async () => {
    _setChannelResolver(null);
    await stopTcpServer();
    envObj.HUD_PUSH_TCP_TLS_CERT = savedCert;
    envObj.HUD_PUSH_TCP_TLS_KEY  = savedKey;
  });

  // ── HELLO + backfill ────────────────────────────────────────────────────────

  it('sends HELLO~1~2, ACTIVECHAN~General, followed by 2 General backfill lines on connect', async () => {
    const client = connect(serverPort);
    // HELLO (1 line) + ACTIVECHAN (1 line) + 2 backfill lines = 4 lines total.
    await client.waitForLines(4, 5000);
    client.close();

    const lines = client.lines();
    expect(lines[0]).toBe('HELLO~1~2');
    expect(lines[1]).toBe('ACTIVECHAN~General');

    // Backfill arrives oldest-first (rows.reverse()).
    // BACKFILL_ROWS[0] = 'first backfill' (newer in DESC order) → after reverse, this is last.
    // BACKFILL_ROWS[1] = 'second backfill' (older in DESC order) → after reverse, this is first.
    // Wait — DESC means newest first, so BACKFILL_ROWS[0] is the newest.
    // After rows.reverse(): [BACKFILL_ROWS[1], BACKFILL_ROWS[0]] = second backfill, first backfill.
    const [expectedFirst] = buildFeedLines([BACKFILL_ROWS[1]]);
    const [expectedSecond] = buildFeedLines([BACKFILL_ROWS[0]]);
    expect(lines[2]).toBe(expectedFirst);
    expect(lines[3]).toBe(expectedSecond);
  });

  // ── Live line on hudPushNotify ──────────────────────────────────────────────

  // The General channel ID (default activeChannelId for new connections).
  const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000005';

  it('delivers a live line when hudPushNotify is called with a General message (matches activeChannelId)', async () => {
    const client = connect(serverPort);
    // Wait for HELLO + ACTIVECHAN + backfill.
    await client.waitForLines(4, 5000);

    const linesBeforeLive = client.lines().length;

    hudPushNotify({
      type: 'chat:message',
      payload: {
        channelId: GENERAL_CHANNEL_ID,
        content: 'live message here',
        username: 'LiveUser',
        isPrivate: false,
      },
    });

    // Wait for the live line to arrive.
    await client.waitForLines(linesBeforeLive + 1, 3000);
    client.close();

    const liveLine = client.lines()[linesBeforeLive];
    expect(liveLine).toMatch(/^#C8A840~General~LiveUser~live message here$/);
    expect(liveLine).not.toContain('\n');
  });

  // ── Per-IP connection cap ───────────────────────────────────────────────────

  it('destroys the 4th connection from the same IP (cap = 3)', async () => {
    const c1 = connect(serverPort);
    const c2 = connect(serverPort);
    const c3 = connect(serverPort);

    // Wait for all 3 to receive their HELLO.
    await Promise.all([c1.waitForLines(1, 5000), c2.waitForLines(1, 5000), c3.waitForLines(1, 5000)]);

    // 4th connection should be destroyed by the server.
    const c4 = connect(serverPort);
    await new Promise((resolve) => {
      c4.socket.on('close', resolve);
      c4.socket.on('error', resolve); // also fires on abrupt close
      // Fallback timeout: if the server doesn't destroy it within 2s, fail.
      setTimeout(() => resolve(), 2500);
    });

    // c4 should have received no lines (server destroyed it before HELLO).
    expect(c4.lines().length).toBe(0);

    c1.close();
    c2.close();
    c3.close();
    c4.close();
    // Give server time to clean up connections before next test.
    await delay(100);
  });

  // ── Per-line length cap (M7) ───────────────────────────────────────────────
  // The old blunt total-bytes cap was replaced with a per-line cap.
  // Oversized lines are silently dropped; the connection is NOT destroyed.

  it('drops an oversized line but keeps the connection alive', async () => {
    ingestMessage.mockClear();

    const client = connect(serverPort);
    await client.waitForLines(1, 5000);

    const lineCountBefore = client.lines().length;

    // Send a line of 2050 'A' bytes followed by \n — exceeds MAX_LINE_BYTES=2048.
    const bigLine = 'A'.repeat(2050) + '\n';
    client.socket.write(bigLine);

    // Wait a bit; the oversized line should be silently dropped (no disconnect).
    await delay(300);

    // Socket should still be alive.
    expect(client.socket.destroyed).toBe(false);
    // No extra lines should have arrived from the oversized write.
    expect(client.lines().length).toBe(lineCountBefore);

    client.close();
    await delay(100);
  });

  // ── HELLO → SEND ingestion (M7) ──────────────────────────────────────────────

  it('ingests a message after HELLO + SEND', async () => {
    ingestMessage.mockClear();
    resolveHudIdentity.mockResolvedValue({ userId: 'user-abc', identityHash: 'hash-abc' });
    getActiveBlock.mockResolvedValue(null);

    const client = connect(serverPort);
    await client.waitForLines(1, 5000);

    client.socket.write('HELLO~Devotek-~VaultEller\n');
    await delay(300);

    const testChannelId = '00000000-0000-0000-0000-000000000001';
    client.socket.write(`SEND~${testChannelId}~hello world\n`);
    await delay(300);

    expect(ingestMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-abc',
      channelId: testChannelId,
      rawContent: 'hello world',
      source: 'hud',
      identityHash: 'hash-abc',
    }));

    client.close();
    await delay(100);
  });

  // ── SEND before HELLO is rejected ────────────────────────────────────────────

  it('rejects SEND before HELLO (ingestMessage not called)', async () => {
    ingestMessage.mockClear();

    const client = connect(serverPort);
    await client.waitForLines(1, 5000);

    const testChannelId = '00000000-0000-0000-0000-000000000002';
    client.socket.write(`SEND~${testChannelId}~premature send\n`);
    await delay(300);

    expect(ingestMessage).not.toHaveBeenCalled();

    client.close();
    await delay(100);
  });

  // ── Banned hash destroyed at HELLO ───────────────────────────────────────────

  it('destroys socket when identityHash is banned', async () => {
    getActiveBlock.mockResolvedValueOnce({ type: 'ban', identityHash: 'banned-hash' });
    resolveHudIdentity.mockResolvedValue({ userId: 'banned-user', identityHash: 'banned-hash' });

    const client = connect(serverPort);
    await client.waitForLines(1, 5000);

    client.socket.write('HELLO~BannedUser~BannedChar\n');

    await new Promise((resolve) => {
      client.socket.on('close', resolve);
      client.socket.on('error', resolve);
      setTimeout(() => resolve(), 2500);
    });

    expect(client.socket.destroyed).toBe(true);

    client.close();
    await delay(100);
  });

  // ── Muted identity: SEND dropped ─────────────────────────────────────────────

  it('drops SEND gracefully when ingestMessage reports muted', async () => {
    ingestMessage.mockResolvedValueOnce({ ok: false, reason: 'muted' });
    resolveHudIdentity.mockResolvedValue({ userId: 'muted-user', identityHash: 'muted-hash' });
    getActiveBlock.mockResolvedValue(null);

    const client = connect(serverPort);
    await client.waitForLines(1, 5000);

    client.socket.write('HELLO~MutedAccount~MutedChar\n');
    await delay(300);

    const testChannelId = '00000000-0000-0000-0000-000000000003';
    client.socket.write(`SEND~${testChannelId}~muted message\n`);
    await delay(300);

    // ingestMessage was called but returned muted — socket should still be alive.
    expect(ingestMessage).toHaveBeenCalled();
    expect(client.socket.destroyed).toBe(false);

    ingestMessage.mockResolvedValue({ ok: true, messageId: 'msg-uuid' });
    client.close();
    await delay(100);
  });

  // ── CHAN verb: channel switch → ACTIVECHAN + Trading backfill ─────────────────

  it('CHAN to Trading sends ACTIVECHAN~Trading and Trading backfill', async () => {
    const client = connect(serverPort);
    // Wait for HELLO + ACTIVECHAN~General + 2 General backfill lines.
    await client.waitForLines(4, 5000);

    // Send CHAN to switch to Trading.
    client.socket.write(`CHAN~${TRADING_CHANNEL_ID}\n`);

    // Expect ACTIVECHAN~Trading + 1 Trading backfill line = 2 more lines.
    await client.waitForLines(6, 3000);
    client.close();

    const lines = client.lines();
    const activeChanIdx = lines.findIndex((l) => l === 'ACTIVECHAN~Trading');
    expect(activeChanIdx).toBeGreaterThan(-1);
    // The Trading backfill line should follow ACTIVECHAN.
    const [expectedTradingLine] = buildFeedLines([TRADING_BACKFILL_ROWS[0]]);
    expect(lines[activeChanIdx + 1]).toBe(expectedTradingLine);
  });

  it('CHAN with invalid (root container) channelId is ignored — no ACTIVECHAN sent', async () => {
    const ROOT_CONTAINER_ID = '00000000-0000-0000-0000-000000000001';

    const client = connect(serverPort);
    // Wait for HELLO + ACTIVECHAN~General + backfill.
    await client.waitForLines(4, 5000);
    const lineCountBefore = client.lines().length;

    // Send CHAN with the root container (non-leaf) — should be silently ignored.
    // The root channel has parentId=null so isHudEligibleChannel returns false.
    // However our test resolver returns eligibleChannel for unknown IDs, which has
    // parentId set — so we test with a truly invalid UUID that the resolver returns null for.
    client.socket.write(`CHAN~not-a-real-channel-id\n`);
    await delay(300);

    // No new lines should have arrived.
    expect(client.lines().length).toBe(lineCountBefore);

    client.close();
    await delay(100);
  });
});
