const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const http = require('node:http');
let mockRuntime, mockNativeTarget, directory;
const mockPrisma = { githubIssueThread: { findUnique: jest.fn(), create: jest.fn() } };
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { GITHUB_PAT: 'fixture-pat', GITHUB_OWNER: 'fixture-owner', GITHUB_REPO: 'fixture-repo' } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info() {}, warn() {}, error() {}, debug() {} } }));
jest.mock('../src/services/playerReportService', () => ({ __esModule: true, default: {} }));
jest.mock('../src/runtime/nativeFetch', () => {
  const actual = jest.requireActual('../src/runtime/nativeFetch');
  return { beginRuntimeFetch: (input, init) => {
    // Route this imported helper only to the owned test server, then invoke its
    // unchanged native implementation and current runtime instance.
    const url = new URL(input);
    if (mockNativeTarget && url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture provider');
    return actual.beginRuntimeFetch(mockNativeTarget ? new URL(url.pathname + url.search, mockNativeTarget) : input, init);
  } };
});
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const service = require('../src/services/githubService'), tickets = require('../src/services/ticketService');
const { cases, issue } = require('./setup/github-rest-outcomes.cjs');
const originalFetch = global.fetch;
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-rest-confirmation-')); mockRuntime = new RuntimeCoordinator(directory); mockNativeTarget = undefined; jest.clearAllMocks(); global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; mockRuntime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
test.each(cases)('actual required REST $label validates its endpoint result without changing optional/noop behavior', async item => {
  global.fetch.mockResolvedValueOnce(response(item.body, item.status));
  let value, error;
  await mockRuntime.run('accepted-rest-callback', async () => { try { value = await service[item.method](...item.args); } catch (caught) { error = caught; } });
  const state = await mockRuntime.drain({ timeoutMs: 500 }); expect(state.active).toEqual([]);
  if (item.unknown) {
    expect(error).toBeInstanceOf(Error); expect(state.phase).toBe('failed');
    expect(state.failures).toContainEqual(expect.objectContaining({ label: 'domain:primary', evidence: expect.objectContaining({ stage: expect.stringMatching(/^github-.*-unconfirmed$/) }) }));
    expect(JSON.stringify(state.failures)).not.toMatch(/fixture-pat|synthetic fixture|https:\/\/github|\/repos\//);
  } else { expect(error).toBeUndefined(); expect(state.phase).toBe('drained'); expect(state.failures).toEqual([]); }
  expect(global.fetch).toHaveBeenCalledTimes(item.noRequest ? 0 : 1);
  if (item.method === 'addLabels' && !item.noRequest) {
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/fixture-owner/fixture-repo/issues/42/labels');
    expect(options.method).toBe('POST'); expect(JSON.parse(options.body)).toEqual({ labels: item.args[1] });
    if (item.unknown) expect(state.failures).toContainEqual(expect.objectContaining({ label: 'domain:primary',
      evidence: expect.objectContaining({ issueNumber: 42, stage: 'github-labels-write-unconfirmed', writerId: 'c165a46c2ae94312be8d9f97' }) }));
  }
  if (item.label === 'create-valid') expect(value).toEqual({ number: 42, nodeId: issue.node_id, htmlUrl: issue.html_url, title: 'fixture' });
  if (item.label === 'comment-valid') expect(value).toBe(123);
  if (item.label === 'optional-list-malformed') expect(value).toEqual([]);
});
test.each(cases.filter(item => item.method === 'addLabels'))('actual native loopback label $label preserves confirmation and required disposition', async item => {
  const requests = [], sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.once('end', () => {
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
      res.writeHead(item.status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(typeof item.body === 'string' ? item.body : JSON.stringify(item.body));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  mockNativeTarget = `http://127.0.0.1:${server.address().port}`; global.fetch = originalFetch;
  try {
    let error;
    await mockRuntime.run('accepted-native-label', async () => { try { await service.addLabels(...item.args); } catch (caught) { error = caught; } });
    const state = await mockRuntime.drain({ timeoutMs: 500 }); expect(state.active).toEqual([]);
    if (item.unknown) {
      expect(error).toBeInstanceOf(Error); expect(state.phase).toBe('failed');
      expect(state.failures).toContainEqual(expect.objectContaining({ label: 'domain:primary',
        evidence: expect.objectContaining({ issueNumber: 42, stage: 'github-labels-write-unconfirmed', writerId: 'c165a46c2ae94312be8d9f97' }) }));
      expect(JSON.stringify(state.failures)).not.toMatch(/fixture-pat|\/repos\//);
    } else { expect(error).toBeUndefined(); expect(state.phase).toBe('drained'); expect(state.failures).toEqual([]); }
    expect(requests).toEqual(item.noRequest ? [] : [{ method: 'POST', path: '/repos/fixture-owner/fixture-repo/issues/42/labels', body: { labels: item.args[1] } }]);
  } finally { mockNativeTarget = undefined; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
test.each([{ number: 0 }, { node_id: ' ' }, { html_url: '' }, { html_url: 'not-a-url' }, { title: '' }])('actual create rejects unusable selected identity %#', async patch => {
  global.fetch.mockResolvedValueOnce(response({ ...issue, ...patch }, 201));
  await expect(mockRuntime.run('accepted-create', () => service.createIssue({ title: 'fixture', body: 'synthetic' }))).rejects.toThrow();
  expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('failed');
});
async function interaction(customId, extra) {
  const client = new EventEmitter(); tickets.register(client);
  const input = { customId, user: { id: 'fixture-reporter', username: 'Fixture' },
    deferReply: jest.fn(async () => { input.deferred = true; }), editReply: jest.fn(), reply: jest.fn(), ...extra };
  await mockRuntime.run('accepted-ticket-callback', () => client.listeners('interactionCreate')[0](input)); return input;
}
test('a matching but invalid returned milestone number cannot confirm an accepted request', async () => {
  global.fetch.mockResolvedValueOnce(response({ number: 42, milestone: { number: 0 } }));
  await expect(mockRuntime.run('accepted-milestone', () => service.setIssueMilestone(42, 0))).rejects.toThrow('milestone is unconfirmed');
  expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('failed');
});
test('actual registered ticket does not start a Discord thread for unconfirmed issue identity', async () => {
  global.fetch.mockResolvedValueOnce(response({}, 201)); const create = jest.fn();
  const input = await interaction('ght:submit:bug', { isModalSubmit: () => true, fields: { getTextInputValue: () => 'synthetic' }, channel: { id: 'fixture-channel', type: 0, threads: { create } } });
  expect(create).not.toHaveBeenCalled(); expect(mockPrisma.githubIssueThread.create).not.toHaveBeenCalled();
  expect(input.editReply.mock.calls[0][0].content).toContain('could not be fully linked'); expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('failed');
});
test.each([1, null])('actual registered ticket never acknowledges unconfirmed milestone %s', async requested => {
  mockPrisma.githubIssueThread.findUnique.mockResolvedValue({ issueNumber: 42, reporterId: 'fixture-reporter' });
  global.fetch.mockResolvedValueOnce(response({ number: 42, milestone: requested === null ? { number: 1 } : null }));
  const input = await interaction('ght:milestone:42', { isStringSelectMenu: () => true, values: [requested === null ? 'none' : String(requested)] });
  expect(input.editReply.mock.calls[0][0].content).toContain('Failed to set'); expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('failed');
});
