const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { openRuntimeControl, drainTimeout } = require('../src/runtime/control');
const { runtimeControlEndpoint, runtimeControlToken } = require('../src/runtime/platform');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
let dir, runtime, servers;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-control-')); runtime = new RuntimeCoordinator(dir); servers = []; });
afterEach(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  runtime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true });
});
const command = (dir, action, token = runtimeControlToken(dir)) => new Promise((resolve, reject) => {
  const socket = net.createConnection(runtimeControlEndpoint(dir)); let text = '';
  socket.on('connect', () => socket.write(`${JSON.stringify({ action, ...(token ? { token } : {}) })}\n`));
  socket.on('data', data => { text += data.toString(); });
  socket.on('end', () => resolve(JSON.parse(text))); socket.on('error', reject);
});

test('local control is permission restricted, refuses resume, and supports freeze/drain without a public endpoint', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  if (process.platform !== 'win32') {
    expect(fs.statSync(path.join(dir, 'control.sock')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  } else {
    expect(runtimeControlEndpoint(dir)).toMatch(/^\\\\\.\\pipe\\fcm-runtime-[a-f0-9]{64}$/);
    expect((await command(dir, 'freeze', '')).error).toBe('Unauthorized command');
    expect((await command(dir, 'freeze', '0'.repeat(64))).error).toBe('Unauthorized command');
    expect((await command(dir, 'freeze', 'é'.repeat(64))).error).toBe('Unauthorized command');
    expect(runtime.isFrozen()).toBe(false);
  }
  expect((await command(dir, 'status')).phase).toBe('running');
  expect((await command(dir, 'resume')).error).toBe('Unknown command');
  expect((await command(dir, 'freeze')).frozen).toBe(true);
  expect((await command(dir, 'drain')).phase).toBe('drained');
});

test('another live backend control socket is never unlinked or replaced', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  const inode = process.platform === 'win32' ? null : fs.statSync(path.join(dir, 'control.sock')).ino;
  await expect(openRuntimeControl(runtime, async () => {}, () => {})).rejects.toThrow('Another backend');
  if (inode !== null) expect(fs.statSync(path.join(dir, 'control.sock')).ino).toBe(inode);
  expect((await command(dir, 'status')).phase).toBe('running');
});

test('the compiled operator CLI uses the same private endpoint and never echoes credentials', async () => {
  const server = await openRuntimeControl(runtime, async () => {}, () => {}); servers.push(server);
  const child = spawn(process.execPath, [path.resolve('dist/runtime/cli.js'), 'status'], {
    env: { ...process.env, FCM_RUNTIME_CONTROL_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { errors += data.toString(); });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  expect({ code, errors: errors.includes('Error:') }).toEqual({ code: 0, errors: false });
  expect(JSON.parse(output).phase).toBe('running');
  const token = runtimeControlToken(dir);
  if (token) expect(output).not.toContain(token);
});

(process.platform === 'win32' ? test : test.skip)('a replacement Windows control directory cannot reuse an old ACL proof for public evidence', () => {
  runtime.disposeForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const evidence = path.join(dir, 'maintenance.json');
  fs.writeFileSync(evidence, '{"fixture":"retained"}');
  execFileSync('icacls.exe', [evidence, '/grant', '*S-1-1-0:R'], { stdio: 'ignore' });
  expect(() => new RuntimeCoordinator(dir)).toThrow('ACL validation failed');
  expect(fs.readFileSync(evidence, 'utf8')).toBe('{"fixture":"retained"}');
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
