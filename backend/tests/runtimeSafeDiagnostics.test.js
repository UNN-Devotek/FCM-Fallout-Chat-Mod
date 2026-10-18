const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const net = require('node:net');
const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const { openRuntimeControl } = require('../src/runtime/control');
const SECRET = 'synthetic-private-interaction-token SQL INSERT synthetic-private-body';
let dir, runtime, servers;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-safe-diagnostic-')); runtime = new RuntimeCoordinator(dir); servers = []; });
afterEach(async () => { for (const s of servers) await new Promise(resolve => s.close(resolve)); runtime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true }); });
function safe(value) { expect(JSON.stringify(value)).not.toContain('synthetic-private'); expect(JSON.stringify(value)).not.toContain('SQL INSERT'); }
const command = action => new Promise((resolve, reject) => { const socket = net.createConnection(path.join(dir, 'control.sock')); let text = ''; socket.on('connect', () => socket.write(JSON.stringify({ action }) + '\n')); socket.on('data', chunk => text += chunk); socket.on('end', () => resolve(JSON.parse(text))); socket.on('error', reject); });
test('required callers retain original errors while journal, status, CLI and reload contain only safe classification and IDs', async () => {
  const error = Object.assign(new Error(SECRET), { code: 'ECONNRESET', sql: SECRET });
  await expect(runtime.required('fixture:required', async () => { throw error; }, { userId: 'fixture-user', stage: 'write-unconfirmed', token: SECRET, body: SECRET, url: SECRET })).rejects.toBe(error);
  safe(runtime.snapshot()); expect(runtime.snapshot().failures[0]).toMatchObject({ message: 'Required effect failed', errorCode: 'ECONNRESET', evidence: { userId: 'fixture-user', stage: 'write-unconfirmed' } });
  safe(fs.readFileSync(runtime.failuresPath, 'utf8')); servers.push(await openRuntimeControl(runtime, async () => {}, () => {})); safe(await command('status'));
  const loaded = new RuntimeCoordinator(dir); try { safe(loaded.snapshot()); expect(loaded.isFrozen()).toBe(true); } finally { loaded.disposeForTests(); }
});
test('legacy journals sanitize on reload without silently clearing failure disposition', () => {
  fs.writeFileSync(runtime.failuresPath, JSON.stringify({ id: 'fixture-id', label: 'fixture:legacy', at: new Date().toISOString(), message: SECRET, evidence: { userId: 'fixture-user', stage: 'write-unconfirmed', route: '/webhooks/123/' + SECRET } }) + '\n');
  const loaded = new RuntimeCoordinator(dir); try { safe(loaded.snapshot()); expect(loaded.snapshot().failures).toHaveLength(1); expect(loaded.isFrozen()).toBe(true); } finally { loaded.disposeForTests(); }
});
test('checkpoint participant and drain exceptions never expose raw SDK failure descriptions', async () => {
  runtime.registerParticipant('fixture-queue', { inspect: async () => ({ pending: 0, failures: [{ canonicalId: 'fixture-id', failedReason: SECRET }], detail: { counts: { failed: 1 } } }) });
  expect((await runtime.drain({ timeoutMs: 100 })).phase).toBe('failed'); safe(fs.readFileSync(runtime.checkpointPath, 'utf8'));
});
test('operator command exception returns a fixed diagnostic without private payload', async () => {
  runtime.drain = async () => { throw Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' }); };
  servers.push(await openRuntimeControl(runtime, async () => {}, () => {})); const result = await command('drain'); safe(result); expect(result.errorCode).toBe('ETIMEDOUT');
});
