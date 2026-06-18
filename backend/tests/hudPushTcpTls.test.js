'use strict';
/**
 * TLS integration tests for hudPushTcp.ts.
 *
 * A throwaway self-signed cert+key is generated at test runtime via openssl
 * (written to os.tmpdir()) so no private key material is committed to the repo.
 * If openssl is not available on the PATH the entire suite is skipped with a
 * clear message rather than failing.
 *
 * tls.connect with rejectUnauthorized:false is used (mirrors ZFE's behaviour:
 * Schannel TLS 1.2 without cert validation).
 *
 * All heavy deps mocked identically to hudPushTcp.test.js.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const tls  = require('tls');
const { execSync } = require('child_process');

// ── Check openssl availability ────────────────────────────────────────────────

let CERT_PATH;
let KEY_PATH;
let opensslAvailable = false;

try {
  execSync('openssl version', { stdio: 'ignore' });
  opensslAvailable = true;
} catch {
  // openssl not on PATH — suite will be skipped
}

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

// Stub backfill rows.
const BACKFILL_ROWS = [
  {
    content: 'tls backfill one',
    username: 'TLSAlpha',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
    created_at: new Date('2026-06-10T10:00:00Z'),
  },
  {
    content: 'tls backfill two',
    username: 'TLSBeta',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
    created_at: new Date('2026-06-10T10:01:00Z'),
  },
];

jest.mock('../src/services/hudFeedService', () => {
  const real = jest.requireActual('../src/services/hudFeedService');
  return {
    ...real,
    fetchFeedRows: jest.fn().mockResolvedValue([...BACKFILL_ROWS]),
    fetchFeedRowsForChannel: jest.fn().mockResolvedValue([...BACKFILL_ROWS]),
  };
});

// ── Import modules under test ─────────────────────────────────────────────────

const { startTcpServer, stopTcpServer } = require('../src/services/hudPushTcp');
const { _setChannelResolver }           = require('../src/services/hudPush');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Connect over TLS (rejectUnauthorized:false — mirrors ZFE Schannel behaviour).
 * Returns the same helper API as the plaintext connect() in hudPushTcp.test.js.
 */
function tlsConnect(port, host = '127.0.0.1') {
  // rejectUnauthorized:false is required and safe here: this connects to a
  // localhost (127.0.0.1) test server using a throwaway self-signed cert that
  // is generated at runtime (see beforeAll). It also mirrors ZFE's Schannel
  // client, which intentionally does not validate the cert. NOT production code.
  // codeql[js/disabling-certificate-validation]
  const socket = tls.connect({ port, host, rejectUnauthorized: false });
  let buf = '';
  const lines = [];
  let resolver = null;
  let waitCount = 0;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop();
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
    waitForLines(n, timeoutMs = 5000) {
      if (lines.length >= n) return Promise.resolve();
      return new Promise((resolve, reject) => {
        waitCount = n;
        resolver = resolve;
        const t = setTimeout(() => {
          resolver = null;
          reject(new Error(`TLS: timeout waiting for ${n} lines (got ${lines.length}): ${JSON.stringify(lines)}`));
        }, timeoutMs);
        if (t.unref) t.unref();
      });
    },
    close() { socket.destroy(); },
    socket,
  };
}

// ── Set TLS env vars so startTcpServer() picks them up ───────────────────────

// environment.ts is already required via hudPushTcp; grab the live object.
const envObj = require('../src/config/environment');

// ── Test suite ────────────────────────────────────────────────────────────────

describe('hudPushTcp TLS', () => {
  let server;
  let serverPort;
  // Leaf channel — parentId non-null so isHudEligibleChannel returns true.
  const eligibleChannel = { name: 'General', color: '#C8A840', parentId: '00000000-0000-0000-0000-000000000001', isArchived: false };

  let savedCert;
  let savedKey;
  let tmpDir;

  beforeAll(async () => {
    if (!opensslAvailable) return; // skip — no openssl

    // Generate a throwaway self-signed cert in a temp directory.
    tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-tls-test-'));
    KEY_PATH  = path.join(tmpDir, 'test.key');
    CERT_PATH = path.join(tmpDir, 'test.crt');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 1 -nodes -subj "/CN=fcm-hud-test"`,
      { stdio: 'ignore' },
    );

    savedCert = envObj.HUD_PUSH_TCP_TLS_CERT;
    savedKey  = envObj.HUD_PUSH_TCP_TLS_KEY;

    envObj.HUD_PUSH_TCP_TLS_CERT = CERT_PATH;
    envObj.HUD_PUSH_TCP_TLS_KEY  = KEY_PATH;

    _setChannelResolver(async () => eligibleChannel);
    server     = await startTcpServer(0);
    serverPort = server.address().port;
  });

  afterAll(async () => {
    if (!opensslAvailable) return;

    _setChannelResolver(null);
    await stopTcpServer();
    envObj.HUD_PUSH_TCP_TLS_CERT = savedCert;
    envObj.HUD_PUSH_TCP_TLS_KEY  = savedKey;

    // Clean up generated cert files.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('accepts a TLS connection and sends HELLO~1~2 + ACTIVECHAN~General + 2 backfill lines', async () => {
    if (!opensslAvailable) {
      console.warn('hudPushTcpTls: openssl not found on PATH — skipping TLS suite');
      return;
    }
    const client = tlsConnect(serverPort);
    // HELLO + ACTIVECHAN + 2 backfill = 4 lines.
    await client.waitForLines(4, 7000);
    client.close();

    const lines = client.lines();
    expect(lines[0]).toBe('HELLO~1~2');
    expect(lines[1]).toBe('ACTIVECHAN~General');
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects TLS start when only one of cert/key is set', async () => {
    if (!opensslAvailable) {
      console.warn('hudPushTcpTls: openssl not found on PATH — skipping TLS suite');
      return;
    }
    const saved2Cert = envObj.HUD_PUSH_TCP_TLS_CERT;
    const saved2Key  = envObj.HUD_PUSH_TCP_TLS_KEY;
    try {
      envObj.HUD_PUSH_TCP_TLS_CERT = CERT_PATH;
      envObj.HUD_PUSH_TCP_TLS_KEY  = ''; // missing key
      // Need a fresh startTcpServer call on a different port (or ephemeral).
      // First stop the running server.
      await stopTcpServer();
      await expect(startTcpServer(0)).rejects.toThrow(/both be set/);
    } finally {
      envObj.HUD_PUSH_TCP_TLS_CERT = saved2Cert;
      envObj.HUD_PUSH_TCP_TLS_KEY  = saved2Key;
      // Restart the server for any subsequent tests.
      server     = await startTcpServer(0);
      serverPort = server.address().port;
    }
  });
});
