const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const esbuild = require('esbuild');
let mockDirectory, maintenance, prisma, service, event, mirror, publisher;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
const secretError = () => new Error('fixture-secret SQL message body');
const logger = { info() {}, warn() {}, error() {}, debug() {} };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-event-effects-')); maintenance = require('../src/runtime').runtime;
  mirror = { id: 'fixture-mirror', guildId: 'fixture-guild', scheduledEventId: 'fixture-event', sourceStatus: 'SCHEDULED',
    announcementChannelId: 'fixture-channel', announcementMessageId: null, generatedDescriptionLink: null };
  event = { guildId: mirror.guildId, id: mirror.scheduledEventId, status: 1, name: 'Fixture event', description: 'Creator text',
    coverImageURL: () => null, edit: jest.fn(async () => {}), fetchSubscribers: jest.fn(async () => new Map()) };
  prisma = { discordEventMirror: { findUnique: jest.fn(async () => mirror), upsert: jest.fn(async () => mirror), update: jest.fn(async () => mirror) },
    discordEventSubscriber: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0), upsert: jest.fn(async () => {}), deleteMany: jest.fn(async () => {}) },
    user: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({ id: 'fixture-user', username: 'fixture' })) },
    $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn(async () => 1), $transaction: jest.fn(async fn => fn(prisma)) };
  publisher = { messages: { fetch: jest.fn(async () => new Map()) }, send: jest.fn(async () => ({ id: 'fixture-message', url: 'https://fixture.test/message' })) };
  // Compile the complete actual service into an isolated module, capturing only
  // private functions for tests. Production exports and logic remain unchanged.
  const source = fs.readFileSync(path.join(__dirname, '../src/services/discordEventService.ts'), 'utf8')
    + '\nmodule.exports.__fixture={appendAnnouncementLink,reconcileSubscribers,syncEvent,setRuntime(value){runtime=value;}};';
  const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  const module = { exports: {} };
  const load = name => {
    if (name === '../runtime') return { runtime: maintenance, producerInterval: jest.fn() };
    if (name === '../config/prisma') return { __esModule: true, default: prisma };
    if (name === '../config/logger') return { __esModule: true, default: logger };
    if (name === '../config/environment') return { __esModule: true, default: { DISCORD_SERVER_ID: 'fixture-guild', DISCORD_EVENTS_CHANNEL_ID: 'fixture-channel' } };
    if (name === './messageService') return { persistMessage: jest.fn(async () => {}) };
    if (name === './relay/relaySeq') return { nextRelaySeq: jest.fn(async () => 1) };
    if (name.startsWith('.')) return require(path.resolve(__dirname, '../src/services', name));
    return require(name);
  };
  vm.runInNewContext(code, { require: load, module, exports: module.exports, URL, console, Buffer }); service = module.exports.__fixture;
  service.setRuntime({ client: { user: { id: 'fixture-bot', username: 'fixture-bot' } }, eventChannel: publisher,
    broadcast: jest.fn(), broadcastToUsers: jest.fn(async () => 0), queuedSyncs: new Map() });
});
afterEach(() => { maintenance.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
async function run(fn) { await maintenance.run('fixture:event-work', () => fn().catch(() => {})); }
async function failed(stage) {
  const result = await maintenance.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ scheduledEventId: 'fixture-event', stage }) }));
  expect(JSON.stringify(result.failures)).not.toContain('fixture-secret SQL message body');
}
test('successful external event edit followed by failed generated-link persistence remains a required effect', async () => {
  prisma.discordEventMirror.update.mockRejectedValueOnce(secretError());
  await run(() => service.appendAnnouncementLink(event, { ...mirror, eventCode: 'FIXTURE' }, 'https://fixture.test/message'));
  expect(event.edit).toHaveBeenCalledTimes(1); await failed('generated-link-persistence-unconfirmed');
});
test('overflow description repair retains a failed local generated-link update', async () => {
  event.description = 'x'.repeat(999); prisma.discordEventMirror.update.mockRejectedValueOnce(secretError());
  await run(() => service.appendAnnouncementLink(event, { ...mirror, eventCode: 'FIXTURE' }, 'https://fixture.test/message'));
  await failed('generated-link-persistence-unconfirmed');
});
test('a failed external description edit is retained with trusted event identifiers', async () => {
  event.edit.mockRejectedValueOnce(secretError());
  await run(() => service.appendAnnouncementLink(event, { ...mirror, eventCode: 'FIXTURE' }, 'https://fixture.test/message'));
  await failed('description-edit-unconfirmed');
});
test.each(['upsert', 'deleteMany'])('subscriber reconciliation retains its failed %s transaction mutation', async operation => {
  if (operation === 'upsert') event.fetchSubscribers.mockResolvedValueOnce(new Map([['fixture-discord-user', { user: { id: 'fixture-discord-user' } }]]));
  prisma.discordEventSubscriber[operation].mockRejectedValueOnce(secretError());
  await run(() => service.reconcileSubscribers(event, mirror.id)); await failed('subscriber-transaction-unconfirmed');
});
test('successful subscriber reconciliation followed by failed mirror write cannot become the read fallback', async () => {
  prisma.discordEventMirror.update.mockRejectedValueOnce(secretError());
  await run(() => service.syncEvent(event)); await failed('subscriber-mirror-update-unconfirmed');
});
test('a transient subscriber read failure preserves the fallback without a required mutation failure', async () => {
  event.fetchSubscribers.mockRejectedValueOnce(secretError()); await run(() => service.syncEvent(event));
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect((await maintenance.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
