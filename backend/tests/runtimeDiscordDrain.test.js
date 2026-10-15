const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
let mockDirectory, mockClient, mockSend, mockLink, mockEdit, runtime, service;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test',
  DISCORD_TOKEN: 'synthetic-fixture-token', DISCORD_SERVER_ID: 'fixture-guild', DISCORD_CHANNEL_ID: 'discord-channel',
  FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('discord.js', () => ({ ...jest.requireActual('discord.js'), Client: jest.fn(() => mockClient) }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  channel: { findMany: jest.fn(async () => [{ id: 'game-channel', discordChannelId: 'discord-channel' }]) },
  discordRelayMapping: { findMany: jest.fn(async () => []) }, user: { findMany: jest.fn(async () => []) },
  discordMessageLink: { upsert: (...args) => mockLink(...args), findUnique: jest.fn(async () => ({ messageId: 'canonical-id', isBotMessage: false })) },
  message: { findFirst: jest.fn(async () => ({ userId: 'fixture-user', channelId: 'game-channel' })) },
  $executeRaw: (...args) => mockEdit(...args),
} }));
jest.mock('../src/services/autoModEngine', () => ({ engineEvaluate: jest.fn(async () => ({ block: false })) }));
jest.mock('../src/queues/messagePersist', () => ({ add: jest.fn() }));
jest.mock('../src/services/onlinePresenceService', () => ({ getGlobalOnlineCount: jest.fn(async () => 1), noteDiscordMessageActivity: jest.fn() }));
jest.mock('../src/services/voiceService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/reactionRoleService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/ticketService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/supporterSyncService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/cosmeticsCommandService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/chatNameCommandService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/discordOverlayCommandService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/discordCommandHelpService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/discordEventService', () => ({ register: jest.fn() }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  jest.resetModules(); jest.useFakeTimers();
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-discord-drain-'));
  mockSend = jest.fn(async () => ({ id: 'discord-sent-id' })); mockLink = jest.fn(async () => ({}));
  mockEdit = jest.fn(async () => 1);
  const channel = { id: 'discord-channel', isTextBased: () => true, send: (...args) => mockSend(...args) };
  mockClient = new EventEmitter(); mockClient.channels = { fetch: jest.fn(async () => channel) };
  mockClient.rest = { request: jest.fn(async () => undefined) }; mockClient.guilds = { cache: { first: () => undefined } };
  mockClient.user = { id: 'fixture-bot', tag: 'fixture', setPresence: jest.fn() };
  mockClient.login = jest.fn(async () => { mockClient.emit('ready'); return 'logged-in'; }); mockClient.destroy = jest.fn();
});
afterEach(() => { runtime?.disposeForTests(); runtime = undefined; jest.clearAllTimers(); jest.useRealTimers(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
async function load(start = true) {
  service = require('../src/services/discordService'); runtime = require('../src/runtime').runtime;
  if (start) { await service.start(); await jest.advanceTimersByTimeAsync(0); }
}
const relay = () => service.relayToDiscord('game-channel', 'Fixture', 'accepted message', 'General', undefined, undefined, 'canonical-id');

test('the queue shifting to empty still reports the send and link as in-flight accepted work', async () => {
  await load(); const gate = deferred(); mockSend.mockImplementationOnce(() => gate.promise);
  const accepted = relay(); await jest.advanceTimersByTimeAsync(250);
  expect(mockSend).toHaveBeenCalledTimes(1); runtime.freeze('cutover');
  const drain = runtime.drain({ timeoutMs: 1000 }); await jest.advanceTimersByTimeAsync(25);
  const inspection = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants['discord-outbound'];
  expect(inspection.detail).toEqual({ queued: 0, inFlight: 1 }); expect(inspection.pending).toBe(1);
  gate.resolve({ id: 'discord-sent-id' }); await accepted; await jest.advanceTimersByTimeAsync(25);
  expect((await drain).phase).toBe('drained');
  expect(mockLink).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ messageId: 'canonical-id', discordMessageId: 'discord-sent-id' }) }));
});

test('send success followed by failed link persistence rejects and retains both IDs without retrying the send', async () => {
  await load(); mockLink.mockRejectedValueOnce(new Error('link database unavailable'));
  const failure = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250);
  expect((await failure).message).toBe('link database unavailable'); expect(mockSend).toHaveBeenCalledTimes(1);
  const result = await runtime.drain({ timeoutMs: 1000, close: true });
  expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
    messageId: 'canonical-id', discordMessageId: 'discord-sent-id', stage: 'send-succeeded-link-unconfirmed' }) }));
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); restarted.disposeForTests();
});

test('a nested catch cannot hide a failed Discord REST mutation from the drain', async () => {
  // Wrap the real request before start so feature services all share that layer.
  mockClient.rest.request = jest.fn(async () => { throw new Error('Discord response uncertain'); });
  await load();
  await mockClient.rest.request({ method: 'POST', fullRoute: '/channels/fixture/messages' }).catch(() => {});
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(runtime.snapshot().failures).toContainEqual(expect.objectContaining({ label: 'discord-rest:POST' }));
});

test('a logged Discord edit DB failure retains canonical and external IDs and fences the next process', async () => {
  await load(); mockEdit.mockRejectedValueOnce(new Error('edit database unavailable'));
  mockClient.emit('messageUpdate', {}, { id: 'discord-edited-id', channelId: 'discord-channel', content: 'accepted edit', author: { bot: false } });
  await jest.advanceTimersByTimeAsync(0);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(runtime.snapshot().failures).toContainEqual(expect.objectContaining({
    label: 'discord:inbound-edit', evidence: expect.objectContaining({ canonicalId: 'canonical-id',
      discordMessageId: 'discord-edited-id', discordChannelId: 'discord-channel', stage: 'discord-edit-observed-local-update-unconfirmed' }) }));
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures[0].evidence.discordMessageId).toBe('discord-edited-id');
  restarted.disposeForTests();
});

test('a frozen boot suppresses Discord login and new relay producers get retriable refusal', async () => {
  fs.writeFileSync(path.join(mockDirectory, 'maintenance.json'), '{}'); await load();
  expect(require('discord.js').Client).not.toHaveBeenCalled(); expect(mockClient.login).not.toHaveBeenCalled();
  await expect(relay()).rejects.toThrow('Maintenance'); expect(mockSend).not.toHaveBeenCalled();
});

test.each([
  '/interactions/100000000000000001/synthetic-private-interaction-token/callback?with_response=true',
  '/webhooks/100000000000000002/synthetic-private-webhook-token/messages/@original?wait=true',
])('Discord SDK token-bearing route %s is templated before journaling', async fullRoute => {
  mockClient.rest.request = jest.fn(async () => { throw new Error('synthetic-private-response-body'); });
  await load(); await mockClient.rest.request({ method: 'POST', fullRoute }).catch(() => {});
  const snapshot = runtime.snapshot(); expect(JSON.stringify(snapshot)).not.toContain('synthetic-private');
  expect(snapshot.failures[0].evidence.routeTemplate).toContain(':token'); expect(JSON.stringify(snapshot)).not.toContain('?');
});
