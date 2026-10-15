const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
let mockDirectory, mockClient, mockSend, mockLink, mockEdit, mockSavedLink, runtime, service;
const canonicalId = 'a2000000-0000-4000-8000-000000000001';
const createdAt = '2026-10-13T01:02:03.456Z';
const sentId = '100000000000000002';
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test',
  DISCORD_TOKEN: 'synthetic-fixture-token', DISCORD_SERVER_ID: 'fixture-guild', DISCORD_CHANNEL_ID: '100000000000000001',
  FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('discord.js', () => ({ ...jest.requireActual('discord.js'), Client: jest.fn(() => mockClient) }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  channel: { findMany: jest.fn(async () => [{ id: 'game-channel', discordChannelId: '100000000000000001' }]) },
  discordRelayMapping: { findMany: jest.fn(async () => []) }, user: { findMany: jest.fn(async () => []) },
  discordMessageLink: { upsert: (...args) => mockLink(...args), findUnique: jest.fn(async () => mockSavedLink) },
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
  mockSend = jest.fn(async () => ({ id: sentId }));
  mockSavedLink = null;
  mockLink = jest.fn(async ({ create }) => { mockSavedLink = create; return create; });
  mockEdit = jest.fn(async () => 1);
  const channel = { id: '100000000000000001', isTextBased: () => true, send: (...args) => mockSend(...args) };
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
const relay = () => service.relayToDiscord('game-channel', 'Fixture', 'accepted message', 'General', undefined, undefined, canonicalId, undefined, createdAt);

test('a configured but disconnected ordinary relay rejects and blocks clean drain', async () => {
  await load(false);
  await expect(relay()).rejects.toThrow();
  expect(mockSend).not.toHaveBeenCalled();
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
});

test('an invalid explicit mapped channel cannot fall through to the default', async () => {
  await load();
  mockClient.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });
  const result = relay().catch(error => error);
  await jest.advanceTimersByTimeAsync(250);
  expect(await result).toBeInstanceOf(Error);
  expect(mockClient.channels.fetch).toHaveBeenCalledTimes(1);
  expect(mockSend).not.toHaveBeenCalled();
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
});

test('the queue shifting to empty still reports the send and link as in-flight accepted work', async () => {
  await load(); const gate = deferred(); mockSend.mockImplementationOnce(() => gate.promise);
  const accepted = relay(); await jest.advanceTimersByTimeAsync(250);
  expect(mockSend).toHaveBeenCalledTimes(1); runtime.freeze('cutover');
  const drain = runtime.drain({ timeoutMs: 1000 }); await jest.advanceTimersByTimeAsync(25);
  const inspection = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants['discord-outbound'];
  expect(inspection.detail).toEqual({ queued: 0, inFlight: 1 }); expect(inspection.pending).toBe(1);
  gate.resolve({ id: sentId }); await accepted; await jest.advanceTimersByTimeAsync(25);
  expect((await drain).phase).toBe('drained');
  expect(mockLink).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ messageId: canonicalId, discordMessageId: sentId }) }));
});

test('send success followed by failed link persistence rejects and retains both IDs without retrying the send', async () => {
  await load(); mockLink.mockRejectedValueOnce(new Error('link database unavailable'));
  const failure = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250);
  expect((await failure).message).toBe('Required Discord relay did not complete; private recovery required'); expect(mockSend).toHaveBeenCalledTimes(1);
  const result = await runtime.drain({ timeoutMs: 1000, close: true });
  expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
    messageId: canonicalId, discordMessageId: sentId, stage: 'send-succeeded-link-unconfirmed' }) }));
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
  mockSavedLink = { messageId: canonicalId, isBotMessage: false };
  mockClient.emit('messageUpdate', {}, { id: 'discord-edited-id', channelId: '100000000000000001', content: 'accepted edit', author: { bot: false } });
  await jest.advanceTimersByTimeAsync(0);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(runtime.snapshot().failures).toContainEqual(expect.objectContaining({
    label: 'discord:inbound-edit', evidence: expect.objectContaining({ canonicalId,
      discordMessageId: 'discord-edited-id', discordChannelId: '100000000000000001', stage: 'discord-edit-observed-local-update-unconfirmed' }) }));
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

const journalRecords = () => fs.readFileSync(runtime.discordRelays.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const configuration = () => require('../src/config/environment').default;
const database = () => require('../src/config/prisma').default;

test.each(['missing', 'fetch-refused'])('an explicit mapped target %s rejects with no default destination send', async mode => {
  await load();
  if (mode === 'missing') mockClient.channels.fetch.mockResolvedValueOnce(null);
  else mockClient.channels.fetch.mockRejectedValueOnce(new Error('private-target-url-canary'));
  await expect(relay()).rejects.toThrow();
  expect(mockClient.channels.fetch).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled();
  expect(journalRecords().map(record => record.stage)).toEqual(['intent']);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
});

test.each(['no-destination', 'mapping-refused'])('expected relay %s cannot become a clean never-enqueued result', async mode => {
  await load(false);
  if (mode === 'no-destination') {
    configuration().DISCORD_CHANNEL_ID = '';
    database().channel.findMany.mockResolvedValue([]);
  } else database().discordRelayMapping.findMany.mockRejectedValue(new Error('private-mapping-secret-canary'));
  await expect(relay()).rejects.toThrow();
  expect(mockSend).not.toHaveBeenCalled();
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(JSON.stringify(runtime.snapshot())).not.toMatch(/private-mapping-secret-canary/);
});

test.each(['disabled', 'probe-body', 'probe-author'])('explicit %s exclusion remains clean without a journal or provider lookup', async mode => {
  await load(false);
  if (mode === 'disabled') configuration().DISCORD_TOKEN = '';
  await service.relayToDiscord('game-channel', mode === 'probe-author' ? 'TestBot123' : 'Fixture',
    mode === 'probe-body' ? '[TEST-ROUNDTRIP-123]' : 'ordinary body');
  expect(mockSend).not.toHaveBeenCalled(); expect(database().channel.findMany).not.toHaveBeenCalled();
  expect(runtime.discordRelays.inspect().pending).toBe(0);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});

test('the original UUID/time is durable before dispatch and the returned ID is durable before the local link', async () => {
  await load();
  mockSend.mockImplementationOnce(async () => {
    expect(journalRecords().map(record => record.stage)).toEqual(['intent', 'attempt']);
    expect(journalRecords()[0].intent).toMatchObject({ canonicalId, createdAt });
    return { id: sentId };
  });
  mockLink.mockImplementationOnce(async ({ create }) => {
    expect(journalRecords().at(-1)).toMatchObject({ stage: 'returned', discordMessageId: sentId });
    mockSavedLink = create; return create;
  });
  const accepted = relay(); await jest.advanceTimersByTimeAsync(250); await accepted;
  expect(journalRecords().map(record => record.stage)).toEqual(['intent', 'attempt', 'returned', 'complete']);
  await relay(); expect(mockSend).toHaveBeenCalledTimes(1);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});

test.each(['expect', 'attempt'])('%s journal refusal precedes every possible provider create', async method => {
  await load(); const spy = jest.spyOn(runtime.discordRelays, method).mockImplementation(() => { throw new Error('private-prewrite-canary'); });
  const rejected = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250); await rejected;
  expect(mockSend).not.toHaveBeenCalled(); expect(mockLink).not.toHaveBeenCalled();
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed'); spy.mockRestore();
  expect(JSON.stringify(runtime.snapshot())).not.toContain('private-prewrite-canary');
});

test.each(['returned', 'complete', 'link', 'verification'])('%s uncertainty remains durable and a repeat cannot create again', async mode => {
  await load();
  if (mode === 'returned' || mode === 'complete') jest.spyOn(runtime.discordRelays, mode).mockImplementationOnce(() => { throw new Error('private-post-effect-canary'); });
  if (mode === 'link') mockLink.mockRejectedValueOnce(new Error('private-link-canary'));
  if (mode === 'verification') database().discordMessageLink.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  const rejected = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250); await rejected;
  const expectedStage = mode === 'returned' ? 'attempt' : 'returned';
  expect(journalRecords().at(-1).stage).toBe(expectedStage);
  if (expectedStage === 'returned') expect(journalRecords().at(-1).discordMessageId).toBe(sentId);
  const originalFailure = runtime.snapshot().failures[0];
  await expect(relay()).rejects.toThrow(); expect(mockSend).toHaveBeenCalledTimes(1);
  expect(runtime.snapshot().failures).toContainEqual(originalFailure);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(JSON.stringify(runtime.snapshot())).not.toMatch(/private-post-effect-canary|private-link-canary/);
});

test('unknown send result retains its original attempt across a failed drain and restart', async () => {
  await load(); mockSend.mockRejectedValueOnce(new Error('private-lost-result-canary'));
  const rejected = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250); await rejected;
  expect(journalRecords().at(-1).stage).toBe('attempt');
  await expect(relay()).rejects.toThrow(); expect(mockSend).toHaveBeenCalledTimes(1);
  const original = runtime.snapshot().failures;
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  try {
    expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(original);
    expect(() => restarted.run('ordinary-producer', relay)).toThrow('Maintenance');
  } finally { restarted.disposeForTests(); }
});

test('new live producers cannot write intent or queue after admission freeze', async () => {
  await load(); runtime.freeze('fixture');
  await expect(relay()).rejects.toThrow('Maintenance'); expect(mockSend).not.toHaveBeenCalled();
  expect(fs.existsSync(runtime.discordRelays.filename)).toBe(false);
});

test('payload, destination and config collisions keep the original completed operation and refuse another create', async () => {
  await load(); const first = relay(); await jest.advanceTimersByTimeAsync(250); await first;
  const bytes = fs.readFileSync(runtime.discordRelays.filename);
  await expect(service.relayToDiscord('game-channel', 'Fixture', 'different canary body', 'General', undefined, undefined, canonicalId, undefined, createdAt)).rejects.toThrow('private recovery');
  configuration().DISCORD_CHANNEL_ID = '100000000000000008';
  await expect(relay()).rejects.toThrow('private recovery');
  database().channel.findMany.mockResolvedValue([{ id: 'game-channel', discordChannelId: '100000000000000009' }]); service.invalidateRelayMappingsCache();
  await expect(relay()).rejects.toThrow('private recovery');
  expect(fs.readFileSync(runtime.discordRelays.filename)).toEqual(bytes); expect(mockSend).toHaveBeenCalledTimes(1);
});

test('an actual pre-attempt fsync refusal leaves zero creates and retained protected input', async () => {
  await load();
  const sync = fs.fsyncSync; let refused = false;
  const spy = jest.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if (!refused && fs.existsSync(runtime.discordRelays.filename)
      && journalRecords().at(-1).stage === 'attempt') { refused = true; throw new Error('private-fsync-canary'); }
    return sync(descriptor);
  });
  try {
    const rejected = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250); await rejected;
    expect(refused).toBe(true); expect(mockSend).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
  expect(runtime.discordRelays.inspect().pending).toBe(1);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
});

test('failed protected-payload cleanup remains fenced after known verified completion without a second create', async () => {
  await load();
  const remove = fs.unlinkSync;
  const spy = jest.spyOn(fs, 'unlinkSync').mockImplementation(filename => {
    if (filename.startsWith(runtime.discordRelays.payloadDirectory)) throw new Error('private-cleanup-canary');
    return remove(filename);
  });
  try {
    const rejected = relay().catch(error => error); await jest.advanceTimersByTimeAsync(250); await rejected;
    expect(journalRecords().at(-1)).toMatchObject({ stage: 'complete', discordMessageId: sentId });
  } finally { spy.mockRestore(); }
  expect(runtime.discordRelays.inspect().pending).toBe(1);
  await relay(); expect(mockSend).toHaveBeenCalledTimes(1);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(JSON.stringify(runtime.snapshot())).not.toContain('private-cleanup-canary');
});

test('the actual live-only REST caller retains original input/UUID/time privately when Discord is disconnected', async () => {
  await load(false);
  database().channel.findFirst = jest.fn(async () => ({ id: 'game-channel' }));
  const { createMessage } = require('../src/controllers/messagesController');
  const channelId = 'a2000000-0000-4000-8000-000000000002';
  const output = []; global.broadcast = frame => output.push(frame);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  try {
    await createMessage({ body: { channelId, content: 'private-rest-message-canary' }, adminUser: { username: 'OriginalRestAuthor' } }, res, next);
    await jest.advanceTimersByTimeAsync(0);
    const payload = output[0].payload;
    expect(res.status).toHaveBeenCalledWith(201); expect(res.json).toHaveBeenCalledWith({ data: { id: payload.id } });
    const expected = journalRecords()[0].intent;
    expect(expected).toMatchObject({ canonicalId: payload.id, createdAt: payload.timestamp });
    const protectedInput = JSON.parse(fs.readFileSync(path.join(runtime.discordRelays.payloadDirectory, `${expected.operationId}.json`), 'utf8'));
    expect(protectedInput).toMatchObject({ canonicalId: payload.id, createdAt: payload.timestamp,
      payload: { username: 'OriginalRestAuthor', content: 'private-rest-message-canary', discordPrefix: '**OriginalRestAuthor**: ' } });
    expect(mockSend).not.toHaveBeenCalled(); expect(mockLink).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime.snapshot()) + fs.readFileSync(runtime.discordRelays.filename, 'utf8')).not.toMatch(/private-rest-message-canary|OriginalRestAuthor/);
    expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  } finally { delete global.broadcast; }
});

test('an existing legacy link is evidence requiring verification and cannot authorize another ordinary create', async () => {
  await load();
  mockSavedLink = { messageId: canonicalId, discordMessageId: sentId, discordChannelId: '100000000000000001', isBotMessage: true };
  await expect(relay()).rejects.toThrow('private recovery');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockLink).not.toHaveBeenCalled();
  expect(runtime.snapshot().failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
    canonicalId, discordMessageId: sentId, stage: 'prior-discord-link-requires-verification' }) }));
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
});

test('original payload and prefix survive caller mutation during mapping discovery', async () => {
  await load(false);
  const lookup = deferred(); database().channel.findMany.mockImplementationOnce(() => lookup.promise);
  const badges = ['supporter']; const metadata = { note: 'original-metadata' };
  const failed = service.relayToDiscord('game-channel', 'OriginalAuthor', 'original-body', 'General', undefined,
    metadata, canonicalId, { badges }, createdAt).catch(error => error);
  metadata.note = 'mutated'; badges.length = 0;
  lookup.resolve([{ id: 'game-channel', discordChannelId: '100000000000000001' }]); await failed;
  const expected = journalRecords()[0].intent;
  const protectedInput = JSON.parse(fs.readFileSync(path.join(runtime.discordRelays.payloadDirectory, `${expected.operationId}.json`), 'utf8'));
  expect(protectedInput.payload).toMatchObject({ metadata: { note: 'original-metadata' }, authorCosmetics: { badges: ['supporter'] },
    discordPrefix: '**[General]** **★ OriginalAuthor**: ' });
  expect(mockSend).not.toHaveBeenCalled();
});

test('failed initial REST payload durability preserves HTTP policy but forbids a clean boundary or another process', async () => {
  await load(false); database().channel.findFirst = jest.fn(async () => ({ id: 'game-channel' }));
  const open = fs.openSync;
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((filename, ...args) => {
    if (filename.startsWith(runtime.discordRelays.payloadDirectory + path.sep)) throw Object.assign(new Error('private-initial-durability-canary'), { code: 'ENOSPC' });
    return open(filename, ...args);
  });
  const output = []; global.broadcast = frame => output.push(frame);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  try {
    await require('../src/controllers/messagesController').createMessage({
      body: { channelId: 'a2000000-0000-4000-8000-000000000002', content: 'private-unavailable-rest-body-canary' },
      adminUser: { username: 'OriginalRestAuthor' },
    }, res, jest.fn());
    await jest.advanceTimersByTimeAsync(0);
  } finally { spy.mockRestore(); delete global.broadcast; }
  expect(res.status).toHaveBeenCalledWith(201); expect(output).toHaveLength(1);
  expect(mockSend).not.toHaveBeenCalled(); expect(fs.existsSync(runtime.discordRelays.filename)).toBe(false);
  expect(fs.readdirSync(runtime.discordRelays.payloadDirectory)).toEqual([]);
  expect(runtime.snapshot().failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
    canonicalId: output[0].payload.id, createdAt: output[0].payload.timestamp, stage: 'expected-discord-relay-unconfirmed',
  }) }));
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  const restarted = new (require('../src/runtime/coordinator').RuntimeCoordinator)(mockDirectory);
  try { expect(restarted.isFrozen()).toBe(true); } finally { restarted.disposeForTests(); }
  expect(fs.readFileSync(runtime.failuresPath, 'utf8')).not.toMatch(/private-unavailable-rest-body-canary|private-initial-durability-canary/);
});
