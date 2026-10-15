const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { openRuntimeControl, drainTimeout } = require('../src/runtime/control');
let dir, runtime, servers;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-control-')); runtime = new RuntimeCoordinator(dir); servers = []; });
afterEach(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  runtime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true });
});
const command = (dir, action) => new Promise((resolve, reject) => {
  const socket = net.createConnection(path.join(dir, 'control.sock')); let text = '';
  socket.on('connect', () => socket.write(`${JSON.stringify({ action })}\n`));
  socket.on('data', data => { text += data.toString(); });
  socket.on('end', () => resolve(JSON.parse(text))); socket.on('error', reject);
});

test('local control is permission restricted, refuses resume, and supports freeze/drain without a public endpoint', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  expect(fs.statSync(path.join(dir, 'control.sock')).mode & 0o777).toBe(0o600);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect((await command(dir, 'status')).phase).toBe('running');
  expect((await command(dir, 'resume')).error).toBe('Unknown command');
  expect((await command(dir, 'freeze')).frozen).toBe(true);
  expect((await command(dir, 'drain')).phase).toBe('drained');
});

test('another live backend control socket is never unlinked or replaced', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  const inode = fs.statSync(path.join(dir, 'control.sock')).ino;
  await expect(openRuntimeControl(runtime, async () => {}, () => {})).rejects.toThrow('Another backend');
  expect(fs.statSync(path.join(dir, 'control.sock')).ino).toBe(inode);
  expect((await command(dir, 'status')).phase).toBe('running');
});

test('a filesystem marker written by an operator is recognized by status and stays frozen after removal', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  fs.writeFileSync(runtime.markerPath, '{}');
  expect((await command(dir, 'status')).phase).toBe('frozen');
  fs.unlinkSync(runtime.markerPath);
  expect(runtime.isFrozen()).toBe(true);
});

test.each(['bad', '12', '1800001', '-1', '1000ms'])('invalid drain ceiling %s cannot become an unlimited wait', value => {
  expect(() => drainTimeout(value)).toThrow('Invalid FCM_DRAIN_TIMEOUT_MS');
});
