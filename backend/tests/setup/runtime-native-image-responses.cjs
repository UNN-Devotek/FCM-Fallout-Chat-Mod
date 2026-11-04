const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const mode = process.argv[2];
const source = process.env.RUNTIME_FIXTURE_SOURCE || '/app/dist';
if (mode === '--all') {
  const os = require('node:os'), { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-images-'));
  const results = [];
  try {
    for (const label of ['avatar-nonok', 'image-nonok', 'image-mime', 'avatar-success', 'image-success', 'avatar-held', 'image-held', 'avatar-refusal-live', 'image-refusal-live', 'image-mime-live', 'avatar-refusal-finite', 'image-refusal-finite', 'image-mime-finite']) {
      const output = path.join(directory, label + '.json');
      const child = spawnSync(process.execPath, [__filename, label], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RUNTIME_FIXTURE_OUTPUT: output } });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.status !== 0 || !fs.existsSync(output)) throw Error('Native image child failed ' + label + ' ' + child.status);
      results.push(JSON.parse(fs.readFileSync(output, 'utf8')));
    }
    const result = { node: process.version, results };
    if (process.env.RUNTIME_FIXTURE_OUTPUT) fs.writeFileSync(process.env.RUNTIME_FIXTURE_OUTPUT, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} else {
process.env.NODE_ENV = 'test';
process.env.FCM_RUNTIME_CONTROL_DIR = '/tmp/native-response-control';
process.env.MINIO_ENDPOINT = 'http://127.0.0.1:19287';
process.env.MINIO_ROOT_USER = 'synthetic';
process.env.MINIO_ROOT_PASSWORD = 'synthetic-only';
process.env.MINIO_BUCKET = 'synthetic-native-response';
const sockets = new Set();
const facts = { mode, node: process.version, s3Requests: [], requests: [], physicalSocketCloses: 0 };
let response, release;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = s => ({ phase: s.phase, active: s.active, failures: s.failures, ingressClosed: s.ingressClosed });
const s3Server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    facts.s3Requests.push({ method: req.method, path: req.url, signed: /^AWS4-HMAC-SHA256 /.test(req.headers.authorization || ''), bytes: Buffer.concat(chunks).length });
    res.writeHead(200, { 'Content-Length': '0', Connection: 'close' });
    res.end();
  });
});
const tls = https.createServer({ key: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_KEY), cert: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_CERT) }, (req, res) => {
  facts.requests.push({ method: req.method, path: req.url, host: req.headers.host });
  response = res;
  res.on('finish', () => { facts.serverFinished = true; });
  res.on('close', () => { facts.serverClosed = true; });
  const ok = mode.endsWith('-success') || mode.includes('-mime') || mode.endsWith('-held');
  const contentType = mode.includes('-mime') ? 'text/html' : 'image/png';
  res.writeHead(ok ? 200 : 403, { 'Content-Length': '100', 'Content-Type': contentType, Connection: 'close' });
  if (mode.endsWith('-finite')) res.end('x'.repeat(100));
  else res.write('x');
  release = () => { if (!res.destroyed && !res.writableEnded) res.end('x'.repeat(99)); };
  if (!mode.endsWith('-held') && !mode.endsWith('-live')) setTimeout(release, 80);
});
for (const server of [s3Server, tls]) server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => { sockets.delete(socket); facts.physicalSocketCloses++; });
});
(async () => {
  await Promise.all([new Promise(r => s3Server.listen(19287, '127.0.0.1', r)), new Promise(r => tls.listen(443, '127.0.0.1', r))]);
  const { runtime } = require(path.join(source, 'runtime'));
  const storage = require(path.join(source, 'config/storage'));
  const asset = mode.startsWith('avatar') ? require(path.join(source, 'services/avatarService')) : require(path.join(source, 'lib/imageStorage'));
  try {
    const operation = runtime.run('accepted-native-response-' + mode, async () => {
      if (mode.startsWith('avatar')) return asset.captureAvatar('fixture-user', 'fixture-hash');
      const result = await asset.fetchRemoteImage('https://static.wikia.nocookie.net/fixture.png', 1024, 1000);
      if (result && mode.endsWith('-success')) await asset.putToMinio('wiki-images/fixture.png', result.buf, result.contentType);
      return result ? { bytes: result.buf.length, contentType: result.contentType } : null;
    });
    if (mode.endsWith('-held')) {
      while (!response) await pause(5);
      facts.held = summary(await runtime.drain({ timeoutMs: 100, close: true, closeIngress: async () => {} }));
      facts.serverOpenAtHeld = !response.writableEnded && !response.destroyed;
      release();
    }
    facts.result = await operation;
    await pause(150);
    facts.beforeDrain = summary(runtime.snapshot());
    facts.serverFinishedBeforeDrain = response.writableFinished;
    facts.serverClosedBeforeDrain = response.destroyed;
    facts.socketsBeforeDrain = sockets.size;
    facts.physicalSocketClosesBeforeDrain = facts.physicalSocketCloses;
    facts.final = summary(await runtime.drain({ timeoutMs: 2000, close: true, closeIngress: async () => {} }));
    facts.hashes = Object.fromEntries(['services/avatarService.js', 'lib/imageStorage.js', 'runtime/coordinator.js', 'config/storage.js'].map(rel => [rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, rel))).digest('hex')]));
  } finally {
    storage.s3.destroy();
    const socketClosures = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    await Promise.all([new Promise(r => tls.close(r)), new Promise(r => s3Server.close(r)), ...socketClosures]);
    facts.terminalSockets = sockets.size;
    runtime.disposeForTests();
    fs.rmSync('/tmp/native-response-control', { recursive: true, force: true });
    fs.writeFileSync(process.env.RUNTIME_FIXTURE_OUTPUT || '/tmp/native-response-result.json', JSON.stringify(facts, null, 2) + '\n');
    process.stdout.write(JSON.stringify(facts) + '\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
}
