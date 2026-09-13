const store = new Map(), scores = new Map();
const redis = {
  get: jest.fn(async key => store.get(key) ?? null), set: jest.fn(async (key, value) => store.set(key, value)),
  del: jest.fn(async key => store.delete(key)), expire: jest.fn(async () => true),
  zRemRangeByScore: jest.fn(async () => 0),
  zAdd: jest.fn(async (key, item) => { const list = scores.get(key) ?? new Map(); list.set(item.value, item.score); scores.set(key, list); }),
  zRangeByScore: jest.fn(async (key, minimum) => [...(scores.get(key) ?? [])].filter(([, score]) => score >= minimum).map(([id]) => id)),
};
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
const prisma = { hudPairingToken: { findFirst: jest.fn() }, user: { findUnique: jest.fn() } };
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prisma }));
jest.mock('../src/services/relay/worldRosterService', () => ({ readRoster: jest.fn() }));
jest.mock('../src/services/relay/worldIdService', () => ({ getWorldId: jest.fn() }));
const { readRoster } = require('../src/services/relay/worldRosterService');
const { getWorldId } = require('../src/services/relay/worldIdService');
const { renewBridgeLease, clearBridgeLease, resolveOverlayBridge, BRIDGE_LEASE_MS } = require('../src/services/relay/overlayServerBridge');
beforeEach(() => {
  jest.clearAllMocks(); store.clear(); scores.clear();
  jest.spyOn(Date, 'now').mockReturnValue(100_000);
  readRoster.mockResolvedValue({ requestId: 'nonce' }); getWorldId.mockResolvedValue('r:one');
  prisma.hudPairingToken.findFirst.mockResolvedValue({ fo76Name: 'Alice' });
  prisma.user.findUnique.mockResolvedValue({ isBanned: false, kickedUntil: null });
});
afterEach(() => jest.restoreAllMocks());
test('no bridge means no account/token database poll', async () => {
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
  expect(prisma.hudPairingToken.findFirst).not.toHaveBeenCalled();
});
test('fresh nonce creates an account-scoped bridge without exposing credentials', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce');
  expect(await resolveOverlayBridge('a')).toMatchObject({ status: 'ready', binding: { accountId: 'a', relayUserId: 'user_a', room: 'r:one' } });
  expect(prisma.hudPairingToken.findFirst).toHaveBeenCalledWith({ where: { userId: 'user_a', linkedUserId: 'a', revokedAt: null }, select: { fo76Name: true } });
  expect(await resolveOverlayBridge('b')).toEqual({ status: 'inactive' });
});
test('expired independent heartbeat cannot be kept alive by a peer room refresh', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce'); Date.now.mockReturnValue(100_000 + BRIDGE_LEASE_MS);
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
test('expiry during a slow account lookup is checked before returning a binding', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce');
  prisma.user.findUnique.mockImplementationOnce(async () => {
    Date.now.mockReturnValue(100_000 + BRIDGE_LEASE_MS);
    return { isBanned: false };
  });
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
test('stale ROSTER nonce cannot renew a new lease', async () => {
  await renewBridgeLease('a', 'user_a', 'old'); expect(store.size).toBe(0);
});
test('nonce changes and explicit LEAVE invalidate immediately', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce'); readRoster.mockResolvedValue({ requestId: 'new' });
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
  readRoster.mockResolvedValue({ requestId: 'nonce' }); await clearBridgeLease('user_a');
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
test('two live devices are ambiguous even if they share a room', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce'); await renewBridgeLease('a', 'user_b', 'nonce');
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'ambiguous' });
});
test('revocation or relinking cannot inherit the previous account room', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce'); prisma.hudPairingToken.findFirst.mockResolvedValue(null);
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
test.each([null, { isBanned: true }, { kickedUntil: new Date(200_000) }])('unavailable account is denied', async user => {
  await renewBridgeLease('a', 'user_a', 'nonce'); prisma.user.findUnique.mockResolvedValue(user);
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
test('a raw legacy WORLD value never grants background access', async () => {
  await renewBridgeLease('a', 'user_a', 'nonce'); getWorldId.mockResolvedValue('claimed-world-id');
  expect(await resolveOverlayBridge('a')).toEqual({ status: 'inactive' });
});
