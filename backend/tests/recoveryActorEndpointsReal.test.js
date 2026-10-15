const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const express = require('express'), session = require('express-session'), request = require('supertest');
const { createClient } = require('redis');
const { openRecoveryDatabase } = require('./setup/recovery-real-database.cjs');
let mockDatabase, mockRedis, mockRuntime;
jest.mock('../dist/config/prisma', () => ({ __esModule: true, get default() { return mockDatabase; } }));
jest.mock('../dist/config/redis', () => ({ getRedisClient: async () => mockRedis }));
jest.mock('../dist/config/database', () => ({ query: async (sql, args) => ({ rows: await mockDatabase.$queryRawUnsafe(sql, ...args) }) }));
jest.mock('../dist/runtime', () => ({ get runtime() { return mockRuntime; } }));
jest.mock('../dist/websocket/handlers', () => ({ refreshClientIdentity() {}, resolveDisplayName: user => user.username }));
jest.mock('../dist/services/discordService', () => ({ relayToDiscord: jest.fn(async () => {}), invalidateModLogCache() {} }));
jest.mock('../dist/services/voiceService', () => ({ invalidateVoiceCache() {} }));
jest.mock('../dist/services/supporterSyncService', () => ({ refreshSupporterFromDiscord: async () => {} }));
jest.mock('../dist/services/chatNameService', () => ({ setChatName: async () => {} }));
jest.mock('../dist/services/reactionRoleService', () => ({}));
jest.mock('../dist/services/discordEmbedService', () => ({}));
jest.mock('../dist/services/discordContextService', () => ({}));
const { RuntimeCoordinator } = require('../dist/runtime/coordinator');
const { accountHttpIngress, instrumentHttpHandlers } = require('../dist/runtime/ingress');
const env = require('../dist/config/environment');
// Synthetic session/config only. Real auth and role middleware still decide admission.
Object.assign(env, { OWNER_ROLE_ID: 'owner', ADMIN_ROLE_ID: 'admin', MODERATOR_ROLE_ID: 'moderator', ADMIN_API_KEY: 'task2a-synthetic-api-key' });
const { requireDiscordRole } = require('../dist/middleware/auth');
const { errorHandler } = require('../dist/middleware/errorHandler');
const users = require('../dist/controllers/usersController'), channels = require('../dist/controllers/channelsController');
const messages = require('../dist/controllers/messagesController'), moderation = require('../dist/controllers/moderationController');
const rules = require('../dist/controllers/autoModRulesController');
const { validate, schemas } = require('../dist/middleware/validation');
const actorId = 'abcdefab-cdef-4abc-8def-abcdefabcdef', targetId = '20000000-0000-4000-8000-000000000002';
const channelId = '30000000-0000-4000-8000-000000000003', messageId = '40000000-0000-4000-8000-000000000004';
const ruleId = '50000000-0000-4000-8000-000000000005', discordId = '123456789012345678';
let fixture, directory, app, observedStatus, starting;
const callers = {
  linked: { id: discordId, role: 'owner', roles: ['owner'] }, internal: { id: actorId, role: 'owner', roles: ['owner'] },
  unlinked: { id: '223456789012345678', role: 'owner', roles: ['owner'] },
  missing: { id: '90000000-0000-4000-8000-000000000009', role: 'owner', roles: ['owner'] },
  invalid: { id: {}, role: 'owner', roles: ['owner'] }, dweller: { id: discordId, role: 'user', roles: ['user'] },
};
function mount() {
  app = express(); app.use(accountHttpIngress(mockRuntime)); app.use(express.json());
  app.use(session({ secret: 'task2a-only-synthetic-session-secret', resave: false, saveUninitialized: false }));
  app.post('/fixture-session/:caller', (req, res) => { req.session.discordUser = callers[req.params.caller]; res.json({ ok: true }); });
  app.use('/api/channels', require('../dist/routes/channels'));
  app.use('/api/messages', require('../dist/routes/messages'));
  const moderator = requireDiscordRole('moderator'), admin = requireDiscordRole('admin'), owner = requireDiscordRole('owner');
  app.post('/api/users/:id/mute', moderator, validate(schemas.muteUser), users.muteUser);
  app.delete('/api/users/:id/mute', moderator, users.unmuteUser); app.post('/api/users/:id/kick', moderator, users.kickUser);
  app.post('/api/users/:id/ban', admin, validate(schemas.banUser), users.banUser); app.delete('/api/users/:id/ban', owner, users.unbanUser);
  app.post('/api/users/:id/wipe', owner, users.wipeUser); app.delete('/api/users/:id', owner, users.deleteUser);
  app.put('/api/moderation/voice-settings', admin, moderation.updateVoiceSettings);
  app.patch('/api/moderation/settings', admin, moderation.updateSettings);
  app.patch('/api/moderation/word-filters/:id', moderator, moderation.updateWordFilter);
  app.post('/api/moderation/word-filters/bulk', admin, require('multer')().single('file'), moderation.bulkImportWordFilters);
  app.post('/api/moderation/automod-rules', admin, rules.createAutoModRule);
  app.put('/api/moderation/automod-rules/:id', admin, rules.updateAutoModRule);
  app.delete('/api/moderation/automod-rules/:id', admin, rules.deleteAutoModRule);
  app.patch('/api/moderation/automod-rules/:id/toggle', moderator, rules.toggleAutoModRule);
  app.use((error, req, res, next) => { observedStatus = error.code; errorHandler(error, req, res, next); });
  instrumentHttpHandlers(app, mockRuntime);
}
async function client(caller = 'linked') {
  const agent = request.agent(app); await agent.post('/fixture-session/' + caller).expect(200); return agent;
}
async function assertAudit(action, target, expectedActor = actorId) {
  const rows = await mockDatabase.auditLog.findMany({ where: { action } }); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: expectedActor, targetId: target });
  const end = (await fixture.query('SELECT clock_timestamp() AS now')).rows[0].now;
  expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(starting.getTime());
  expect(rows[0].createdAt.getTime()).toBeLessThanOrEqual(end.getTime()); return rows[0];
}
beforeAll(async () => {
  fixture = await openRecoveryDatabase(); mockDatabase = fixture.database;
  // Only the explicit local fixture Redis configured by required backend CI.
  const redisUrl = new URL(process.env.REDIS_URL || '');
  if (redisUrl.protocol !== 'redis:' || !['localhost', '127.0.0.1', '[::1]', 'docker'].includes(redisUrl.hostname) && !/^(?:192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(redisUrl.hostname)) throw Error('Explicit local synthetic Redis required');
  mockRedis = createClient({ url: redisUrl.toString() }); await mockRedis.connect();
}, 20000);
beforeEach(async () => {
  await fixture.reset(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-recovery-actors-')); mockRuntime = new RuntimeCoordinator(directory);
  await mockDatabase.user.createMany({ data: [
    { id: actorId, username: 'SyntheticModerator', installToken: 'task2a-actor', discordId },
    { id: targetId, username: 'SyntheticTarget', installToken: 'task2a-target' },
  ] });
  await mockDatabase.channel.create({ data: { id: channelId, name: 'Synthetic channel' } });
  await mockDatabase.message.create({ data: { id: messageId, userId: targetId, channelId, content: 'synthetic original', source: 'game' } });
  await mockDatabase.autoModRule.create({ data: { id: ruleId, name: 'Synthetic rule', triggerType: 'KEYWORD', triggerMetadata: {}, actions: [] } });
  await mockDatabase.moderationSetting.create({ data: { key: 'spam_message_limit', value: '5' } });
  await mockDatabase.wordFilter.create({ data: { phrase: 'synthetic phrase' } });
  starting = (await fixture.query('SELECT clock_timestamp() AS now')).rows[0].now; observedStatus = undefined; mount();
});
afterEach(async () => {
  jest.restoreAllMocks(); mockRuntime?.disposeForTests(); if (directory) fs.rmSync(directory, { recursive: true, force: true });
  // Unmute sets only this known synthetic user's immunity key.
  if (mockRedis?.isOpen) await mockRedis.del(`spam:immunity:${targetId}`);
});
afterAll(async () => { try { if (mockRedis?.isOpen) await mockRedis.quit(); } finally { await fixture?.close(); } });

test.each(['linked', 'internal', 'unlinked', 'api-key'])('authenticated %s channel creation writes a real FK-safe audit row', async caller => {
  const agent = caller === 'api-key' ? request(app) : await client(caller);
  const response = await agent.post('/api/channels').set(caller === 'api-key' ? { 'x-api-key': env.ADMIN_API_KEY } : {}).send({ name: 'Created synthetic channel' }).expect(201);
  await assertAudit('create_channel', response.body.data.id, ['api-key', 'unlinked'].includes(caller) ? null : actorId);
});
test.each(['missing', 'invalid'])('%s identity cannot mutate a primary row', async caller => {
  await (await client(caller)).post('/api/channels').send({ name: 'Must never exist' }).expect(503);
  expect(observedStatus).toBe(caller === 'missing' ? 'ACTOR_INTERNAL_USER_MISSING' : 'ACTOR_IDENTITY_INVALID');
  expect(await mockDatabase.channel.count()).toBe(1); expect(await mockDatabase.auditLog.count()).toBe(0);
});
test('actor lookup outage occurs before primary mutation despite the existing auth fallback', async () => {
  const agent = await client(); jest.spyOn(mockDatabase.user, 'findFirst').mockRejectedValue(new Error('synthetic lookup outage'));
  await agent.post('/api/channels').send({ name: 'Must never exist' }).expect(503);
  expect(observedStatus).toBe('ACTOR_LOOKUP_UNAVAILABLE'); expect(await mockDatabase.channel.count()).toBe(1);
  expect(await mockDatabase.auditLog.count()).toBe(0);
});
test('an actual PostgreSQL actor-query failure cannot become a nullable successful mutation', async () => {
  const agent = await client(); await fixture.query('ALTER TABLE users RENAME TO users_lookup_unavailable');
  try {
    await agent.post('/api/channels').send({ name: 'Must never exist' }).expect(503);
    expect(observedStatus).toBe('ACTOR_LOOKUP_UNAVAILABLE'); expect(await mockDatabase.channel.count()).toBe(1);
    expect(await mockDatabase.auditLog.count()).toBe(0);
  } finally { await fixture.query('ALTER TABLE users_lookup_unavailable RENAME TO users'); }
});
test('the actual fixture FK refuses a nonexistent internal audit actor', async () => {
  await expect(mockDatabase.auditLog.create({ data: { actorId: callers.missing.id, action: 'synthetic_fk_control', targetId, targetType: 'user' } }))
    .rejects.toMatchObject({ code: 'P2003' });
  expect(await mockDatabase.auditLog.count()).toBe(0);
});
const actions = [
  ['archive_channel', 'delete', () => `/api/channels/${channelId}`, {}, channelId],
  ['delete_channel', 'delete', () => `/api/channels/${channelId}/permanent`, {}, channelId],
  ['scrub_messages', 'post', () => '/api/messages/scrub', { messageIds: [messageId] }, null],
  ['delete_message', 'delete', () => `/api/messages/${messageId}`, {}, messageId],
  ['mute', 'post', () => `/api/users/${targetId}/mute`, { duration: 5, reason: 'Synthetic reason' }, targetId],
  ['unmute', 'delete', () => `/api/users/${targetId}/mute`, {}, targetId],
  ['kick', 'post', () => `/api/users/${targetId}/kick`, {}, targetId],
  ['ban', 'post', () => `/api/users/${targetId}/ban`, { reason: 'Synthetic reason' }, targetId],
  ['unban', 'delete', () => `/api/users/${targetId}/ban`, {}, targetId],
  ['wipe', 'post', () => `/api/users/${targetId}/wipe`, {}, targetId],
  ['user_deleted', 'delete', () => `/api/users/${targetId}`, {}, targetId],
  ['update_voice_settings', 'put', () => '/api/moderation/voice-settings', { enabled: false }, null],
  ['update_setting', 'patch', () => '/api/moderation/settings', { key: 'spam_message_limit', value: '6' }, null],
  ['update_setting', 'patch', () => '/api/moderation/settings', { key: 'ai_moderation_enabled', value: 'false' }, null],
  ['update_setting', 'patch', () => '/api/moderation/settings', { key: 'mod_log_channel_id', value: '323456789012345678' }, null],
  ['automod_rule_update', 'put', () => `/api/moderation/automod-rules/${ruleId}`, { name: 'Changed synthetic rule' }, ruleId],
  ['automod_rule_delete', 'delete', () => `/api/moderation/automod-rules/${ruleId}`, {}, ruleId],
  ['automod_rule_enable', 'patch', () => `/api/moderation/automod-rules/${ruleId}/toggle`, { enabled: true }, ruleId],
];
test.each(actions)('real authenticated %s audit has the intended target and original database time', async (action, method, url, body, target) => {
  await (await client())[method](url()).send(body).expect(200); await assertAudit(action, target);
});
test.each([
  ...actions,
  ['create_channel', 'post', () => '/api/channels', { name: 'Unconfirmed actor' }, null],
  ['automod_rule_create', 'post', () => '/api/moderation/automod-rules', { name: 'Unconfirmed actor', triggerType: 'KEYWORD', triggerMetadata: {}, actions: [{ type: 'BLOCK' }] }, null],
])('%s lookup outage preserves every primary row and audit before returning an attribution error', async (_action, method, url, body) => {
  const snapshot = () => Promise.all(['user', 'channel', 'message', 'autoModRule', 'moderationSetting', 'session', 'report', 'wordFilter', 'auditLog']
    .map(model => mockDatabase[model].findMany()));
  const agent = await client(); const before = await snapshot();
  jest.spyOn(mockDatabase.user, 'findFirst').mockRejectedValue(new Error('synthetic attribution outage'));
  await agent[method](url()).send(body).expect(503); expect(observedStatus).toBe('ACTOR_LOOKUP_UNAVAILABLE');
  expect(await snapshot()).toEqual(before);
});
test('AutoMod create records the rule target rather than the actor UUID', async () => {
  const response = await (await client()).post('/api/moderation/automod-rules').send({ name: 'Created rule', triggerType: 'KEYWORD', triggerMetadata: {}, actions: [{ type: 'BLOCK' }] }).expect(201);
  await assertAudit('automod_rule_create', response.body.data.id);
});
test('word filter edit and multipart bulk import use real SQL and audit rows', async () => {
  const filter = await mockDatabase.wordFilter.findFirst(); const agent = await client();
  await agent.patch(`/api/moderation/word-filters/${filter.id}`).send({ testMode: true }).expect(200);
  await assertAudit('edit_word_filter', null);
  await agent.post('/api/moderation/word-filters/bulk').attach('file', Buffer.from('second synthetic phrase'), 'phrases.txt').expect(200);
  await assertAudit('bulk_import_word_filter', null); expect(await mockDatabase.wordFilter.count()).toBe(2);
});
test.each([
  ['lowercase', actorId], ['uppercase', actorId.toUpperCase()], ['mixed', 'aBcDeFaB-cDeF-4aBc-8DeF-aBcDeFaBcDeF'],
])('%s self-deletion purges canonical Redis sessions and retains a nullable audit with a clean drain', async (_spelling, target) => {
  const token = crypto.randomUUID(), otherToken = crypto.randomUUID();
  const sessionKey = `session:${token}`, otherSessionKey = `session:${otherToken}`;
  await mockDatabase.session.createMany({ data: [
    { token, userId: actorId, expiresAt: new Date(Date.now() + 60000) },
    { token: otherToken, userId: targetId, expiresAt: new Date(Date.now() + 60000) },
  ] });
  await mockRedis.set(sessionKey, actorId, { EX: 60 }); await mockRedis.set(otherSessionKey, targetId, { EX: 60 });
  try {
    const response = await (await client()).delete(`/api/users/${target}`).expect(200);
    expect(response.body.data).toEqual({ deleted: true, id: target, username: 'SyntheticModerator' });
    expect(await mockDatabase.user.findUnique({ where: { id: actorId } })).toBeNull();
    expect(await mockDatabase.session.count({ where: { userId: actorId } })).toBe(0);
    expect(await mockRedis.get(sessionKey)).toBeNull();
    expect(await mockDatabase.session.count({ where: { userId: targetId } })).toBe(1);
    expect(await mockRedis.get(otherSessionKey)).toBe(targetId);
    const row = await assertAudit('user_deleted', actorId, null); expect(row.metadata.deletedActorId).toBe(actorId);
    const drain = await mockRuntime.drain({ timeoutMs: 2000 });
    expect(drain.phase).toBe('drained'); expect(drain.failures).toEqual([]);
  } finally { await mockRedis.del([sessionKey, otherSessionKey]); }
});
test('required self-deletion audit refusal remains sticky after successful canonical session cleanup', async () => {
  const token = crypto.randomUUID(), sessionKey = `session:${token}`;
  await mockDatabase.session.create({ data: { token, userId: actorId, expiresAt: new Date(Date.now() + 60000) } });
  await mockRedis.set(sessionKey, actorId, { EX: 60 });
  await fixture.query("ALTER TABLE audit_logs ADD CONSTRAINT task2a_reject_self_audit CHECK (action <> 'user_deleted')");
  try {
    await (await client()).delete(`/api/users/${actorId.toUpperCase()}`).expect(200);
    expect(await mockDatabase.user.findUnique({ where: { id: actorId } })).toBeNull();
    expect(await mockDatabase.session.count({ where: { userId: actorId } })).toBe(0);
    expect(await mockRedis.get(sessionKey)).toBeNull(); expect(await mockDatabase.auditLog.count()).toBe(0);
    const drain = await mockRuntime.drain({ timeoutMs: 2000 });
    expect(drain.phase).toBe('failed'); expect(drain.failures).toContainEqual(expect.objectContaining({ label: 'audit:write' }));
  } finally {
    await mockRedis.del(sessionKey); await fixture.query('ALTER TABLE audit_logs DROP CONSTRAINT task2a_reject_self_audit');
  }
});
test('an actual PostgreSQL post-primary audit refusal retains required failure before HTTP error handling', async () => {
  await fixture.query(`ALTER TABLE audit_logs ADD CONSTRAINT task2a_reject_audit CHECK (action <> 'create_channel')`);
  try {
    await (await client()).post('/api/channels').send({ name: 'Committed before refused audit' }).expect(500);
    expect(await mockDatabase.channel.count()).toBe(2); expect(await mockDatabase.auditLog.count()).toBe(0);
    const result = await mockRuntime.drain({ timeoutMs: 2000 }); expect(result.phase).toBe('failed'); expect(result.failures.length).toBeGreaterThan(0);
  } finally { await fixture.query('ALTER TABLE audit_logs DROP CONSTRAINT task2a_reject_audit'); }
});
test('zero-row scrub still requires its real audit and fails drain on an actual SQL refusal', async () => {
  await fixture.query(`ALTER TABLE audit_logs ADD CONSTRAINT task2a_reject_audit CHECK (action <> 'scrub_messages')`);
  try {
    await (await client()).post('/api/messages/scrub').send({ messageIds: [crypto.randomUUID()] }).expect(500);
    expect((await mockDatabase.message.findFirst()).content).toBe('synthetic original');
    expect((await mockRuntime.drain({ timeoutMs: 2000 })).phase).toBe('failed');
  } finally { await fixture.query('ALTER TABLE audit_logs DROP CONSTRAINT task2a_reject_audit'); }
});
test('availability-preserving AutoMod catch retains a failed real audit after the primary change', async () => {
  await fixture.query(`ALTER TABLE audit_logs ADD CONSTRAINT task2a_reject_audit CHECK (action <> 'automod_rule_enable')`);
  try {
    await (await client()).patch(`/api/moderation/automod-rules/${ruleId}/toggle`).send({ enabled: true }).expect(200);
    expect((await mockDatabase.autoModRule.findUnique({ where: { id: ruleId } })).enabled).toBe(true);
    expect((await mockRuntime.drain({ timeoutMs: 2000 })).phase).toBe('failed');
  } finally { await fixture.query('ALTER TABLE audit_logs DROP CONSTRAINT task2a_reject_audit'); }
});
test('anonymous, insufficient-role and public read paths preserve admission and REST live-only publication', async () => {
  await request(app).post('/api/channels').send({ name: 'No anonymous write' }).expect(401);
  await (await client('dweller')).post('/api/channels').send({ name: 'No dweller write' }).expect(403);
  const response = await (await client()).post('/api/messages').send({ content: 'live-only synthetic publication', channelId }).expect(201);
  expect(response.body.data.id).toMatch(/^[0-9a-f-]{36}$/); expect(await mockDatabase.message.count()).toBe(1);
  expect(await mockDatabase.auditLog.count()).toBe(0);
  await request(app).get(`/api/messages/public?channelId=${channelId}`).expect(200);
});
