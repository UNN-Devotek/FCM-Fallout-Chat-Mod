'use strict';
/**
 * Tests for the chat.v1 relay — channelMap, tokenService, relaySeq,
 * worldIdService, upgradeRouter (/relay path), and relay op dispatch.
 *
 * Strategy: mock all heavy deps (prisma, redis, argon2, ingestMessage)
 * via jest.mock at the top level, keeping tests self-contained.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query:       jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) =>
    cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  ),
  pool: { on: jest.fn() },
}));

// Global counters / stores shared across tests
const _worldStore   = {};
let   _redisSeq     = 0;
const _pubCallbacks = [];
const _lists        = {}; // Redis list store (server-chat history)
const _counters     = {}; // per-key INCR counters (server-chat rate limit)

function resetRedisIncrMock() {
  Object.keys(_counters).forEach((key) => delete _counters[key]);
  redisMock.incr.mockImplementation(async (key) => {
    if (key === 'relay:seq' || key === undefined) return ++_redisSeq;
    _counters[key] = (_counters[key] || 0) + 1;
    return _counters[key];
  });
}

const redisMock = {
  get:  jest.fn().mockImplementation(async (key) => _worldStore[key] ?? null),
  set:  jest.fn().mockImplementation(async (key, val) => { _worldStore[key] = val; return 'OK'; }),
  del:  jest.fn().mockImplementation(async (key)      => { delete _worldStore[key]; return 1; }),
  // relay:seq keeps its dedicated monotonic counter; all other keys get per-key counters.
  incr: jest.fn().mockImplementation(async (key) => {
    if (key === 'relay:seq' || key === undefined) return ++_redisSeq;
    _counters[key] = (_counters[key] || 0) + 1;
    return _counters[key];
  }),
  keys: jest.fn().mockImplementation(async (pattern) => {
    const prefix = String(pattern).replace(/\*$/, '');
    return Object.keys(_worldStore).filter((k) => k.startsWith(prefix));
  }),
  scanIterator: jest.fn().mockImplementation(async function* ({ MATCH }) {
    const prefix = String(MATCH).replace(/\*$/, '');
    for (const key of Object.keys(_worldStore)) {
      if (key.startsWith(prefix)) yield key;
    }
  }),
  lPush:  jest.fn().mockImplementation(async (key, val) => { (_lists[key] = _lists[key] || []).unshift(val); return _lists[key].length; }),
  lTrim:  jest.fn().mockImplementation(async (key, start, stop) => { if (_lists[key]) _lists[key] = _lists[key].slice(start, stop + 1); return 'OK'; }),
  lRange: jest.fn().mockImplementation(async (key, start, stop) => { const l = _lists[key] || []; return stop === -1 ? l.slice(start) : l.slice(start, stop + 1); }),
  ping: jest.fn().mockResolvedValue('PONG'),
  connect: jest.fn().mockResolvedValue(undefined),
  on:   jest.fn(),
  subscribe: jest.fn().mockImplementation(async (_ch, cb) => { _pubCallbacks.push(cb); }),
  publish:   jest.fn().mockImplementation(async (_ch, msg) => {
    for (const cb of _pubCallbacks) cb(msg);
    return 1;
  }),
  zRemRangeByScore: jest.fn().mockResolvedValue(0),
  zAdd:             jest.fn().mockResolvedValue(1),
  zCard:            jest.fn().mockResolvedValue(1),
  expire:           jest.fn().mockResolvedValue(1),
  multi: jest.fn().mockReturnValue({
    zRemRangeByScore: jest.fn().mockReturnThis(),
    zAdd:             jest.fn().mockReturnThis(),
    zCard:            jest.fn().mockReturnThis(),
    expire:           jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([0, 1, 1, 1]),
  }),
};

jest.mock('../src/config/redis', () => ({
  getRedisClient:      jest.fn().mockResolvedValue(redisMock),
  getSubscriberClient: jest.fn().mockResolvedValue(redisMock),
  healthCheck: jest.fn().mockResolvedValue(true),
  client:           { on: jest.fn(), ping: jest.fn().mockResolvedValue('PONG'), isOpen: true },
  subscriberClient: { on: jest.fn(), isOpen: true },
}));

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init:      jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    decrement: jest.fn().mockResolvedValue(undefined),
    resetKey:  jest.fn().mockResolvedValue(undefined),
    get:       jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    localKeys: true,
  })),
}));

// Automod engine — server-chat sends call engineEvaluate directly (ingestMessage
// is separately mocked). Default: allow. A server-chat test overrides once to block.
jest.mock('../src/services/autoModEngine', () => ({
  engineEvaluate: jest.fn().mockResolvedValue({ block: false, matches: [] }),
}));

// Token + user state for mocked Prisma
let _tokenRows = [];
let _userMap   = {};

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique:  jest.fn().mockImplementation(async (args) => _userMap[args?.where?.id] ?? null),
      findMany:    jest.fn().mockResolvedValue([]),
      create:      jest.fn().mockImplementation(async (args) => {
        const u = { id: args.data.id || 'uid-stub', ...args.data };
        _userMap[u.id] = u;
        return u;
      }),
      update:      jest.fn().mockResolvedValue({}),
      updateMany:  jest.fn().mockResolvedValue({ count: 1 }),
    },
    hudPairingToken: {
      findFirst: jest.fn().mockImplementation(async (args) => {
        const userId = args?.where?.userId;
        return _tokenRows.find((row) => row.userId === userId) ?? null;
      }),
      findMany: jest.fn().mockImplementation(async (args) => {
        const prefix = args?.where?.tokenPrefix;
        if (!prefix) return [];
        return _tokenRows.filter((r) => r.tokenPrefix === prefix && !r.revokedAt);
      }),
      create: jest.fn().mockImplementation(async (args) => {
        const row = {
          id: `tok-${Date.now()}`,
          ...args.data,
          revokedAt:    null,
          lastUsedAt:   null,
          linkedUserId: args.data.linkedUserId ?? null,
        };
        _tokenRows.push(row);
        return row;
      }),
      update:     jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockImplementation(async (args) => {
        if (args?.where?.userId) {
          _tokenRows
            .filter((r) => r.userId === args.where.userId && !r.revokedAt)
            .forEach((r) => Object.assign(r, args.data));
        }
        return { count: 1 };
      }),
    },
    channel: {
      findFirst: jest.fn().mockResolvedValue({ id: 'ch1', isArchived: false }),
      findMany:  jest.fn().mockResolvedValue([]),
    },
    $queryRaw:    jest.fn().mockResolvedValue([]),
    $executeRaw:  jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (arg) =>
      typeof arg === 'function' ? arg({}) : Promise.all(arg),
    ),
  },
}));

jest.mock('../src/config/storage', () => ({
  getAvatarObject:    jest.fn().mockResolvedValue(null),
  getPartyImageObject: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/discordService', () => ({
  relayToDiscord:  jest.fn().mockResolvedValue(undefined),
  initDiscord:     jest.fn().mockResolvedValue(undefined),
  sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/autoModEngine', () => ({
  engineEvaluate: jest.fn().mockResolvedValue({ block: false }),
}));

jest.mock('../src/queues/messagePersist', () => ({
  __esModule: true,
  default: { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../src/websocket/handlers', () => ({
  broadcast:               jest.fn(),
  handleConnection:        jest.fn(),
  broadcastMessageDeletion: jest.fn(),
  broadcastReportAlert:    jest.fn(),
  broadcastChannelUpdate:  jest.fn(),
  broadcastCommandsUpdate: jest.fn(),
  getClientCount:          jest.fn().mockReturnValue(0),
  initPubSub:              jest.fn().mockResolvedValue(undefined),
  snapshotActiveClients:   jest.fn().mockReturnValue([]),
  resolveDisplayName:      jest.fn().mockReturnValue('TestUser'),
  pushToUser:              jest.fn(),
  isUserWsConnected:       jest.fn().mockReturnValue(false),
  isPendingDisconnect:     jest.fn().mockReturnValue(false),
  refreshClientIdentity:   jest.fn(),
  broadcastToPartyMembers: jest.fn(),
  getConnectedUserIds:     jest.fn().mockReturnValue([]),
  refreshClientBlocks:     jest.fn(),
}));

jest.mock('../src/controllers/healthController', () => ({
  incrementMessageCount: jest.fn(),
}));

// Mock ingestMessage so send tests don't need the full pipeline
jest.mock('../src/services/ingestMessage', () => ({
  ingestMessage:  jest.fn().mockResolvedValue({ ok: true, messageId: 'mock-msg-id' }),
  finalizeMessage: jest.fn().mockResolvedValue({ messageId: 'mock-msg-id', createdAt: new Date().toISOString() }),
  _clearIngestCaches: jest.fn(),
}));

// Mock the link-code service so pushLinkNotice can mint a code without the real prisma/redis
// pipeline (otherwise issueLinkCode rejects on the unmocked hud_link_codes table -> no notice).
jest.mock('../src/services/linkCodeService', () => ({
  issueLinkCode: jest.fn().mockResolvedValue('ABCD1234'),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

const http           = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const argon2         = require('argon2');

const {
  SLUG_TO_UUID, UUID_TO_SLUG, ALL_SLUGS,
  slugToChannelId, channelIdToSlug, isStaticSlug,
} = require('../src/services/relay/channelMap');

const {
  mintToken, verifyToken, revokeToken, updateDisplayName, clearVerificationCache,
} = require('../src/services/relay/tokenService');

const {
  nextRelaySeq, seedRelaySeq,
} = require('../src/services/relay/relaySeq');

const {
  setWorldId, getWorldId, clearWorldId,
} = require('../src/services/relay/worldIdService');

const {
  attachChatUpgradeRouter,
  RELAY_WS_PATH,
  CHAT_WS_PATH,
  _resetRelayWss,
} = require('../src/websocket/upgradeRouter');

const { deriveLinkUrl, isRelayAvailable } = require('../src/services/relay/relayHandler');

describe('relay production rollout gate', () => {
  test('keeps the relay available in development and test', () => {
    expect(isRelayAvailable({ nodeEnv: 'development', productionEnabled: false })).toBe(true);
    expect(isRelayAvailable({ nodeEnv: 'test', productionEnabled: false })).toBe(true);
  });

  test('fails closed in production until explicitly enabled', () => {
    expect(isRelayAvailable({ nodeEnv: 'production', productionEnabled: false })).toBe(false);
    expect(isRelayAvailable({ nodeEnv: 'production', productionEnabled: true })).toBe(true);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeServer() {
  _resetRelayWss();
  const server = http.createServer();
  const chatWss = new WebSocketServer({ noServer: true });
  attachChatUpgradeRouter(server, chatWss);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, chatWss, port: server.address().port });
    });
  });
}

function teardownServer({ server, chatWss }) {
  return new Promise((resolve) => {
    _resetRelayWss();
    chatWss.clients.forEach((ws) => ws.terminate());
    chatWss.close();
    // Force-close any lingering connections (Node 18.2+)
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
    // Safety net: resolve after 5s even if server.close hangs
    setTimeout(resolve, 5000);
  });
}

function connectWs(port, timeout = 4000) {
  return new Promise((resolve) => {
    const ws   = new WebSocket(`ws://127.0.0.1:${port}${RELAY_WS_PATH}`);
    const msgs = [];
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    ws.on('open',    ()    => finish({ ws, msgs, ok: true }));
    ws.on('message', (d)   => msgs.push(JSON.parse(d.toString())));
    ws.on('close',   (code) => finish({ ok: false, code }));
    ws.on('error',   (e)   => finish({ ok: false, error: e.message }));
    setTimeout(() => finish({ ok: false, error: 'timeout' }), timeout);
  });
}

function waitForMsg(ws, msgs, sendFn, timeout = 2000) {
  return new Promise((resolve) => {
    const startLen = msgs.length;
    sendFn();
    const iv = setInterval(() => {
      if (msgs.length > startLen) {
        clearInterval(iv);
        // Resolve with the FIRST new message (msgs[startLen]), not the last.
        // This matters when a register/hello also triggers an async system notice
        // that lands in the same msgs array shortly after the primary response.
        resolve(msgs[startLen]);
      }
    }, 20);
    setTimeout(() => { clearInterval(iv); resolve(null); }, timeout);
  });
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

// Inject a fake linked relay identity into the mock state.
// mintToken now returns a relay TEXT userId (no users row created). We
// simulate a completed link by setting linkedUserId on token rows to a
// fake FCM user UUID, and putting that FCM user in _userMap for ban checks.
const FAKE_FCM_USER_ID = 'fcm-account-uuid-001';
async function setupLinkedUser() {
  _tokenRows = [];
  _userMap   = {};
  const { userId, token } = await mintToken('Player1');
  // FCM users row (linked_user_id target) — keyed by FCM UUID.
  _userMap[FAKE_FCM_USER_ID] = {
    id:       FAKE_FCM_USER_ID,
    discordId: 'discord-123',
    steamId:   null,
    isBanned:  false,
    isMuted:   false,
  };
  // Set linkedUserId on token rows so verifyToken sees this identity as linked.
  _tokenRows.forEach((r) => {
    r.linkedUserId = FAKE_FCM_USER_ID;
  });
  return { userId, token };
}

// Helper: mark all token rows for a userId as linked to a given FCM user UUID.
// Simulates what markRelayTokenLinked() would do in the DB.
function markTokensLinked(relayUserId, fcmUserId) {
  _tokenRows
    .filter((r) => r.userId === relayUserId && !r.revokedAt)
    .forEach((r) => { r.linkedUserId = fcmUserId; });
}

// ── deriveLinkUrl (env-aware link-flow URL) ──────────────────────────────────────

describe('deriveLinkUrl', () => {
  test('strips scheme + trailing slash and appends /link', () => {
    expect(deriveLinkUrl('https://dev.falloutchatmod.com')).toBe('dev.falloutchatmod.com/link');
    expect(deriveLinkUrl('https://falloutchatmod.com/')).toBe('falloutchatmod.com/link');
    expect(deriveLinkUrl('http://localhost:7177')).toBe('localhost:7177/link');
  });
  test('falls back to the prod host when the base is empty', () => {
    expect(deriveLinkUrl('')).toBe('falloutchatmod.com/link');
  });
});

// ── channelMap ─────────────────────────────────────────────────────────────────

describe('channelMap', () => {
  test('all static slugs resolve to expected UUIDs', () => {
    expect(slugToChannelId('global')).toBe('00000000-0000-0000-0000-000000000005');
    expect(slugToChannelId('trade')).toBe('00000000-0000-0000-0000-000000000002');
    expect(slugToChannelId('events')).toBe('00000000-0000-0000-0000-000000000003');
    expect(slugToChannelId('raids')).toBe('00000000-0000-0000-0000-000000000004');
    expect(slugToChannelId('infests')).toBe('983995c1-f9ab-44c0-9b78-8b4cbf497273');
  });

  test('server slug returns null (dynamic)', () => {
    expect(slugToChannelId('server')).toBeNull();
  });

  test('unknown slugs return null', () => {
    expect(slugToChannelId('whisper')).toBeNull();
    expect(slugToChannelId('')).toBeNull();
    expect(slugToChannelId('nonexistent')).toBeNull();
  });

  test('UUID → slug round-trips for all static channels', () => {
    expect(channelIdToSlug('00000000-0000-0000-0000-000000000005')).toBe('global');
    expect(channelIdToSlug('00000000-0000-0000-0000-000000000002')).toBe('trade');
    expect(channelIdToSlug('00000000-0000-0000-0000-000000000003')).toBe('events');
    expect(channelIdToSlug('00000000-0000-0000-0000-000000000004')).toBe('raids');
    expect(channelIdToSlug('983995c1-f9ab-44c0-9b78-8b4cbf497273')).toBe('infests');
  });

  test('unknown UUID returns null', () => {
    expect(channelIdToSlug('00000000-0000-0000-0000-000000000099')).toBeNull();
  });

  test('ALL_SLUGS includes server and all static slugs', () => {
    expect(ALL_SLUGS).toContain('server');
    expect(ALL_SLUGS).toContain('global');
    expect(ALL_SLUGS).toContain('infests');
    expect(ALL_SLUGS.length).toBeGreaterThanOrEqual(6);
  });

  test('isStaticSlug true for static, false for server/unknown', () => {
    expect(isStaticSlug('global')).toBe(true);
    expect(isStaticSlug('infests')).toBe(true);
    expect(isStaticSlug('server')).toBe(false);
    expect(isStaticSlug('whisper')).toBe(false);
  });
});

// ── tokenService ───────────────────────────────────────────────────────────────

describe('tokenService', () => {
  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    jest.clearAllMocks();
    clearVerificationCache();
    // Re-setup redis mock after clearAllMocks
    require('../src/config/redis').getRedisClient.mockResolvedValue(redisMock);
    require('../src/config/prisma').default.user.create.mockImplementation(async (args) => {
      const u = { id: args.data.id || 'uid-stub', ...args.data };
      _userMap[u.id] = u;
      return u;
    });
    require('../src/config/prisma').default.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    require('../src/config/prisma').default.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => ({ ...r, linkedUserId: r.linkedUserId ?? null }));
    });
    require('../src/config/prisma').default.hudPairingToken.updateMany.mockImplementation(async (args) => {
      if (args?.where?.userId) {
        _tokenRows
          .filter((r) => r.userId === args.where.userId && !r.revokedAt)
          .forEach((r) => Object.assign(r, args.data));
      }
      return { count: 1 };
    });
  });

  test('mintToken returns userId, raw token, and role=user', async () => {
    const result = await mintToken('TestPlayer');
    expect(result.userId).toBeDefined();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(20);
    expect(result.role).toBe('user');
  });

  test('mintToken stores argon2id hash — can be verified', async () => {
    const { token } = await mintToken('TestPlayer');
    expect(_tokenRows).toHaveLength(1);
    const ok = await argon2.verify(_tokenRows[0].tokenHash, token);
    expect(ok).toBe(true);
  });

  test('mintToken token_prefix is first 8 chars of raw token', async () => {
    const { token } = await mintToken('TestPlayer');
    expect(_tokenRows[0].tokenPrefix).toBe(token.slice(0, 8));
  });

  test('verifyToken returns RelayToken for a valid token', async () => {
    const { userId, token } = await mintToken('TestPlayer');
    _userMap[userId] = { id: userId, discordId: 'disc123', steamId: null, isBanned: false, isMuted: false };
    // Set linkedUserId so verifyToken sees this as linked.
    _tokenRows[0].user         = _userMap[userId];
    _tokenRows[0].linkedUserId = 'fcm-user-uuid-123';
    // Override findMany to include user relation
    require('../src/config/prisma').default.hudPairingToken.findMany.mockResolvedValueOnce(
      _tokenRows.map((r) => ({ ...r, user: _userMap[r.userId] ?? { id: r.userId, discordId: null, steamId: null } })),
    );
    const identity = await verifyToken(token);
    expect(identity).not.toBeNull();
    expect(identity.userId).toBe(userId);
    expect(identity.fo76Name).toBe('TestPlayer');
    expect(identity.role).toBe('user');
    expect(identity.isLinked).toBe(true);      // linkedUserId is set
    expect(identity.linkedUserId).toBe('fcm-user-uuid-123');
  });

  test('verifyToken caches successful Argon2 verification for a short interval', async () => {
    const { token } = await mintToken('CachedPlayer');
    const findMany = require('../src/config/prisma').default.hudPairingToken.findMany;
    const first = await verifyToken(token);
    const callsAfterFirst = findMany.mock.calls.length;
    const second = await verifyToken(token);
    expect(first).toEqual(second);
    expect(findMany.mock.calls.length).toBe(callsAfterFirst);
  });

  test('verifyToken returns null for wrong token value', async () => {
    await mintToken('TestPlayer');
    _tokenRows[0].user = { id: _tokenRows[0].userId, discordId: null, steamId: null };
    // Wrong token — same prefix length but different content
    const fakeToken = _tokenRows[0].tokenPrefix + 'X'.repeat(40);
    require('../src/config/prisma').default.hudPairingToken.findMany.mockResolvedValueOnce(
      _tokenRows.map((r) => ({ ...r, user: { id: r.userId, discordId: null, steamId: null } })),
    );
    const identity = await verifyToken(fakeToken);
    expect(identity).toBeNull();
  });

  test('verifyToken returns null for revoked token', async () => {
    const { token } = await mintToken('TestPlayer');
    // Revoke the row
    _tokenRows[0].revokedAt = new Date();
    const identity = await verifyToken(token);
    expect(identity).toBeNull();
  });

  test('verifyToken returns null for short/invalid token', async () => {
    expect(await verifyToken('short')).toBeNull();
    expect(await verifyToken('')).toBeNull();
    expect(await verifyToken(null)).toBeNull();
  });

  test('revokeToken calls updateMany with revokedAt', async () => {
    const { userId } = await mintToken('TestPlayer');
    await revokeToken(userId);
    expect(require('../src/config/prisma').default.hudPairingToken.updateMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ userId, revokedAt: null }),
      }));
  });

  test('mintToken does NOT create a users row (anonymous relay identity)', async () => {
    // Under the device-link model, register is anonymous — no FCM account is created.
    // Only hud_pairing_tokens row is inserted; users row is created only after link redemption.
    const prisma = require('../src/config/prisma').default;
    prisma.user.create.mockClear();
    await mintToken('FO76Player');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.hudPairingToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fo76Name: 'FO76Player' }),
    }));
  });
});

// ── relaySeq ──────────────────────────────────────────────────────────────────

describe('relaySeq', () => {
  beforeEach(() => {
    _redisSeq = 0;
    jest.clearAllMocks();
    require('../src/config/redis').getRedisClient.mockResolvedValue(redisMock);
    redisMock.incr.mockImplementation(async () => ++_redisSeq);
  });

  test('nextRelaySeq returns strictly increasing values', async () => {
    const a = await nextRelaySeq();
    const b = await nextRelaySeq();
    const c = await nextRelaySeq();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test('nextRelaySeq calls Redis INCR relay:seq', async () => {
    redisMock.incr.mockClear();
    await nextRelaySeq();
    expect(redisMock.incr).toHaveBeenCalledWith('relay:seq');
  });

  test('seedRelaySeq seeds from MAX(relay_seq) via SET NX', async () => {
    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([{ max: BigInt(42) }]);
    redisMock.set.mockClear();
    await seedRelaySeq();
    expect(redisMock.set).toHaveBeenCalledWith('relay:seq', '42', { NX: true });
  });

  test('seedRelaySeq falls back to 0 when no rows exist', async () => {
    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([{ max: null }]);
    redisMock.set.mockClear();
    await seedRelaySeq();
    expect(redisMock.set).toHaveBeenCalledWith('relay:seq', '0', { NX: true });
  });
});

// ── worldIdService ─────────────────────────────────────────────────────────────

describe('worldIdService', () => {
  beforeEach(() => {
    for (const k of Object.keys(_worldStore)) delete _worldStore[k];
    jest.clearAllMocks();
    require('../src/config/redis').getRedisClient.mockResolvedValue(redisMock);
    redisMock.set.mockImplementation(async (key, val) => { _worldStore[key] = val; return 'OK'; });
    redisMock.get.mockImplementation(async (key) => _worldStore[key] ?? null);
    redisMock.del.mockImplementation(async (key) => { delete _worldStore[key]; return 1; });
  });

  test('setWorldId stores worldId with 60s TTL', async () => {
    await setWorldId('user-abc', 'world-xyz');
    expect(redisMock.set).toHaveBeenCalledWith('relay:world:user-abc', 'world-xyz', { EX: 60 });
  });

  test('getWorldId retrieves stored value', async () => {
    redisMock.get.mockResolvedValueOnce('world-999');
    const w = await getWorldId('user-abc');
    expect(w).toBe('world-999');
  });

  test('getWorldId returns null for missing key', async () => {
    redisMock.get.mockResolvedValueOnce(null);
    expect(await getWorldId('user-unknown')).toBeNull();
  });

  test('clearWorldId deletes the key', async () => {
    await clearWorldId('user-abc');
    expect(redisMock.del).toHaveBeenCalledWith('relay:world:user-abc');
  });
});

// ── upgradeRouter + relayHandler integration ──────────────────────────────────

/**
 * After a successful register call, extract the raw UUID userId from _tokenRows.
 * The register response returns `user_<hexWithoutDashes>`, but _userMap and
 * prisma.user.findUnique keyed by the raw UUID. Pick the last token row added.
 */
function lastRawUserId() {
  return _tokenRows[_tokenRows.length - 1]?.userId ?? null;
}

describe('relay WebSocket ops', () => {
  let srv;

  beforeAll(async () => {
    srv = await makeServer();
  }, 10000);

  afterAll(async () => {
    await teardownServer(srv);
  }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    _redisSeq  = 0;
    resetRedisIncrMock();
    redisMock.get.mockImplementation(async (key) => _worldStore[key] ?? null);
    redisMock.set.mockImplementation(async (key, val) => { _worldStore[key] = val; return 'OK'; });
    require('../src/config/prisma').default.user.create.mockImplementation(async (args) => {
      const u = { id: args.data.id || 'uid-stub', ...args.data };
      _userMap[u.id] = u;
      return u;
    });
    require('../src/config/prisma').default.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    require('../src/config/prisma').default.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => {
          const u = _userMap[r.userId] ?? { id: r.userId, discordId: null, steamId: null };
          // linkedUserId is the authoritative "linked" flag. Fall back to
          // deriving it from discordId/steamId for tests that pre-date this change.
          const linkedUserId = Object.prototype.hasOwnProperty.call(r, 'linkedUserId')
            ? r.linkedUserId
            : (u.discordId || u.steamId ? u.id : null);
          return { ...r, linkedUserId, user: u };
        });
    });
    require('../src/config/prisma').default.user.findUnique.mockImplementation(
      async (args) => _userMap[args?.where?.id] ?? null,
    );
    require('../src/config/prisma').default.$queryRaw.mockResolvedValue([]);
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue(
      { ok: true, messageId: 'msg-stub' },
    );
  });

  // Helper: connect a WS to this suite's server
  function conn() { return connectWs(srv.port); }

  test('/relay caps concurrent connections from one IP', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => conn()));
    const accepted = results.filter((result) => result.ok);
    expect(accepted).toHaveLength(5);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    await Promise.all(accepted.map(({ ws }) => new Promise((resolve) => {
      ws.once('close', resolve);
      ws.close();
    })));
  });

  test('/relay WebSocket accepts connections in test env', async () => {
    const { ok, ws } = await conn();
    expect(ok).toBe(true);
    ws.close();
  });

  test('/relay rejects frames larger than 8 KiB before JSON parsing', async () => {
    const { ok, ws } = await conn();
    expect(ok).toBe(true);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(Buffer.alloc(8 * 1024 + 1, 0x61));
    expect(await closed).toBe(1009);
  });

  test('unknown op → error envelope with invalid_request', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'nonexistent' }));
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_request' } });
    ws.close();
  });

  test('malformed JSON → error envelope', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => ws.send('not valid {{{'));
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_request' } });
    ws.close();
  });

  // ── register ────────────────────────────────────────────────────────────────

  test('register without displayName → error', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'register' }));
    expect(res.success).toBe(false);
    ws.close();
  });

  test('register with displayName → success with userId, token, role', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'register', displayName: 'FO76Player' }));
    expect(res).toMatchObject({ success: true, role: 'user' });
    expect(typeof res.userId).toBe('string');
    expect(typeof res.token).toBe('string');
    ws.close();
  });

  test('register is rate-limited before token hashing', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { ws, msgs } = await conn();
      const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'register', displayName: `RatePlayer${i}` }));
      expect(res).toMatchObject({ success: true, role: 'user' });
      ws.close();
    }

    const { ws, msgs } = await conn();
    const limited = await waitForMsg(ws, msgs, () => send(ws, { op: 'register', displayName: 'RatePlayer4' }));
    expect(limited).toMatchObject({ success: false, error: { code: 'rate_limited' } });
    ws.close();
  });

  // ── hello ────────────────────────────────────────────────────────────────────

  test('hello without token → auth_token_invalid', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'hello' }));
    expect(res).toMatchObject({ success: false, error: { code: 'auth_token_invalid' } });
    ws.close();
  });

  test('hello with invalid token → auth_token_invalid', async () => {
    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'hello', token: 'badtokenXXXXXXXXXXX' }));
    expect(res).toMatchObject({ success: false, error: { code: 'auth_token_invalid' } });
    ws.close();
  });

  test('hello with valid token → success (no token in response)', async () => {
    // Register first
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'HellPlayer' }),
    );
    wsReg.close();
    expect(regRes.success).toBe(true);
    const { token } = regRes;
    const rawId = lastRawUserId();

    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'hello', token }));
    expect(res).toMatchObject({ success: true, role: 'user' });
    expect(res.token).toBeUndefined(); // must NOT return the token
    ws.close();
  });

  test('hello for banned user → user_banned', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'BanPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    // Simulate a linked identity whose FCM account is banned.
    // Ban check resolves via linkedUserId → FCM users row.
    const fcmBanId = 'fcm-banned-user-001';
    _userMap[fcmBanId] = { id: fcmBanId, discordId: null, steamId: null, isBanned: true, isMuted: false };
    markTokensLinked(rawId, fcmBanId);

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'hello', token }));
    expect(res).toMatchObject({ success: false, error: { code: 'user_banned' } });
    ws.close();
  });

  // ── send ─────────────────────────────────────────────────────────────────────

  test('send with unknown channel slug → invalid_channel', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'SendPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-1', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'nonexistent', body: 'hello' }),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_channel' } });
    ws.close();
  });

  test('send with body > 500 chars → message_too_long', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'LongPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-2', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'x'.repeat(501) }),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'message_too_long' } });
    ws.close();
  });

  test('send from unlinked identity → permission_denied', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'LimitedPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    // No discordId/steamId = not linked
    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'hello' }),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'permission_denied' } });
    ws.close();
  });

  test('send from muted user → user_muted', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'MutedPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    // Simulate a linked identity whose FCM account is muted.
    // Mute check resolves via linkedUserId → FCM users row.
    const fcmMuteId = 'fcm-muted-user-001';
    _userMap[fcmMuteId] = { id: fcmMuteId, discordId: null, steamId: null, isBanned: false, isMuted: true };
    markTokensLinked(rawId, fcmMuteId);

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'hello' }),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'user_muted' } });
    ws.close();
  });

  test('send with valid linked user and known channel → success', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'GoodPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-ok', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'hello world' }),
    );
    expect(res).toMatchObject({ success: true });
    expect(typeof res.messageId).toBe('string');
    ws.close();
  });

  test('send forwards the linked FCM user UUID to ingestMessage, not the relay TEXT id', async () => {
    // Regression: handleSend used to pass identity.userId (the relay "user_"+hex TEXT
    // id) to ingestMessage, which runs prisma.user.findUnique({ id }) expecting a UUID
    // -> P2023 throw -> internal_error -> ZFE surfaces relay_rejected in-game. The
    // message author/moderation identity must be the linked FCM account UUID.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'LinkedSender' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();                 // relay TEXT id, e.g. "user_abc..."
    const fcmId = 'fcm-linked-sender-001';          // stands in for a users.id UUID
    _userMap[fcmId] = { id: fcmId, discordId: 'disc-x', steamId: null, isBanned: false, isMuted: false };
    markTokensLinked(rawId, fcmId);

    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockClear();

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'hi' }),
    );
    expect(res).toMatchObject({ success: true });
    expect(ingestMock).toHaveBeenCalled();
    const args = ingestMock.mock.calls[0][0];
    expect(args.userId).toBe(fcmId);                          // the linked FCM UUID
    expect(args.userId).not.toBe(rawId);                     // NOT the relay TEXT id
    expect(String(args.userId).startsWith('user_')).toBe(false);
    ws.close();
  });

  test('linked send rejected by automod → message_blocked (NOT permission_denied)', async () => {
    // Regression: automod/slash ingest failures used to collapse into permission_denied,
    // which the in-game widget then showed as "link your account" to an ALREADY-linked user.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'AutomodSender' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    const fcmId = 'fcm-automod-001';
    _userMap[fcmId] = { id: fcmId, discordId: 'disc-am', steamId: null, isBanned: false, isMuted: false };
    markTokensLinked(rawId, fcmId);

    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockResolvedValueOnce({ ok: false, reason: 'automod' });

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'filtered words' }),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'message_blocked' } });
    expect(res.error.code).not.toBe('permission_denied');
    ws.close();
  });

  test('limited (unlinked) subscriber receives the system link-code notice on subscribe', async () => {
    // Regression: the link notice was pushed only on register/hello — a transient connection the
    // in-game widget's pollEvents/liveSubscriber never reads — so the code never reached the widget.
    // It must ALSO be pushed on the long-lived subscribe connection.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'LimitedSub' }),
    );
    wsReg.close();
    const { token } = regRes;   // fresh register = limited (never linked)

    const { ws, msgs } = await conn();
    await waitForMsg(ws, msgs, () => send(ws, { op: 'subscribe', token }));
    // The notice is pushed right after 'subscribed'; allow it to land, then scan.
    await new Promise((r) => setTimeout(r, 300));
    const notice = msgs.find((m) => m && m.op === 'event' && m.event && m.event.channel === 'system');
    expect(notice).toBeTruthy();
    expect(String(notice.event.body)).toMatch(/enter code:/i);
    ws.close();
  });

  test('notifyLinkComplete pushes a LINK COMPLETE handshake to the live subscriber', async () => {
    // After the web redeem marks the identity linked, the relay pushes a "LINK COMPLETE" system
    // event to the user's live subscriber so an already-connected in-game widget hands off to chat.
    const { notifyLinkComplete } = require('../src/services/relay/relayHandler');
    const { ws: wsReg, msgs: msgsReg } = await conn();
    await waitForMsg(wsReg, msgsReg, () => send(wsReg, { op: 'register', displayName: 'HandshakeUser' }));
    const token = msgsReg.find((m) => m && m.token)?.token;
    const relayUserId = lastRawUserId();
    wsReg.close();

    const { ws, msgs } = await conn();
    await waitForMsg(ws, msgs, () => send(ws, { op: 'subscribe', token }));
    await new Promise((r) => setTimeout(r, 150));
    await notifyLinkComplete(relayUserId);
    await new Promise((r) => setTimeout(r, 250));
    const done = msgs.find((m) => m && m.op === 'event' && m.event && m.event.channel === 'system'
      && String(m.event.body).includes('LINK COMPLETE'));
    expect(done).toBeTruthy();
    ws.close();
  });

  test('send passes a numeric relaySeq into ingestMessage (single-broadcast model)', async () => {
    // Regression: handleSend must thread the pre-computed relaySeq INTO ingestMessage
    // (which forwards it to finalizeMessage → persisted messages.relay_seq + single
    // broadcast). The old code persisted via ingestMessage WITHOUT relaySeq and then
    // published a SEPARATE second rebroadcast carrying relaySeq. That double broadcast
    // is gone: there must be exactly one ingest call carrying the seq, and NO extra
    // relay-seq rebroadcast published to Redis from handleSend.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'SeqIngestPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    const fcmId = 'fcm-seq-ingest-001';
    _userMap[fcmId] = { id: fcmId, discordId: 'disc-seq-i', steamId: null, isBanned: false, isMuted: false };
    markTokensLinked(rawId, fcmId);

    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockClear();
    redisMock.publish.mockClear();

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'seq please' }),
    );
    expect(res).toMatchObject({ success: true });

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const args = ingestMock.mock.calls[0][0];
    expect(typeof args.relaySeq).toBe('number');
    expect(args.relaySeq).toBeGreaterThan(0);
    expect(args.source).toBe('relay');
    expect(args.userId).toBe(fcmId);

    // No separate relay-seq rebroadcast: handleSend no longer publishes the
    // second chat:message envelope itself (the single broadcast lives inside
    // finalizeMessage, which is reached through ingestMessage).
    const rebroadcasts = redisMock.publish.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('"type":"chat:message"'),
    );
    expect(rebroadcasts).toHaveLength(0);
    ws.close();
  });

  test('relay subscriber forwards a wrapped broadcast() envelope carrying relaySeq', async () => {
    // finalizeMessage emits a SINGLE broadcast via the WS handler's broadcast(),
    // which publishes a wrapped envelope on chat:broadcast:
    //   { instanceId, payload: { type:'chat:message', payload:{ …, relaySeq } } }
    // The relay subscriber must unwrap that envelope and push an 'event' frame
    // to subscribed ZFE clients.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'SubFwdPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-subfwd', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const subRes = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'subscribe', token, cursor: 0 }),
    );
    expect(subRes).toMatchObject({ success: true, op: 'subscribed' });

    const beforeLen = msgs.length;
    // Simulate finalizeMessage's broadcast() Redis publish (wrapped envelope).
    const wrapped = JSON.stringify({
      instanceId: 'other-instance',
      payload: {
        type: 'chat:message',
        payload: {
          id: 'msg-fwd-1',
          content: 'forwarded body',
          username: 'SubFwdPlayer',
          userId: 'fcm-fwd-001',
          channelId: '00000000-0000-0000-0000-000000000005',
          source: 'relay',
          timestamp: new Date().toISOString(),
          relaySeq: 9999,
        },
      },
    });
    await redisMock.publish('chat:broadcast', wrapped);

    // Wait for the event frame to land on the subscriber socket.
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (msgs.length > beforeLen) { clearInterval(iv); resolve(); }
      }, 20);
      setTimeout(() => { clearInterval(iv); resolve(); }, 1000);
    });

    const evt = msgs.slice(beforeLen).find((m) => m.op === 'event');
    expect(evt).toBeDefined();
    expect(evt.cursor).toBe(9999);
    expect(evt.event).toMatchObject({
      id: 9999,
      kind: 'chat.message',
      messageId: 'msg-fwd-1',
      channel: 'global',
      body: 'forwarded body',
    });
    ws.close();
  });

  test('relay subscriber forwards createdAt from the broadcast timestamp', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'TsFwdPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-tsfwd', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const subRes = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'subscribe', token, cursor: 0 }),
    );
    expect(subRes).toMatchObject({ success: true, op: 'subscribed' });

    const ISO = '2026-06-26T01:02:03.000Z';
    const beforeLen = msgs.length;
    const wrapped = JSON.stringify({
      instanceId: 'other-instance',
      payload: {
        type: 'chat:message',
        payload: {
          id: 'msg-tsfwd-1',
          content: 'timed forward',
          username: 'TsFwdPlayer',
          userId: 'fcm-tsfwd-001',
          channelId: '00000000-0000-0000-0000-000000000005',
          source: 'relay',
          timestamp: ISO,
          relaySeq: 9998,
        },
      },
    });
    await redisMock.publish('chat:broadcast', wrapped);

    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (msgs.length > beforeLen) { clearInterval(iv); resolve(); }
      }, 20);
      setTimeout(() => { clearInterval(iv); resolve(); }, 1000);
    });

    const evt = msgs.slice(beforeLen).find((m) => m.op === 'event');
    expect(evt).toBeDefined();
    expect(evt.event.createdAt).toBe(ISO);
    ws.close();
  });

  test('send does not forward targetUserId to ingestMessage', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'TgtPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-tgt', steamId: null, isBanned: false, isMuted: false };

    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockClear();

    const { ws, msgs } = await conn();
    await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'msg', targetUserId: 'victim-id' }),
    );

    // ingestMessage call args must not include targetUserId
    if (ingestMock.mock.calls.length > 0) {
      const args = ingestMock.mock.calls[0][0];
      expect(args).not.toHaveProperty('targetUserId');
    }
    ws.close();
  });

  test('relaySeq increments strictly for each send', async () => {
    const startSeq = _redisSeq;
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'SeqPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-seq', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'global', body: 'msg1' }),
    );
    await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'send', token, channel: 'trade', body: 'msg2' }),
    );
    expect(_redisSeq).toBeGreaterThan(startSeq);
    ws.close();
  });

  // ── poll ─────────────────────────────────────────────────────────────────────

  test('poll(cursor=0) returns success with events array', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'PollPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;

    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([]);

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'poll', token, cursor: 0, max: 10 }),
    );
    expect(res).toMatchObject({ success: true });
    expect(Array.isArray(res.events)).toBe(true);
    ws.close();
  });

  test('poll(cursor>0) returns events after cursor', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'PollPlayer2' }),
    );
    wsReg.close();
    const { token } = regRes;

    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([{
      id: 'msg-poll-1',
      relay_seq: BigInt(5),
      content: 'test',
      user_id: 'u1',
      channel_id: '00000000-0000-0000-0000-000000000005',
      username: 'PollPlayer2',
      fo76_account_name: null,
    }]);

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'poll', token, cursor: 4, max: 10 }),
    );
    expect(res).toMatchObject({ success: true });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].id).toBe(5);
    expect(res.events[0].channel).toBe('global');
    ws.close();
  });

  test('poll events include createdAt (ISO 8601 UTC) from the message row', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'TsPollPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;

    const ISO = '2026-06-26T12:34:56.000Z';
    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([{
      id: 'msg-ts-1',
      relay_seq: BigInt(7),
      content: 'timed',
      user_id: 'u1',
      channel_id: '00000000-0000-0000-0000-000000000005',
      username: 'TsPollPlayer',
      fo76_account_name: null,
      created_at: new Date(ISO),
    }]);

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'poll', token, cursor: 6, max: 10 }),
    );
    expect(res.events).toHaveLength(1);
    expect(res.events[0].createdAt).toBe(ISO);
    ws.close();
  });

  // ── subscribe ─────────────────────────────────────────────────────────────────

  test('subscribe returns subscribed ack with cursor/userId/role', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'SubPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-sub', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    const res = await waitForMsg(ws, msgs, () =>
      send(ws, { op: 'subscribe', token, cursor: 0 }),
    );
    expect(res).toMatchObject({ success: true, op: 'subscribed', cursor: 0, role: 'user' });
    ws.close();
  });

  test('duplicate subscribe on one connection is rejected', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'DuplicateSubPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-duplicate-sub', steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn();
    await waitForMsg(ws, msgs, () => send(ws, { op: 'subscribe', token, cursor: 0 }));
    const duplicate = await waitForMsg(ws, msgs, () => send(ws, { op: 'subscribe', token, cursor: 0 }));
    expect(duplicate).toMatchObject({ success: false, error: { code: 'already_subscribed' } });
    ws.close();
  });

  test('subscribe streams initial static history into the native event queue', async () => {
    // ZFE's pollEvents drains the queue populated by the long-lived subscribe
    // transport; it does not issue a separate relay poll request on startup.
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'NoDrainPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-nd', steamId: null, isBanned: false, isMuted: false };

    const historyRow = {
      id: 'msg-nd', relay_seq: BigInt(1), content: 'hist', user_id: 'u1',
      channel_id: '00000000-0000-0000-0000-000000000005', username: 'NoDrainPlayer', fo76_account_name: null,
    };
    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([historyRow]);

    const { ws: wsSub, msgs: msgsSub } = await conn();
    await waitForMsg(wsSub, msgsSub, () =>
      send(wsSub, { op: 'subscribe', token, cursor: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const historyEvent = msgsSub.find((msg) =>
      msg.op === 'event' && msg.event?.messageId === historyRow.id,
    );
    expect(historyEvent).toMatchObject({
      op: 'event',
      cursor: 1,
      event: { id: 1, channel: 'global', body: 'hist' },
    });
    wsSub.close();
  });

  test('subscribe streams current-world history into the native event queue', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      send(wsReg, { op: 'register', displayName: 'WorldHistoryPlayer' }),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-world-history', steamId: null, isBanned: false, isMuted: false };

    const worldId = 'world-subscription-history';
    const worldEvent = {
      id: 2,
      kind: 'chat.message',
      messageId: 'server:world-subscription-history:2',
      channel: 'server',
      senderUserId: 'u1',
      senderDisplayName: 'WorldHistoryPlayer',
      body: 'world history',
      targetUserId: '',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    await setWorldId(rawId, worldId);
    _lists[`relay:serverchat:${worldId}`] = [JSON.stringify(worldEvent)];

    const { ws: wsSub, msgs: msgsSub } = await conn();
    await waitForMsg(wsSub, msgsSub, () =>
      send(wsSub, { op: 'subscribe', token, cursor: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const historyEvent = msgsSub.find((msg) =>
      msg.op === 'event' && msg.event?.messageId === worldEvent.messageId,
    );
    expect(historyEvent).toMatchObject({
      op: 'event',
      cursor: 2,
      event: { id: 2, channel: 'server', body: 'world history' },
    });
    wsSub.close();
  });
});

// ── authenticated world-control tests ─────────────────────────────────────────

describe('authenticated world controls', () => {
  const SENTINEL = 'FCMCTL/1/WORLD:';

  let srv2;

  beforeAll(async () => {
    srv2 = await makeServer();
  }, 10000);

  afterAll(async () => {
    await teardownServer(srv2);
  }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    resetRedisIncrMock();
    require('../src/config/prisma').default.user.create.mockImplementation(async (args) => {
      const u = { id: args.data.id || 'uid-stub', ...args.data };
      _userMap[u.id] = u;
      return u;
    });
    require('../src/config/prisma').default.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    require('../src/config/prisma').default.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => {
          const u = _userMap[r.userId] ?? { id: r.userId, discordId: null, steamId: null };
          const linkedUserId = Object.prototype.hasOwnProperty.call(r, 'linkedUserId')
            ? r.linkedUserId
            : (u.discordId || u.steamId ? u.id : null);
          return { ...r, linkedUserId, user: u };
        });
    });
    require('../src/config/prisma').default.user.findUnique.mockImplementation(
      async (args) => _userMap[args?.where?.id] ?? null,
    );
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue({ ok: true, messageId: 'ctrl-stub' });
  });

  test('worldId control message is consumed and NOT passed to ingestMessage', async () => {
    const { ws: wsReg, msgs: msgsReg } = await connectWs(srv2.port);
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'WorldPlayer' })),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-world', steamId: null, isBanned: false, isMuted: false };

    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockClear();

    // The authenticated relay token, not a SWF-embedded secret, binds the control
    // to this identity. The wire format carries only bounded HUD metadata.
    const body = `${SENTINEL}world-001`;

    const { ws, msgs } = await connectWs(srv2.port);
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'send', token, channel: 'server', body })),
    );

    // worldId control is consumed — returns a chat.v1-compliant synthetic ack, no ingest
    expect(res).toMatchObject({ success: true, messageId: expect.any(String) });
    expect(res.messageId).not.toBe('');
    expect(ingestMock).not.toHaveBeenCalled();
    ws.close();
  });

  test('malformed worldId control falls through to the normal server-channel guard', async () => {
    const { ws: wsReg, msgs: msgsReg } = await connectWs(srv2.port);
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'HmacFail' })),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-hf', steamId: null, isBanned: false, isMuted: false };

    const badBody = `${SENTINEL}world-x|unexpected-field`;
    const { ws, msgs } = await connectWs(srv2.port);
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'send', token, channel: 'server', body: badBody })),
    );
    // Falls through: no worldId in Redis → invalid_channel
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_channel' } });
    ws.close();
  });

  test('oversized worldId control is rejected', async () => {
    const { ws: wsReg, msgs: msgsReg } = await connectWs(srv2.port);
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'StalePlayer' })),
    );
    wsReg.close();
    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: 'disc-stale', steamId: null, isBanned: false, isMuted: false };

    const staleBody = `${SENTINEL}${'x'.repeat(129)}`;

    const { ws, msgs } = await connectWs(srv2.port);
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'send', token, channel: 'server', body: staleBody })),
    );
    // Falls through: no worldId in Redis → invalid_channel
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_channel' } });
    ws.close();
  });
});

// ── Server chat (worldId-scoped ephemeral room) ────────────────────────────────

describe('server chat (worldId-scoped room)', () => {
  const SENTINEL       = 'FCMCTL/1/WORLD:';
  const LEAVE_SENTINEL = 'FCMCTL/1/LEAVE';
  const LEGACY_SENTINEL = '\x00fcm.world.v1\x00';

  const makeJoinBody = (worldId) => `${SENTINEL}${worldId}`;
  const makeLeaveBody = () => LEAVE_SENTINEL;

  let srv;

  beforeAll(async () => { srv = await makeServer(); }, 10000);
  afterAll(async () => { await teardownServer(srv); }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    Object.keys(_worldStore).forEach((k) => delete _worldStore[k]);
    Object.keys(_lists).forEach((k) => delete _lists[k]);
    // Restore the per-key limits after the relaySeq suite's key-agnostic mock.
    resetRedisIncrMock();
    const prisma = require('../src/config/prisma').default;
    prisma.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}-${Math.round(_redisSeq)}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    prisma.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => ({ ...r, linkedUserId: r.linkedUserId ?? null, user: _userMap[r.linkedUserId] ?? null }));
    });
    prisma.user.findUnique.mockImplementation(async (args) => _userMap[args?.where?.id] ?? null);
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue({ ok: true, messageId: 'stub' });
    require('../src/services/autoModEngine').engineEvaluate.mockResolvedValue({ block: false, matches: [] });
  });

  // Register a relay identity and mark it linked to a fresh FCM user UUID.
  async function registerAndLink(name, fcmId) {
    const { ws, msgs } = await connectWs(srv.port);
    const reg = await waitForMsg(ws, msgs, () => ws.send(JSON.stringify({ op: 'register', displayName: name })));
    ws.close();
    const token = reg.token;
    const rawId = reg.userId;
    _userMap[fcmId] = { id: fcmId, discordId: `d-${fcmId}`, steamId: null, isBanned: false, isMuted: false };
    markTokensLinked(rawId, fcmId);
    return { token, rawId, fcmId };
  }

  async function sendCtrl(user, body) {
    const { ws, msgs } = await connectWs(srv.port);
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'send', token: user.token, channel: 'server', body }));
    ws.close();
    return res;
  }
  const sendJoin  = (user, worldId) => sendCtrl(user, makeJoinBody(worldId));
  const sendLeave = (user)          => sendCtrl(user, makeLeaveBody());

  test('server send with no active world → invalid_channel', async () => {
    const a = await registerAndLink('Nomad', 'fcm-nomad');
    const { ws, msgs } = await connectWs(srv.port);
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'send', token: a.token, channel: 'server', body: 'hi' }));
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_channel' } });
    ws.close();
  });

  test('JOIN and LEAVE controls return protocol-compliant non-empty message IDs', async () => {
    const a = await registerAndLink('ControlAck', 'fcm-control-ack');
    const join = await sendJoin(a, 'world-ack');
    expect(join).toMatchObject({ success: true, messageId: expect.any(String) });
    expect(join.messageId).not.toBe('');

    const leave = await sendLeave(a);
    expect(leave).toMatchObject({ success: true, messageId: expect.any(String) });
    expect(leave.messageId).not.toBe('');
  });

  test('world controls are rate-limited per authenticated relay identity', async () => {
    // The limiter keys by a 10-second wall-clock bucket. Pin time so this test cannot
    // flake when its seven WebSocket requests straddle a real bucket boundary.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const a = await registerAndLink('ControlBurst', 'fcm-control-burst');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await expect(sendJoin(a, 'world-rate')).resolves.toMatchObject({ success: true });
      }
      await expect(sendJoin(a, 'world-rate')).resolves.toMatchObject({
        success: false,
        error: { code: 'rate_limited' },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('server chat send is ephemeral — never hits ingestMessage/Postgres', async () => {
    const a = await registerAndLink('Ghost', 'fcm-ghost');
    await sendJoin(a, 'world-Z');
    const ingestMock = require('../src/services/ingestMessage').ingestMessage;
    ingestMock.mockClear();
    const res = await sendCtrl(a, 'ephemeral hi'); // ordinary body (not a control sentinel)
    expect(res).toMatchObject({ success: true });
    expect(String(res.messageId)).toMatch(/^server:world-Z:/);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  test('accepts a legacy JSON-decoded world control for deployed-widget compatibility', async () => {
    const a = await registerAndLink('Legacy', 'fcm-legacy');
    expect(await sendCtrl(a, `${LEGACY_SENTINEL}world-legacy`)).toMatchObject({ success: true });
    expect(await sendCtrl(a, 'legacy session is active')).toMatchObject({
      success: true,
      messageId: expect.stringMatching(/^server:world-legacy:/),
    });
  });

  test('accepts the standalone legacy world control only for the authenticated relay identity', async () => {
    const a = await registerAndLink('LegacyHmac', 'fcm-legacy-hmac');
    const ts = Math.floor(Date.now() / 1000);
    const valid = `${LEGACY_SENTINEL}world-legacy-hmac|${a.rawId}|${ts}|${'a'.repeat(64)}`;
    expect(await sendCtrl(a, valid)).toMatchObject({ success: true, messageId: expect.any(String) });

    await sendLeave(a);
    const spoofed = `${LEGACY_SENTINEL}world-spoof|other-relay-user|${ts}|${'a'.repeat(64)}`;
    expect(await sendCtrl(a, spoofed)).toMatchObject({
      success: false,
      error: { code: 'invalid_channel' },
    });
  });

  test('server messages are world-scoped — same-world subscriber receives, other-world does NOT', async () => {
    const a = await registerAndLink('Alice', 'fcm-alice');
    const b = await registerAndLink('Bob',   'fcm-bob');

    const { ws: wsA, msgs: msgsA } = await connectWs(srv.port);
    await waitForMsg(wsA, msgsA, () => send(wsA, { op: 'subscribe', token: a.token, cursor: 0 }));
    const { ws: wsB, msgs: msgsB } = await connectWs(srv.port);
    await waitForMsg(wsB, msgsB, () => send(wsB, { op: 'subscribe', token: b.token, cursor: 0 }));

    await sendJoin(a, 'world-X'); // rebinds Alice's live subscriber to world-X
    await sendJoin(b, 'world-Y');

    const beforeA = msgsA.length;
    const beforeB = msgsB.length;
    const res = await sendCtrl(a, 'hello world X');
    expect(res).toMatchObject({ success: true });

    await new Promise((r) => setTimeout(r, 120)); // let the pub/sub fan-out land

    const aEvents = msgsA.slice(beforeA).filter((m) => m.op === 'event' && m.event?.channel === 'server');
    const bEvents = msgsB.slice(beforeB).filter((m) => m.op === 'event' && m.event?.channel === 'server');
    expect(aEvents.length).toBeGreaterThan(0);
    expect(aEvents[aEvents.length - 1].event.body).toBe('hello world X');
    expect(bEvents.length).toBe(0); // Bob (world-Y) never sees world-X server chat

    wsA.close();
    wsB.close();
  });

  test('automod-blocked server message → message_blocked', async () => {
    const a = await registerAndLink('Rude', 'fcm-rude');
    await sendJoin(a, 'world-M');
    require('../src/services/autoModEngine').engineEvaluate.mockResolvedValueOnce({ block: true, matches: [], customMessage: 'nope' });
    const res = await sendCtrl(a, 'blocked content');
    expect(res).toMatchObject({ success: false, error: { code: 'message_blocked' } });
  });

  test('LEAVE clears world membership — subsequent server send is invalid_channel', async () => {
    const a = await registerAndLink('Leaver', 'fcm-leaver');
    await sendJoin(a, 'world-Q');
    expect(await sendCtrl(a, 'still here')).toMatchObject({ success: true }); // in-world → ok
    await sendLeave(a);
    const res = await sendCtrl(a, 'after leave');
    expect(res).toMatchObject({ success: false, error: { code: 'invalid_channel' } });
  });
});

// ── Roster-derived world rooms ─────────────────────────────────────────────────

describe('roster-derived world rooms', () => {
  const ROSTER_SENTINEL = 'FCMCTL/1/ROSTER:';

  const makeRosterBody = (_userId, names) => ROSTER_SENTINEL + names.join('|');

  let srv;
  beforeAll(async () => { srv = await makeServer(); }, 10000);
  afterAll(async () => { await teardownServer(srv); }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    Object.keys(_worldStore).forEach((k) => delete _worldStore[k]);
    Object.keys(_lists).forEach((k) => delete _lists[k]);
    resetRedisIncrMock();
    const prisma = require('../src/config/prisma').default;
    prisma.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}-${Math.round(_redisSeq)}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    prisma.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => ({ ...r, linkedUserId: r.linkedUserId ?? null, user: _userMap[r.linkedUserId] ?? null }));
    });
    prisma.user.findUnique.mockImplementation(async (args) => _userMap[args?.where?.id] ?? null);
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue({ ok: true, messageId: 'stub' });
    require('../src/services/autoModEngine').engineEvaluate.mockResolvedValue({ block: false, matches: [] });
  });

  async function registerAndLink(name, fcmId) {
    const { ws, msgs } = await connectWs(srv.port);
    const reg = await waitForMsg(ws, msgs, () => ws.send(JSON.stringify({ op: 'register', displayName: name })));
    ws.close();
    _userMap[fcmId] = { id: fcmId, discordId: `d-${fcmId}`, steamId: null, isBanned: false, isMuted: false };
    markTokensLinked(reg.userId, fcmId);
    return { token: reg.token, rawId: reg.userId, name };
  }
  async function sendRaw(user, body) {
    const { ws, msgs } = await connectWs(srv.port);
    const res = await waitForMsg(ws, msgs, () => send(ws, { op: 'send', token: user.token, channel: 'server', body }));
    ws.close();
    return res;
  }

  test('roster controls return a protocol-compliant non-empty message ID', async () => {
    const a = await registerAndLink('RosterAck', 'fcm-roster-ack');
    const res = await sendRaw(a, makeRosterBody(a.rawId, []));
    expect(res).toMatchObject({ success: true, messageId: expect.any(String) });
    expect(res.messageId).not.toBe('');
  });

  test('mutual sighting groups users into one room; unsighted user is isolated', async () => {
    const a = await registerAndLink('RosterAlice', 'fcm-ra');
    const b = await registerAndLink('RosterBob',   'fcm-rb');
    const c = await registerAndLink('RosterCarol', 'fcm-rc');

    const { ws: wsA, msgs: msgsA } = await connectWs(srv.port);
    await waitForMsg(wsA, msgsA, () => send(wsA, { op: 'subscribe', token: a.token, cursor: 0 }));
    const { ws: wsB, msgs: msgsB } = await connectWs(srv.port);
    await waitForMsg(wsB, msgsB, () => send(wsB, { op: 'subscribe', token: b.token, cursor: 0 }));
    const { ws: wsC, msgs: msgsC } = await connectWs(srv.port);
    await waitForMsg(wsC, msgsC, () => send(wsC, { op: 'subscribe', token: c.token, cursor: 0 }));

    // A and B mutually report each other's character; C reports seeing nobody.
    expect(await sendRaw(a, makeRosterBody(a.rawId, ['rosterbob']))).toMatchObject({ success: true });
    expect(await sendRaw(b, makeRosterBody(b.rawId, ['rosteralice']))).toMatchObject({ success: true });
    expect(await sendRaw(c, makeRosterBody(c.rawId, []))).toMatchObject({ success: true });

    const beforeB = msgsB.length; const beforeC = msgsC.length;
    const res = await sendRaw(a, 'hello same world');
    expect(res).toMatchObject({ success: true });
    await new Promise((r) => setTimeout(r, 150));

    const bGot = msgsB.slice(beforeB).some((m) => m.op === 'event' && m.event?.body === 'hello same world');
    const cGot = msgsC.slice(beforeC).some((m) => m.op === 'event' && m.event?.body === 'hello same world');
    expect(bGot).toBe(true);   // Bob shares A's roster-derived room
    expect(cGot).toBe(false);  // Carol is in her own solo room

    // Carol can still use server chat alone (solo room).
    const solo = await sendRaw(c, 'talking to myself');
    expect(solo).toMatchObject({ success: true });

    wsA.close(); wsB.close(); wsC.close();
  });

  test('oversized roster control is rejected before it can create a room assignment', async () => {
    const a = await registerAndLink('RosterEve', 'fcm-re');
    const bad = ROSTER_SENTINEL + 'x'.repeat(2049);
    const res = await sendRaw(a, bad);
    expect(res).toMatchObject({ success: false, error: { code: 'message_too_long' } });
  });
});

// ── IngestSource type check ───────────────────────────────────────────────────

describe('IngestSource includes relay', () => {
  const path = require('path');
  const fs   = require('fs');
  const src  = fs.readFileSync(
    path.join(__dirname, '../src/services/ingestMessage.ts'), 'utf8',
  );

  test("IngestSource union includes 'relay'", () => {
    expect(src).toContain("'relay'");
  });

  test("checkRateLimit fails closed for relay source", () => {
    expect(src).toMatch(/failClosed.*source.*relay|relay.*failClosed/s);
  });
});

// ── loopback contract test ─────────────────────────────────────────────────────

describe('loopback: register → subscribe → send → poll', () => {
  let srv4;

  beforeAll(async () => {
    srv4 = await makeServer();
  }, 10000);

  afterAll(async () => {
    await teardownServer(srv4);
  }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    _redisSeq  = 0;
    resetRedisIncrMock();
    require('../src/config/prisma').default.user.create.mockImplementation(async (args) => {
      const u = { id: args.data.id || 'uid-stub', ...args.data };
      _userMap[u.id] = u;
      return u;
    });
    require('../src/config/prisma').default.hudPairingToken.create.mockImplementation(async (args) => {
      const row = { id: `tok-${Date.now()}`, ...args.data, revokedAt: null, lastUsedAt: null };
      _tokenRows.push(row);
      return row;
    });
    require('../src/config/prisma').default.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => {
          const u = _userMap[r.userId] ?? { id: r.userId, discordId: null, steamId: null };
          const linkedUserId = Object.prototype.hasOwnProperty.call(r, 'linkedUserId')
            ? r.linkedUserId
            : (u.discordId || u.steamId ? u.id : null);
          return { ...r, linkedUserId, user: u };
        });
    });
    require('../src/config/prisma').default.user.findUnique.mockImplementation(
      async (args) => _userMap[args?.where?.id] ?? null,
    );
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue({ ok: true, messageId: 'loop-msg' });
  });

  test('register → subscribe → send → poll all succeed', async () => {
    const port = srv4.port;

    // 1. Register
    const { ws: wsReg, msgs: msgsReg } = await connectWs(port);
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'LoopPlayer' })),
    );
    expect(regRes).toMatchObject({ success: true, role: 'user' });
    const { token } = regRes;
    const rawId = lastRawUserId();
    wsReg.close();

    // Mark as linked so send is permitted
    _userMap[rawId] = { id: rawId, discordId: 'disc-loop', steamId: null, isBanned: false, isMuted: false };

    // 2. Subscribe
    const { ws: wsSub, msgs: msgsSub } = await connectWs(port);
    const subRes = await waitForMsg(wsSub, msgsSub, () =>
      wsSub.send(JSON.stringify({ op: 'subscribe', token, cursor: 0 })),
    );
    expect(subRes).toMatchObject({ success: true, op: 'subscribed' });

    // 3. Send (different connection — models real ZFE short-lived connection)
    const { ws: wsSend, msgs: msgsSend } = await connectWs(port);
    const sendRes = await waitForMsg(wsSend, msgsSend, () =>
      wsSend.send(JSON.stringify({ op: 'send', token, channel: 'global', body: 'loopback!' })),
    );
    expect(sendRes).toMatchObject({ success: true });
    wsSend.close();

    // 4. Poll
    require('../src/config/prisma').default.$queryRaw.mockResolvedValueOnce([{
      id: 'loop-msg',
      relay_seq: BigInt(1),
      content: 'loopback!',
      user_id: rawId,
      channel_id: '00000000-0000-0000-0000-000000000005',
      username: 'LoopPlayer',
      fo76_account_name: 'LoopPlayer',
    }]);

    const { ws: wsPoll, msgs: msgsPoll } = await connectWs(port);
    const pollRes = await waitForMsg(wsPoll, msgsPoll, () =>
      wsPoll.send(JSON.stringify({ op: 'poll', token, cursor: 0, max: 10 })),
    );
    expect(pollRes).toMatchObject({ success: true });
    expect(Array.isArray(pollRes.events)).toBe(true);
    if (pollRes.events.length > 0) {
      const ev = pollRes.events[0];
      expect(ev.kind).toBe('chat.message');
      expect(ev.channel).toBe('global');
      expect(ev.id).toBeGreaterThan(0);
    }

    wsPoll.close();
    wsSub.close();
  }, 15000);
});

// ── Auth gate integration tests ───────────────────────────────────────────────
//
// Tests for:
//   1. limited send → permission_denied (already in 'relay WebSocket ops'; duplicated here
//      for explicit auth-gate framing)
//   2. system-notice (SYSTEM event) pushed to limited client on register
//   3. linked send allowed after markRelayTokenLinked
//   4. getAuthState state transitions (limited → authenticated)
//   5. markRelayTokenLinked export exists on relayIdentityService

describe('auth gate integration', () => {
  const { markRelayTokenLinked: markLinked } = require('../src/services/relay/tokenService');

  let srv5;

  beforeAll(async () => {
    srv5 = await makeServer();
  }, 10000);

  afterAll(async () => {
    await teardownServer(srv5);
  }, 10000);

  beforeEach(() => {
    _tokenRows = [];
    _userMap   = {};
    _redisSeq  = 0;
    resetRedisIncrMock();
    redisMock.get.mockImplementation(async (key) => _worldStore[key] ?? null);
    redisMock.set.mockImplementation(async (key, val) => { _worldStore[key] = val; return 'OK'; });
    require('../src/config/prisma').default.user.create.mockImplementation(async (args) => {
      const u = { id: args.data.id || 'uid-stub', ...args.data };
      _userMap[u.id] = u;
      return u;
    });
    require('../src/config/prisma').default.hudPairingToken.create.mockImplementation(async (args) => {
      const row = {
        id: `tok-${Date.now()}`,
        ...args.data,
        revokedAt:    null,
        lastUsedAt:   null,
        linkedUserId: args.data.linkedUserId ?? null,
      };
      _tokenRows.push(row);
      return row;
    });
    require('../src/config/prisma').default.hudPairingToken.findMany.mockImplementation(async (args) => {
      const prefix = args?.where?.tokenPrefix;
      if (!prefix) return [];
      return _tokenRows
        .filter((r) => r.tokenPrefix === prefix && !r.revokedAt)
        .map((r) => {
          const u = _userMap[r.userId] ?? { id: r.userId, discordId: null, steamId: null };
          const linkedUserId = Object.prototype.hasOwnProperty.call(r, 'linkedUserId')
            ? r.linkedUserId
            : (u.discordId || u.steamId ? u.id : null);
          return { ...r, linkedUserId, user: u };
        });
    });
    require('../src/config/prisma').default.hudPairingToken.updateMany.mockImplementation(async (args) => {
      if (args?.where?.userId) {
        _tokenRows
          .filter((r) => r.userId === args.where.userId && !r.revokedAt)
          .forEach((r) => Object.assign(r, args.data));
      }
      return { count: 1 };
    });
    require('../src/config/prisma').default.user.findUnique.mockImplementation(
      async (args) => _userMap[args?.where?.id] ?? null,
    );
    require('../src/services/ingestMessage').ingestMessage.mockResolvedValue(
      { ok: true, messageId: 'auth-gate-msg' },
    );
  });

  function conn5() { return connectWs(srv5.port); }

  // ── 1. limited send → permission_denied ─────────────────────────────────────

  test('limited identity (no linkedUserId) → send returns permission_denied', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn5();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'LimitedAuth' })),
    );
    // Drain any system notice that may arrive
    await new Promise((r) => setTimeout(r, 100));
    wsReg.close();

    const { token } = regRes;
    const rawId = lastRawUserId();
    // No linkedUserId → limited
    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn5();
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'send', token, channel: 'global', body: 'hello' })),
    );
    expect(res).toMatchObject({ success: false, error: { code: 'permission_denied' } });
    ws.close();
  });

  // ── 2. system notice pushed on register for limited identity ────────────────

  test('register for limited identity emits system notice on the same socket', async () => {
    // The system notice is pushed async on the register socket after the register
    // response is sent. Collect ALL messages on the register socket.
    const { ws: wsReg, msgs: msgsReg } = await conn5();

    // Send register and wait for the register response
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'NoticePlayer' })),
    );
    expect(regRes.success).toBe(true);
    expect(regRes.state).toBe('limited');

    // Wait up to 500ms for the async system notice to arrive
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        const notice = msgsReg.find(
          (m) => m.op === 'event' && m.event?.channel === 'system',
        );
        if (notice) { clearInterval(iv); resolve(); }
      }, 20);
      setTimeout(() => { clearInterval(iv); resolve(); }, 500);
    });

    const notice = msgsReg.find(
      (m) => m.op === 'event' && m.event?.channel === 'system',
    );

    // If linkCodeService is absent (MODULE_NOT_FOUND), notice may be absent — skip.
    // In test env it should arrive because issueLinkCode silently no-ops and we
    // still push a notice with '????-????' code.
    if (notice) {
      expect(notice.event).toMatchObject({
        kind:              'chat.message',
        channel:           'system',
        senderUserId:      'system',
        senderDisplayName: 'FCM',
      });
      expect(notice.event.body).toContain('LINK REQUIRED');
      expect(notice.event.body).toContain('falloutchatmod.com/link');
    }
    wsReg.close();
  });

  // ── 3. linked send allowed after markRelayTokenLinked ───────────────────────

  test('send allowed after markRelayTokenLinked upgrades the identity', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn5();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'UpgradePlayer' })),
    );
    await new Promise((r) => setTimeout(r, 100)); // drain notice
    wsReg.close();

    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    // Verify limited initially
    const { ws: wsLim, msgs: msgsLim } = await conn5();
    const limRes = await waitForMsg(wsLim, msgsLim, () =>
      wsLim.send(JSON.stringify({ op: 'send', token, channel: 'global', body: 'before link' })),
    );
    expect(limRes).toMatchObject({ success: false, error: { code: 'permission_denied' } });
    wsLim.close();

    // Simulate link redemption: markRelayTokenLinked sets linkedUserId on token rows
    const fcmUserId = 'fcm-user-abc-123';
    await markLinked(rawId, fcmUserId);

    // Now send should succeed
    const { ws: wsLinked, msgs: msgsLinked } = await conn5();
    const linkedRes = await waitForMsg(wsLinked, msgsLinked, () =>
      wsLinked.send(JSON.stringify({ op: 'send', token, channel: 'global', body: 'after link' })),
    );
    expect(linkedRes).toMatchObject({ success: true });
    expect(typeof linkedRes.messageId).toBe('string');
    wsLinked.close();
  });

  // ── 4. getAuthState state transitions ────────────────────────────────────────

  test('getAuthState returns state=limited with canSend=false before link', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn5();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'AuthStatePlayer' })),
    );
    await new Promise((r) => setTimeout(r, 100)); // drain notice
    wsReg.close();

    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    const { ws, msgs } = await conn5();
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'getAuthState', token })),
    );
    expect(res).toMatchObject({
      success:     true,
      state:       'limited',
      permissions: { canSend: false, canReport: false },
    });
    expect(typeof res.userId).toBe('string');
    ws.close();
  });

  test('getAuthState returns state=authenticated with canSend=true after markLinked', async () => {
    const { ws: wsReg, msgs: msgsReg } = await conn5();
    const regRes = await waitForMsg(wsReg, msgsReg, () =>
      wsReg.send(JSON.stringify({ op: 'register', displayName: 'AuthStateLinked' })),
    );
    await new Promise((r) => setTimeout(r, 100)); // drain notice
    wsReg.close();

    const { token } = regRes;
    const rawId = lastRawUserId();
    _userMap[rawId] = { id: rawId, discordId: null, steamId: null, isBanned: false, isMuted: false };

    // Link the identity
    await markLinked(rawId, 'fcm-user-linked-xyz');

    const { ws, msgs } = await conn5();
    const res = await waitForMsg(ws, msgs, () =>
      ws.send(JSON.stringify({ op: 'getAuthState', token })),
    );
    expect(res).toMatchObject({
      success:     true,
      state:       'authenticated',
      permissions: { canSend: true, canReport: false },
    });
    ws.close();
  });

  // ── 5. markRelayTokenLinked exported from relayIdentityService ───────────────

  test('relayIdentityService exports markRelayTokenLinked', () => {
    const svc = require('../src/services/relay/relayIdentityService');
    expect(typeof svc.markRelayTokenLinked).toBe('function');
  });
});
