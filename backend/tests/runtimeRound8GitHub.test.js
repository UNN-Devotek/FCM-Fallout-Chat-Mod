const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
let mockRuntime, directory;
const mockPrisma = { githubIssueThread: { findUnique: jest.fn(), deleteMany: jest.fn() } };
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { GITHUB_PAT: 'fixture-pat', GITHUB_OWNER: 'fixture-owner', GITHUB_REPO: 'fixture-repo' } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info() {}, warn() {}, error() {}, debug() {} } }));
jest.mock('../src/services/playerReportService', () => ({ __esModule: true, default: {} }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const service = require('../src/services/githubService');
const tickets = require('../src/services/ticketService');
const originalFetch = global.fetch;
const valid = { data: { deleteIssue: { clientMutationId: null } } };
const forbidden = { data: { deleteIssue: null }, errors: [{ type: 'FORBIDDEN', path: ['deleteIssue'], message: 'private response body fixture' }] };
const unknown = [
  ['malformed', '{"data":'], ['missing-data', {}], ['missing-mutation', { data: {} }],
  ['null-mutation', { data: { deleteIssue: null } }], ['missing-field', { data: { deleteIssue: {} } }],
  ['invalid-field', { data: { deleteIssue: { clientMutationId: 7 } } }],
  ['graphql-error', { errors: [{ message: 'private response body fixture', type: 'INTERNAL', path: ['deleteIssue'] }] }],
];
const response = body => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-round8-github-'));
  mockRuntime = new RuntimeCoordinator(directory); jest.clearAllMocks();
  mockPrisma.githubIssueThread.findUnique.mockResolvedValue({ issueNumber: 17, issueNodeId: 'I_fixture_17', discordThreadId: '123456789012345678' });
  mockPrisma.githubIssueThread.deleteMany.mockResolvedValue({ count: 1 });
  global.fetch = jest.fn();
});
afterEach(() => { global.fetch = originalFetch; mockRuntime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
test.each(unknown)('actual deleteIssue %s response rejects and retains safe required evidence', async (_label, body) => {
  global.fetch.mockResolvedValueOnce(response(body));
  await expect(mockRuntime.run('accepted-delete', () => service.deleteIssue('I_fixture_17'))).rejects.toThrow();
  const final = await mockRuntime.drain({ timeoutMs: 500 });
  expect(final.phase).toBe('failed'); expect(final.active).toEqual([]);
  expect(final.failures).toContainEqual(expect.objectContaining({ label: 'domain:primary', evidence: expect.objectContaining({ issueNodeId: 'I_fixture_17', stage: 'github-issue-delete-unconfirmed' }) }));
  expect(JSON.stringify(final.failures)).not.toMatch(/private response|fixture-pat/);
});
test.each([null, 'fixture-mutation'])('actual deleteIssue accepts the selected nullable result field %s', async clientMutationId => {
  global.fetch.mockResolvedValueOnce(response({ data: { deleteIssue: { clientMutationId } } }));
  await expect(mockRuntime.run('accepted-delete', () => service.deleteIssue('I_fixture_17'))).resolves.toBeUndefined();
  expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained');
});
async function deleteTicket(body) {
  // A valid close reply is available deliberately: an unknown delete result must
  // stop before even that fallback, mapping unlink, or Discord thread deletion.
  global.fetch.mockImplementation(async url => response(url.endsWith('/graphql') ? body : { number: 17, state: 'closed' }));
  const client = new EventEmitter(); tickets.register(client);
  const interaction = { customId: 'ght:delconfirm:17', isButton: () => true, memberPermissions: { has: () => true }, user: { id: '123456789012345679' },
    channel: { id: '123456789012345678', isThread: () => true, delete: jest.fn().mockResolvedValue(undefined) },
    deferReply: jest.fn(async () => { interaction.deferred = true; }), editReply: jest.fn().mockResolvedValue(undefined), reply: jest.fn().mockResolvedValue(undefined) };
  await mockRuntime.run('accepted-ticket-callback', () => client.listeners('interactionCreate')[0](interaction));
  return interaction;
}
test.each(unknown)('registered actual ticket %s deletion cannot confirm, unlink or tear down the thread', async (_label, body) => {
  const interaction = await deleteTicket(body);
  expect(global.fetch).toHaveBeenCalledTimes(1); expect(mockPrisma.githubIssueThread.deleteMany).not.toHaveBeenCalled(); expect(interaction.channel.delete).not.toHaveBeenCalled();
  expect(interaction.editReply.mock.calls[0][0].content).toContain('Could not confirm');
  const final = await mockRuntime.drain({ timeoutMs: 500 });
  expect(final.phase).toBe('failed'); expect(final.active).toEqual([]);
  expect(final.failures).toContainEqual(expect.objectContaining({ label: 'ticket:issue-delete', evidence: expect.objectContaining({ issueNumber: 17, issueNodeId: 'I_fixture_17', stage: 'issue-delete-or-close-unconfirmed' }) }));
  expect(JSON.stringify(final.failures)).not.toMatch(/private response|fixture-pat|issue-delete-confirmed/);
});
test('registered ticket valid deletion unlinks then deletes the actual tracked thread', async () => {
  const interaction = await deleteTicket(valid);
  expect(global.fetch).toHaveBeenCalledTimes(1); expect(mockPrisma.githubIssueThread.deleteMany).toHaveBeenCalledTimes(1); expect(interaction.channel.delete).toHaveBeenCalledTimes(1);
  expect(mockPrisma.githubIssueThread.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(interaction.channel.delete.mock.invocationCallOrder[0]);
  expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained');
});
test('a concrete GraphQL delete permission refusal retains the existing verified-close fallback', async () => {
  const interaction = await deleteTicket(forbidden);
  expect(global.fetch).toHaveBeenCalledTimes(2); expect(mockPrisma.githubIssueThread.deleteMany).toHaveBeenCalledTimes(1); expect(interaction.channel.delete).toHaveBeenCalledTimes(1);
  expect(interaction.editReply.mock.calls[0][0].content).toContain('closed it instead');
});

test.each(['{"number":', {}, { number: 18, state: 'closed' }, { number: 17, state: 'open' }])('actual closure cannot confirm an invalid result %#', async body => {
  global.fetch.mockResolvedValueOnce(response(body));
  await expect(mockRuntime.run('accepted-close', () => service.closeIssue(17))).rejects.toThrow('closure result');
  const final = await mockRuntime.drain({ timeoutMs: 500 });
  expect(final.phase).toBe('failed'); expect(final.active).toEqual([]);
  expect(final.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ issueNumber: 17, stage: 'github-issue-close-unconfirmed' }) }));
});

test.each(['{"number":', {}])('permission-refused deletion plus invalid closure %# cannot unlink or tear down', async body => {
  global.fetch.mockImplementation(async url => response(url.endsWith('/graphql') ? forbidden : body));
  const client = new EventEmitter(); tickets.register(client);
  const interaction = { customId: 'ght:delconfirm:17', isButton: () => true, memberPermissions: { has: () => true }, user: { id: '123456789012345679' }, deferred: true,
    channel: { id: '123456789012345678', isThread: () => true, delete: jest.fn() }, deferReply: jest.fn(), editReply: jest.fn(), reply: jest.fn() };
  await mockRuntime.run('accepted-ticket-callback', () => client.listeners('interactionCreate')[0](interaction));
  expect(global.fetch).toHaveBeenCalledTimes(2); expect(mockPrisma.githubIssueThread.deleteMany).not.toHaveBeenCalled(); expect(interaction.channel.delete).not.toHaveBeenCalled();
  expect(interaction.editReply.mock.calls[0][0].content).toContain('Could not confirm');
  expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('failed');
});
