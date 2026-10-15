const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { createClient } = require('redis');
const { openRecoveryDatabase } = require('./setup/recovery-real-database.cjs');
let mockDatabase, mockRedis, mockRuntime;
jest.mock('../dist/config/prisma', () => ({ __esModule: true, get default() { return mockDatabase; } }));
jest.mock('../dist/config/redis', () => ({ getRedisClient: async () => mockRedis }));
jest.mock('../dist/config/database', () => ({ query: async (sql, args) => ({ rows: await mockDatabase.$queryRawUnsafe(sql, ...(args || [])) }) }));
jest.mock('../dist/runtime', () => ({ get runtime() { return mockRuntime; },
  producerInterval() { throw Error('Unexpected producer in admin-only fixture'); },
  producerTimeout() { throw Error('Unexpected producer in admin-only fixture'); },
}));
// External presentation is outside this local PG/Redis/socket acceptance gate.
jest.mock('../dist/services/discordService', () => ({ relayToDiscord: async () => {}, invalidateRelayMappingsCache() {} }));
jest.mock('../dist/services/cosmetics/cosmeticsService', () => ({ attachCosmetics: async () => {}, attachCosmeticsToHistory: async () => {} }));
jest.mock('../dist/controllers/healthController', () => ({ incrementMessageCount() {} }));
jest.mock('../dist/services/onlinePresenceService', () => ({ registerLocalPresenceSource() {} }));
jest.mock('../dist/services/commandService', () => ({ tryHandleCommand: async () => { throw Error('Unexpected command'); } }));
jest.mock('../dist/services/relay/relayLiveFanout', () => ({ notifyRelayLiveChatMessage: async () => {} }));
jest.mock('../dist/services/privateMessagingService', () => ({}));
jest.mock('../dist/services/messageEditService', () => ({}));
jest.mock('../dist/websocket/bridgeConnection', () => ({}));
jest.mock('../dist/services/relay/localExportBridge', () => ({}));
jest.mock('../dist/websocket/serverModerationConnection', () => ({}));
jest.mock('../dist/websocket/serverModerationAuthorization', () => ({}));
jest.mock('../dist/services/relay/serverModeration', () => ({}));
const { RuntimeCoordinator } = require('../dist/runtime/coordinator');
const { persistMessage } = require('../dist/services/messageService');
const { POST_PUSH_PATCHES } = require('../dist/scripts/applyPostPushPatches');
const patch = POST_PUSH_PATCHES.find(row => row.name === 'messages-source-check').sql;
const migration = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261015070000_allow_web_message_source/migration.sql'), 'utf8');
const sources = ['game', 'discord', 'hud', 'relay', 'mcp', 'ws', 'bot'];
const userId = 'a1000000-0000-4000-8000-000000000001', channelId = 'a1000000-0000-4000-8000-000000000002';
const canonicalId = 'a1000000-0000-4000-8000-000000000003', discordId = '423456789012345678';
let fixture, directory, queue, server, socket; const ownJobs = [], ownTickets = [];
beforeAll(async () => {
  const url = new URL(process.env.REDIS_URL || '');
  if (url.protocol !== 'redis:' || (!['localhost', '127.0.0.1', '[::1]', 'docker'].includes(url.hostname)
    && !/^(?:192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname))) throw Error('Explicit local synthetic Redis required');
  const queueEnvironment = require('../dist/config/environment');
  if (queueEnvironment.REDIS_HOST !== url.hostname || queueEnvironment.REDIS_PORT !== Number(url.port || 6379)) {
    throw Error('Recovery queue fixture requires the same explicit Redis URL and queue endpoint');
  }
  fixture = await openRecoveryDatabase(); mockDatabase = fixture.database;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-recovery-message-')); mockRuntime = new RuntimeCoordinator(directory);
  mockRedis = createClient({ url: url.toString() }); await mockRedis.connect();
}, 20000);
beforeEach(async () => {
  await fixture.reset();
  await mockDatabase.user.create({ data: { id: userId, username: 'SyntheticWebAuthor', installToken: 'task2a-web-author', discordId } });
  await mockDatabase.channel.create({ data: { id: channelId, name: 'Synthetic web channel' } });
});
afterAll(async () => {
  try {
    if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.close(); await closed; }
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (queue) { for (const job of ownJobs) await job.remove(); await queue.pause(true); await queue.close(); }
    if (mockRedis?.isOpen) {
      await mockRedis.del([...ownTickets.map(ticket => `ws_ticket:${ticket}`), `chat_slowmode:v2:discord:${discordId}`, `spam:immunity:${userId}`]);
      await mockRedis.quit();
    }
  } finally {
    mockRuntime?.disposeForTests(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); await fixture?.close();
  }
}, 20000);
async function oldConstraint(extra = []) {
  await fixture.query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_source_check');
  await fixture.query(`ALTER TABLE messages ADD CONSTRAINT messages_source_check CHECK (source = ANY (ARRAY[${[...sources, ...extra].map(source => `'${source}'::text`).join(',')}]))`);
}
test.each([['post-push', patch], ['migration', migration]])('%s upgrades populated legacy constraints twice without changing original identity/time', async (_name, sql) => {
  await oldConstraint();
  const createdAt = '2026-10-13T01:02:03.456Z';
  await mockDatabase.message.create({ data: { id: crypto.randomUUID(), content: 'existing game row', userId, channelId, source: 'game', createdAt: new Date('2026-10-12T01:02:03.123Z') } });
  const original = await mockDatabase.message.findFirst();
  const payload = { id: canonicalId, userId, channelId, source: 'web', content: 'retained canonical SQL-only fixture', createdAt };
  await expect(persistMessage(payload, { retryable: true })).rejects.toThrow('messages_source_check');
  expect(await mockDatabase.message.count()).toBe(1);
  await mockDatabase.$executeRawUnsafe(sql); await mockDatabase.$executeRawUnsafe(sql);
  await persistMessage(payload); await persistMessage(payload);
  for (const source of sources) await persistMessage({ ...payload, id: crypto.randomUUID(), source });
  const rows = await mockDatabase.message.findMany({ where: { id: canonicalId } });
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: canonicalId, source: 'web', content: payload.content });
  expect(rows[0].createdAt.toISOString()).toBe(createdAt);
  expect(await mockDatabase.message.findUnique({ where: { id_createdAt: { id: original.id, createdAt: original.createdAt } } })).toEqual(original);
});
test('a webhook-only substring cannot satisfy the exact web-source guard', async () => {
  await oldConstraint(['webhook']); await mockDatabase.$executeRawUnsafe(patch); await mockDatabase.$executeRawUnsafe(patch);
  await persistMessage({ id: canonicalId, userId, channelId, source: 'web', content: 'exact web literal', createdAt: '2026-10-13T00:00:00.789Z' });
  expect((await mockDatabase.message.findFirst()).source).toBe('web');
});
test('actual authenticated admin WS accepts through Bull and persists its ACK/broadcast canonical UUID and original timestamp', async () => {
  await mockDatabase.$executeRawUnsafe(patch);
  queue = require('../dist/queues/messagePersist'); await queue.isReady();
  const { handleConnection } = require('../dist/websocket/handlers');
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (ws, req) => { handleConnection(ws, req).then(readyResolve); }); await once(server, 'listening');
  // The same single-use server-owned ticket shape minted after dashboard auth.
  // The final application-image gate additionally covers the HTTP ticket issuer.
  const ticket = crypto.randomUUID(); ownTickets.push(ticket);
  await mockRedis.set(`ws_ticket:${ticket}`, JSON.stringify({ type: 'admin', discordId, username: 'SyntheticWebAuthor', role: 'admin' }), { EX: 60 });
  const port = server.address().port; socket = new WebSocket(`ws://127.0.0.1:${port}/?ticket=${ticket}`);
  const frames = []; socket.on('message', data => frames.push(JSON.parse(data.toString()))); await once(socket, 'open'); await ready;
  const completed = new Promise((resolve, reject) => {
    queue.once('completed', job => { ownJobs.push(job); resolve(job); });
    queue.once('failed', (_job, error) => reject(error));
  });
  const ack = new Promise((resolve, reject) => {
    const read = data => { const frame = JSON.parse(data.toString());
      if (frame.type === 'message:ack') { socket.off('message', read); resolve(frame.payload); }
      if (frame.type === 'error') { socket.off('message', read); reject(new Error('Admin WS refused synthetic acceptance')); }
    }; socket.on('message', read);
  });
  socket.send(JSON.stringify({ type: 'chat:send', payload: { channelId, content: 'authenticated synthetic web publication' } }));
  const [receipt, job] = await Promise.all([ack, completed]);
  const broadcast = frames.find(frame => frame.type === 'chat:message').payload;
  expect(receipt.messageId).toBe(broadcast.id); expect(job.data.id).toBe(receipt.messageId);
  expect(job.data.createdAt).toBe(broadcast.timestamp); expect(job.opts.removeOnFail).toBe(false);
  expect(await mockRedis.get(`ws_ticket:${ticket}`)).toBeNull();
  const rows = await mockDatabase.message.findMany({ where: { id: receipt.messageId } });
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ source: 'web', userId, channelId, content: job.data.content });
  expect(rows[0].createdAt.toISOString()).toBe(job.data.createdAt);
  const closed = once(socket, 'close'); socket.close(); await closed;
  // Reusing a consumed ticket goes through actual WS authentication and fails.
  const replay = new WebSocket(`ws://127.0.0.1:${port}/?ticket=${ticket}`); const [code] = await once(replay, 'close'); expect(code).toBe(4001);
}, 20000);
