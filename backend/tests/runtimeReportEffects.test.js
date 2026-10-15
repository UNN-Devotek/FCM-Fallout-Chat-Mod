const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
let mockDirectory, runtime, prisma, ticket, reports, github, client, thread;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory,
  OWNER_ROLE_ID: 'owner-role', DISCORD_SERVER_ID: 'fixture-guild' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  playerReport: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
  githubIssueThread: { findUnique: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  moderationSetting: { upsert: jest.fn() },
} }));
jest.mock('../src/services/githubService', () => ({ __esModule: true, default: { createIssue: jest.fn(), listOpenMilestones: jest.fn(async () => []),
  deleteIssue: jest.fn(), closeIssue: jest.fn(), isIssueDeleteRefused: jest.fn(() => false) } }));
jest.mock('../src/services/reportImageService', () => ({ uploadReportImages: jest.fn(async () => ['https://fixture.test/report-images/object-id.webp']) }));
const report = { id: 'report-id', reportNumber: 17, discordThreadId: 'created-thread-id', imageUrls: null };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-report-effects-'));
  runtime = require('../src/runtime').runtime; prisma = require('../src/config/prisma').default;
  github = require('../src/services/githubService').default; reports = require('../src/services/playerReportService');
  ticket = require('../src/services/ticketService');
  prisma.playerReport.findFirst.mockResolvedValue(report); prisma.playerReport.findUnique.mockResolvedValue(report);
  prisma.playerReport.update.mockResolvedValue(report); prisma.playerReport.delete.mockResolvedValue(report);
  prisma.githubIssueThread.findUnique.mockResolvedValue({ issueNodeId: 'issue-node-id', discordThreadId: 'created-thread-id' });
  prisma.githubIssueThread.deleteMany.mockResolvedValue({ count: 1 }); github.deleteIssue.mockResolvedValue(undefined);
  thread = { id: 'created-thread-id', isThread: () => true, members: { add: jest.fn(async () => {}) },
    send: jest.fn(async () => ({ id: 'intro-message-id' })), delete: jest.fn(async () => {}) };
  client = new EventEmitter(); require('../src/runtime/ingress').accountDiscordEmitter(client, runtime); ticket.register(client);
});
afterEach(() => { runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
async function failedDrain(label, evidence) {
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label, evidence: expect.objectContaining(evidence) }));
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(result.failures); restarted.disposeForTests();
}
function interaction(action, arg) {
  const { buildCustomId } = require('../src/services/githubTicketHelpers');
  return { customId: buildCustomId(action, arg), isButton: () => true, memberPermissions: { has: () => true },
    user: { id: 'moderator-id' }, channel: thread, deferred: true, deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {}), reply: jest.fn(async () => {}) };
}
function creationInteraction() {
  const event = interaction('submit', 'bug'); event.isButton = () => false; event.isModalSubmit = () => true;
  event.fields = { getTextInputValue: () => 'Fixture text' };
  event.channel = { id: 'parent-channel', type: 0, threads: { create: jest.fn(async () => thread) },
    messages: { fetch: jest.fn(async () => ({ find: () => undefined })) } };
  return event;
}

test('thread creation followed by failed report binding preserves the existing thread and never re-creates it', async () => {
  prisma.playerReport.update.mockRejectedValueOnce(new Error('report binding unavailable'));
  const channel = { id: 'parent-channel', threads: { create: jest.fn(async () => thread) }, messages: { fetch: jest.fn(async () => new Map()) } };
  await expect(ticket.openReportThread({ reportId: report.id, reportNumber: 17, reporterName: 'Fixture' }, channel)).rejects.toThrow('binding');
  expect(channel.threads.create).toHaveBeenCalledTimes(1);
  await failedDrain('player-report:thread-link', { reportId: 'report-id', discordThreadId: 'created-thread-id', stage: 'thread-created-report-link-unconfirmed' });
});

test.each(['rclose', 'rdelconfirm'])('%s cannot acknowledge success or delete a thread after a failed required report write', async action => {
  const write = action === 'rclose' ? prisma.playerReport.update : prisma.playerReport.delete;
  write.mockRejectedValueOnce(new Error('report DB write unavailable'));
  const event = interaction(action); client.emit('interactionCreate', event);
  await failedDrain(action === 'rclose' ? 'player-report:status' : 'player-report:delete', {
    reportId: 'report-id', discordThreadId: 'created-thread-id' });
  expect(JSON.stringify(event.editReply.mock.calls)).not.toMatch(/marked closed|Report #17 .*deleted/);
  expect(thread.delete).not.toHaveBeenCalled();
});

test('a deleted external issue with a failed mapping delete keeps issue/thread IDs and refuses teardown success', async () => {
  prisma.githubIssueThread.deleteMany.mockRejectedValueOnce(new Error('mapping database unavailable'));
  const event = interaction('delconfirm', '23'); client.emit('interactionCreate', event);
  await failedDrain('ticket:issue-thread-unlink', { issueNumber: 23, issueNodeId: 'issue-node-id',
    discordThreadId: 'created-thread-id', stage: 'issue-delete-confirmed-map-delete-unconfirmed' });
  expect(github.deleteIssue).toHaveBeenCalledTimes(1); expect(thread.delete).not.toHaveBeenCalled();
  expect(JSON.stringify(event.editReply.mock.calls)).not.toMatch(/Teardown/);
});

test('a refused external deletion followed by an unconfirmed close preserves the issue mapping for explicit recovery', async () => {
  github.deleteIssue.mockRejectedValueOnce(new Error('delete permission refused'));
  github.isIssueDeleteRefused.mockReturnValueOnce(true);
  github.closeIssue.mockRejectedValueOnce(new Error('close response lost'));
  client.emit('interactionCreate', interaction('delconfirm', '23'));
  await failedDrain('ticket:issue-delete', { issueNumber: 23, issueNodeId: 'issue-node-id',
    discordThreadId: 'created-thread-id', stage: 'issue-delete-or-close-unconfirmed' });
  expect(prisma.githubIssueThread.deleteMany).not.toHaveBeenCalled(); expect(thread.delete).not.toHaveBeenCalled();
});

test('a required mapping lookup failure is never treated as an optional absent ticket', async () => {
  prisma.githubIssueThread.findUnique.mockRejectedValueOnce(new Error('mapping lookup unavailable'));
  client.emit('interactionCreate', interaction('delconfirm', '23'));
  await failedDrain('ticket:issue-thread-lookup', { issueNumber: 23, discordThreadId: 'created-thread-id' });
  expect(prisma.githubIssueThread.deleteMany).not.toHaveBeenCalled(); expect(github.deleteIssue).not.toHaveBeenCalled();
});

test('a failed GitHub issue creation is retained even when the interaction handler returns a refusal', async () => {
  github.createIssue.mockRejectedValueOnce(new Error('issue create response lost'));
  const event = creationInteraction(); client.emit('interactionCreate', event);
  await failedDrain('ticket:issue-create', { reporterId: 'moderator-id', stage: 'issue-create-result-unknown' });
  expect(github.createIssue).toHaveBeenCalledTimes(1); expect(event.channel.threads.create).not.toHaveBeenCalled();
});

test('an issue and thread already created retain both identities after their mapping save fails', async () => {
  github.createIssue.mockResolvedValueOnce({ number: 23, nodeId: 'issue-node-id', htmlUrl: 'https://github.com/fixture/project/issues/23' });
  prisma.githubIssueThread.create.mockRejectedValueOnce(new Error('issue-thread mapping unavailable'));
  const event = creationInteraction(); client.emit('interactionCreate', event);
  await failedDrain('ticket:issue-thread-link', { issueNumber: 23, issueNodeId: 'issue-node-id',
    discordThreadId: 'created-thread-id', stage: 'issue-and-thread-created-link-unconfirmed' });
  expect(github.createIssue).toHaveBeenCalledTimes(1); expect(event.channel.threads.create).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(event.editReply.mock.calls)).not.toContain('✅ Created');
});

test('a panel already sent keeps its Discord message ID when its channel binding fails', async () => {
  prisma.moderationSetting.upsert.mockRejectedValueOnce(new Error('panel binding unavailable'));
  const event = interaction('unused'); event.isChatInputCommand = () => true; event.commandName = 'ticket-panel';
  event.channel = { id: 'panel-channel', type: 0, send: jest.fn(async () => ({ id: 'panel-message-id' })) };
  client.emit('interactionCreate', event);
  await failedDrain('ticket:panel-link', { channelId: 'panel-channel', discordMessageId: 'panel-message-id',
    stage: 'panel-sent-channel-link-unconfirmed' });
  expect(event.channel.send).toHaveBeenCalledTimes(1); expect(JSON.stringify(event.editReply.mock.calls)).not.toContain('Ticket panel posted');
});

test('a deleted report row with unconfirmed thread deletion retains the report and external thread IDs', async () => {
  thread.delete.mockRejectedValueOnce(new Error('thread delete response lost'));
  client.emit('interactionCreate', interaction('rdelconfirm'));
  await failedDrain('player-report:thread-delete', { reportId: 'report-id', discordThreadId: 'created-thread-id',
    stage: 'report-delete-confirmed-thread-delete-unconfirmed' });
  expect(prisma.playerReport.delete).toHaveBeenCalledTimes(1); expect(thread.delete).toHaveBeenCalledTimes(1);
});

test('a role refusal happens before a required report write and does not mark the drain failed', async () => {
  const event = interaction('rdelconfirm'); event.memberPermissions.has = () => false;
  client.emit('interactionCreate', event); expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  expect(prisma.playerReport.delete).not.toHaveBeenCalled(); expect(thread.delete).not.toHaveBeenCalled();
});

test('uploaded report objects remain identified when their DB attachment fails', async () => {
  prisma.playerReport.update.mockRejectedValueOnce(new Error('image binding unavailable'));
  await expect(reports.attachImagesToReport('report-id', [Buffer.from('fixture')])).rejects.toThrow('image binding');
  await failedDrain('player-report:image-link', { reportId: 'report-id',
    objectKeys: ['report-images/object-id.webp'], stage: 'objects-uploaded-report-link-unconfirmed' });
});

test('an absent optional report lookup produces a refusal without an unresolved required write', async () => {
  prisma.playerReport.findFirst.mockResolvedValueOnce(null); const event = interaction('rclose');
  client.emit('interactionCreate', event);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  expect(prisma.playerReport.update).not.toHaveBeenCalled();
});
