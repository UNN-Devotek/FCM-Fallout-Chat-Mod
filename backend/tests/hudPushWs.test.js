'use strict';
/**
 * Integration tests for the HUD push WebSocket front-end (hudPushWs.ts + hudPush.ts).
 *
 * Strategy: boot an http.Server + call initHudPushWs on an ephemeral port,
 * stub fetchFeedRows via jest.mock so no Postgres is needed, inject the channel
 * resolver via _setChannelResolver so no Prisma is needed for live lines.
 * HUD_PUSH_WS_ENABLED is forced on by setting process.env before importing the
 * module (mirrors how hudPushTcp.test.js handles the TCP env gate — but WS init
 * accepts the server object directly, so we also override env in-process).
 * All external dependencies (prisma, redis, database, discord) are mocked.
 *
 * Test coverage:
 *  - HELLO~1~<n> line + exactly n backfill lines on connect (with forged Origin)
 *  - Live line arrives via hudPushNotify after connection
 *  - Per-IP cap of 3: 4th connection from same IP is rejected (ws close)
 *  - >4 KB inbound bytes triggers connection terminate
 *  - Connection to a different path (e.g. /ws/other) is not handled by our
 *    upgrade listener (connection fails / no upgrade — tested with a timeout)
 */

const http = require('http');
const WebSocket = require('ws');

// ── Force-enable the WS gate before any env module loads ──────────────────────
// environment.ts reads process.env at module load time; set the var first.
process.env.HUD_PUSH_WS_ENABLED = 'true';

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

// ── Stub hudFeedService.fetchFeedRows so we control backfill rows ─────────────

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

// fetchFeedRows/fetchFeedRowsForChannel returns DESC (newest first); hudPush reverses before backfill.
jest.mock('../src/services/hudFeedService', () => {
  const real = jest.requireActual('../src/services/hudFeedService');
  return {
    ...real,
    fetchFeedRows: jest.fn().mockResolvedValue([...BACKFILL_ROWS]),
    fetchFeedRowsForChannel: jest.fn().mockResolvedValue([...BACKFILL_ROWS]),
  };
});

// ── Import modules under test ─────────────────────────────────────────────────

const { initHudPushWs } = require('../src/services/hudPushWs');
const { hudPushNotify, _setChannelResolver } = require('../src/services/hudPush');
const { buildFeedLines } = require('../src/services/hudFeedService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Connect a WebSocket client to the given URL and collect all received text
 * frames (split on \n, non-empty).
 * Returns: { lines(), waitForLines(n, ms), close(), ws }
 */
function connectWs(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  let buf = '';
  const lines = [];
  let resolver = null;
  let waitCount = 0;

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    buf += text;
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
        if (t.unref) t.unref();
      });
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
    ws,
  };
}

/** Small async delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('hudPushWs production guard', () => {
  // HUD push is dev-only until the M6 production-exposure decision: the env
  // flag alone must never attach the /ws/hud upgrade handler in production.
  test('initHudPushWs refuses to attach in production even when enabled', () => {
    // environment.ts ends with `module.exports = env`, so require() returns env itself.
    const env = require('../src/config/environment');
    const savedNodeEnv = env.NODE_ENV;
    const savedEnabled = env.HUD_PUSH_WS_ENABLED;
    const bareServer = http.createServer();
    try {
      env.NODE_ENV = 'production';
      env.HUD_PUSH_WS_ENABLED = true;
      initHudPushWs(bareServer);
      expect(bareServer.listeners('upgrade').length).toBe(0);
    } finally {
      env.NODE_ENV = savedNodeEnv;
      env.HUD_PUSH_WS_ENABLED = savedEnabled;
      bareServer.close();
    }
  });
});

describe('hudPushWs integration', () => {
  let httpServer;
  let serverPort;
  let baseUrl;
  // Leaf channel — parentId non-null so isHudEligibleChannel returns true.
  const eligibleChannel = { name: 'General', color: '#C8A840', parentId: '00000000-0000-0000-0000-000000000001', isArchived: false };

  beforeAll(async () => {
    // Inject a channel resolver so no Prisma is needed for live line tests.
    _setChannelResolver(async () => eligibleChannel);

    // Boot a bare http.Server on an ephemeral port and attach our WS handler.
    httpServer = http.createServer();
    initHudPushWs(httpServer);

    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        serverPort = httpServer.address().port;
        baseUrl = `ws://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    _setChannelResolver(null);
    // Destroy all open sockets so httpServer.close() can resolve.
    httpServer.closeAllConnections?.(); // Node 18.2+
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000); // fallback
      if (t.unref) t.unref();
      httpServer.close(() => { clearTimeout(t); resolve(); });
    });
  }, 10000);

  // ── HELLO + backfill ────────────────────────────────────────────────────────

  it('sends HELLO~1~2, ACTIVECHAN~General, and 2 backfill lines on connect (forged Origin accepted)', async () => {
    const client = connectWs(`${baseUrl}/ws/hud`, { Origin: 'https://evil.example' });

    // Wait for HELLO + ACTIVECHAN + 2 backfill = 4 lines.
    await client.waitForLines(4, 5000);
    client.close();

    const lines = client.lines();
    expect(lines[0]).toBe('HELLO~1~2');
    expect(lines[1]).toBe('ACTIVECHAN~General');

    // fetchFeedRowsForChannel returns DESC; rows.reverse() = ASC.
    // BACKFILL_ROWS[0] is newer (first in DESC) → after reverse it is last.
    // BACKFILL_ROWS[1] is older → after reverse it is first.
    const [expectedFirst] = buildFeedLines([BACKFILL_ROWS[1]]);
    const [expectedSecond] = buildFeedLines([BACKFILL_ROWS[0]]);
    expect(lines[2]).toBe(expectedFirst);
    expect(lines[3]).toBe(expectedSecond);
  });

  // ── Live line on hudPushNotify ──────────────────────────────────────────────

  it('delivers a live line when hudPushNotify is called with an eligible message', async () => {
    const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000005';
    const client = connectWs(`${baseUrl}/ws/hud`);
    await client.waitForLines(4, 5000);

    const countBefore = client.lines().length;

    hudPushNotify({
      type: 'chat:message',
      payload: {
        channelId: GENERAL_CHANNEL_ID,
        content: 'ws live message',
        username: 'WsLiveUser',
        isPrivate: false,
      },
    });

    await client.waitForLines(countBefore + 1, 3000);
    client.close();

    const liveLine = client.lines()[countBefore];
    expect(liveLine).toMatch(/^#C8A840~General~WsLiveUser~ws live message$/);
    expect(liveLine).not.toContain('\n');
  });

  // ── Per-IP connection cap ───────────────────────────────────────────────────

  it('rejects the 4th connection from the same IP (cap = 3)', async () => {
    const c1 = connectWs(`${baseUrl}/ws/hud`);
    const c2 = connectWs(`${baseUrl}/ws/hud`);
    const c3 = connectWs(`${baseUrl}/ws/hud`);

    // Wait for all 3 to receive their HELLO.
    await Promise.all([
      c1.waitForLines(1, 5000),
      c2.waitForLines(1, 5000),
      c3.waitForLines(1, 5000),
    ]);

    // 4th connection should be closed by the server after the cap check.
    const c4 = connectWs(`${baseUrl}/ws/hud`);
    await new Promise((resolve) => {
      c4.ws.on('close', resolve);
      c4.ws.on('error', resolve);
      // If the server somehow doesn't close it in 2.5s, move on.
      setTimeout(() => resolve(), 2500);
    });

    // c4 should have received no data lines (closed before HELLO).
    expect(c4.lines().length).toBe(0);

    c1.close();
    c2.close();
    c3.close();
    c4.close();
    await delay(150);
  });

  // ── Inbound byte cap ───────────────────────────────────────────────────────

  it('terminates connection when client sends more than 4 KB', async () => {
    const client = connectWs(`${baseUrl}/ws/hud`);
    await client.waitForLines(1, 5000);

    // Send 4097 bytes (exceeds the 4096-byte cap).
    client.ws.send(Buffer.alloc(4097, 0x41));

    await new Promise((resolve) => {
      client.ws.on('close', resolve);
      client.ws.on('error', resolve);
      setTimeout(() => resolve(), 2500);
    });

    // Connection should now be terminated/closed.
    expect([WebSocket.CLOSED, WebSocket.CLOSING]).toContain(client.ws.readyState);
    client.close();
    await delay(100);
  });

  // ── Other path not intercepted ─────────────────────────────────────────────

  it('does not handle upgrades to paths other than /ws/hud', async () => {
    // Attempt a WS upgrade to /ws/other — our handler must NOT handle it.
    // Since no other WS server is mounted on this bare http.Server, the
    // upgrade will be left unhandled (the socket is never upgraded), and the
    // ws client will emit an error or unexpected-response event rather than
    // 'open'.  We assert the connection does NOT successfully open.
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(`${baseUrl}/ws/other`);
      // If 'open' fires, our handler wrongly upgraded it.
      ws.once('open', () => { ws.close(); resolve(true); });
      // If error or unexpected-response fires, the upgrade was correctly not handled.
      ws.once('error', () => resolve(false));
      ws.once('unexpected-response', () => resolve(false));
      // Safety timeout.
      const t = setTimeout(() => { ws.terminate(); resolve(false); }, 2000);
      if (t.unref) t.unref();
    });

    expect(opened).toBe(false);
  });
});
