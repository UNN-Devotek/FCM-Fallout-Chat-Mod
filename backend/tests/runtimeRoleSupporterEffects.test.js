const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let mockDirectory, runtime, prisma, redis, env, cosmetics;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory,
  DISCORD_TOKEN: 'fixture', DISCORD_SERVER_ID: 'fixture-guild', MODERATOR_ROLE_ID: 'fixture-mod', ADMIN_ROLE_ID: 'fixture-admin',
  SUPPORTER_TIER_ENABLED: true, SUPPORTER_ROLE_ID: 'fixture-supporter' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  adminUser: { findMany: jest.fn(), update: jest.fn(), delete: jest.fn(), findUnique: jest.fn() },
  auditLog: { create: jest.fn() }, user: { findUnique: jest.fn() },
  supporterEntitlement: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
} }));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('../src/services/supporterNicknameService', () => ({ refreshSupporterPresentation: jest.fn(async () => true) }));
jest.mock('../src/services/cosmetics/cosmeticsService', () => ({ bustCosmeticsCache: jest.fn(async () => {}) }));
const discordId = '100000000000000001'; const userId = '10000000-0000-0000-0000-000000000001';
const sensitiveError = () => new Error('fixture-secret SQL message content');
const originalFetch = global.fetch;
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-role-effects-'));
  runtime = require('../src/runtime').runtime; prisma = require('../src/config/prisma').default;
  env = require('../src/config/environment').default; cosmetics = require('../src/services/cosmetics/cosmeticsService');
  prisma.adminUser.findMany.mockResolvedValue([{ id: userId, discordId, role: 'admin', username: 'fixture' }]);
  prisma.adminUser.update.mockResolvedValue({}); prisma.adminUser.delete.mockResolvedValue({});
  prisma.auditLog.create.mockResolvedValue({}); prisma.supporterEntitlement.findUnique.mockResolvedValue(null);
  prisma.supporterEntitlement.upsert.mockResolvedValue({}); prisma.supporterEntitlement.update.mockResolvedValue({});
  redis = { get: jest.fn(async () => JSON.stringify({ discordUser: { id: discordId } })), set: jest.fn(async () => 'OK'),
    scan: jest.fn(async () => ({ cursor: '0', keys: ['sess:fixture'] })), del: jest.fn(async () => 1) };
  require('../src/config/redis').getRedisClient.mockResolvedValue(redis);
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ roles: ['fixture-mod'] }) }));
});
afterEach(() => { global.fetch = originalFetch; runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
async function roleCycle() { await runtime.run('fixture:role-cycle', () => require('../src/services/roleVerificationService').runVerificationCycle()); }
async function failed(stage, ids = { discordId }) {
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ ...ids, stage }) }));
  expect(JSON.stringify(result.failures)).not.toContain('fixture-secret SQL message content');
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(result.failures); restarted.disposeForTests();
}
test('an authoritative admin downgrade whose DB write fails remains a required durable effect', async () => {
  prisma.adminUser.update.mockRejectedValueOnce(sensitiveError()); await roleCycle();
  expect(prisma.adminUser.update).toHaveBeenCalled(); await failed('admin-role-update-unconfirmed');
});
test.each(['sessions', 'cache', 'audit', 'delete', 'scan', 'session-read'])('a partially accepted revocation retains the failed %s stage', async stage => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
  const stages = { sessions: 'session-delete-unconfirmed', cache: 'role-cache-delete-unconfirmed', audit: 'revocation-audit-unconfirmed',
    delete: 'admin-delete-unconfirmed', scan: 'session-enumeration-incomplete', 'session-read': 'session-enumeration-incomplete' };
  if (stage === 'sessions') redis.del.mockImplementation(async keys => { if (Array.isArray(keys)) throw sensitiveError(); return 1; });
  if (stage === 'cache') redis.del.mockImplementation(async keys => { if (typeof keys === 'string') throw sensitiveError(); return 1; });
  if (stage === 'audit') prisma.auditLog.create.mockRejectedValueOnce(sensitiveError());
  if (stage === 'delete') prisma.adminUser.delete.mockRejectedValueOnce(sensitiveError());
  if (stage === 'scan') redis.scan.mockRejectedValueOnce(sensitiveError());
  if (stage === 'session-read') redis.get.mockRejectedValueOnce(sensitiveError());
  await roleCycle(); await failed(stages[stage]);
});
test('a transient Discord read or malformed unrelated session is an expected fallback without required failures', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 503 }); await roleCycle();
  expect(prisma.adminUser.update).not.toHaveBeenCalled(); expect(prisma.adminUser.delete).not.toHaveBeenCalled();
  redis.get.mockResolvedValueOnce('not-json');
  await runtime.run('fixture:session-enumeration', () => require('../src/services/roleVerificationService').destroyAdminSessions(discordId));
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
test('an authoritative role-cache set failure is retained without turning an optional cache read into a failure', async () => {
  redis.set.mockRejectedValueOnce(sensitiveError()); await roleCycle(); await failed('role-cache-set-unconfirmed');
});
test.each(['grant', '404-removal'])('live supporter %s cannot hide an unconfirmed authoritative entitlement write', async mode => {
  const service = require('../src/services/supporterSyncService');
  if (mode === 'grant') prisma.supporterEntitlement.upsert.mockRejectedValueOnce(sensitiveError());
  else { prisma.supporterEntitlement.findUnique.mockResolvedValueOnce({ tier: 'supporter', status: 'active' });
    prisma.supporterEntitlement.update.mockRejectedValueOnce(sensitiveError()); }
  await runtime.run('fixture:supporter-refresh', () => service.refreshSupporterFromDiscord({ userId, discordId }, {
    acquireSlot: async () => true, fetchRoles: async () => { if (mode === '404-removal') throw { status: 404 }; return ['fixture-supporter']; },
  }));
  await failed('entitlement-sync-unconfirmed', { userId, discordId });
});
test.each(['tier-cache', 'cosmetics-cache', 'presentation'])('live supporter %s failure remains required after an authoritative result', async stage => {
  const service = require('../src/services/supporterSyncService');
  const deps = { isConfigured: () => true, acquireSlot: async () => true, fetchRoles: async () => ['fixture-supporter'],
    syncRoles: async () => ({ tier: 'supporter', changed: stage !== 'tier-cache' }),
    bustTier: async () => {}, bustCosmetics: async () => {}, refreshPresentation: async () => true };
  if (stage === 'tier-cache') deps.bustTier = async () => { throw sensitiveError(); };
  if (stage === 'cosmetics-cache') deps.bustCosmetics = async () => { throw sensitiveError(); };
  if (stage === 'presentation') deps.refreshPresentation = async () => { throw sensitiveError(); };
  await runtime.run('fixture:supporter-refresh', () => service.refreshSupporterFromDiscord({ userId, discordId }, deps));
  await failed({ 'tier-cache': 'tier-cache-delete-unconfirmed', 'cosmetics-cache': 'cosmetics-cache-delete-unconfirmed',
    presentation: 'presentation-refresh-unconfirmed' }[stage], { userId, discordId });
});
test.each(['tier-cache', 'audit'])('the actual entitlement funnel retains its internally swallowed %s failure', async stage => {
  if (stage === 'tier-cache') redis.del.mockRejectedValueOnce(sensitiveError());
  else prisma.auditLog.create.mockRejectedValueOnce(sensitiveError());
  await runtime.run('fixture:supporter-refresh', () => require('../src/services/supporterSyncService').refreshSupporterFromDiscord({ userId, discordId }, {
    acquireSlot: async () => true, fetchRoles: async () => ['fixture-supporter'],
  }));
  await failed(stage === 'tier-cache' ? 'tier-cache-delete-unconfirmed' : 'entitlement-audit-unconfirmed');
});
test('supporter lookup/member-fetch/cooldown failures and disabled enablement keep their optional fallback semantics', async () => {
  const service = require('../src/services/supporterSyncService');
  await runtime.run('fixture:supporter-refresh', () => service.refreshSupporterFromDiscord({ userId, discordId }, {
    acquireSlot: async () => { throw sensitiveError(); }, fetchRoles: async () => { throw { status: 503 }; },
  }));
  env.SUPPORTER_TIER_ENABLED = false;
  await service.refreshSupporterFromDiscord({ userId, discordId });
  expect(prisma.supporterEntitlement.upsert).not.toHaveBeenCalled();
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});

test('the actual cosmetics cache invalidation cannot swallow its required DEL failure', async () => {
  redis.del.mockRejectedValueOnce(sensitiveError());
  await runtime.run('fixture:cosmetics-invalidation', () => jest.requireActual('../src/services/cosmetics/cosmeticsService').bustCosmeticsCache(userId));
  await failed('cosmetics-cache-delete-unconfirmed', { userId });
});

test('an acknowledged entitlement audit stays accounted until its held DB effect settles', async () => {
  const gate = deferred(); prisma.auditLog.create.mockReturnValueOnce(gate.promise);
  await runtime.run('fixture:supporter-refresh', () => require('../src/services/supporterSyncService').refreshSupporterFromDiscord({ userId, discordId }, {
    acquireSlot: async () => true, fetchRoles: async () => ['fixture-supporter'],
  }));
  const drain = runtime.drain({ timeoutMs: 1000 }); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.reject(sensitiveError()); expect((await drain).phase).toBe('failed'); await failed('entitlement-audit-unconfirmed');
});

test.each(['grant', 'lapse', 'presentation'])('supporter sweep retains an unconfirmed %s effect with the trusted Discord ID', async stage => {
  const service = require('../src/services/supporterSyncService');
  const deps = { fetchMembers: async () => new Map([[discordId, ['fixture-supporter']]]), listEntitlements: async () => [],
    syncRoles: async () => ({ tier: 'supporter', changed: true }), refreshPresentation: async () => true, lapse: async () => true };
  if (stage === 'grant') deps.syncRoles = async () => { throw sensitiveError(); };
  if (stage === 'lapse') { deps.fetchMembers = async () => new Map(); deps.listEntitlements = async () => [{ discordId, status: 'active' }]; deps.lapse = async () => { throw sensitiveError(); }; }
  if (stage === 'presentation') deps.refreshPresentation = async () => { throw sensitiveError(); };
  await runtime.run('fixture:supporter-sweep', () => service.runReconcile(deps).catch(() => {}));
  await failed(stage === 'presentation' ? 'presentation-refresh-unconfirmed' : 'entitlement-sync-unconfirmed');
});
