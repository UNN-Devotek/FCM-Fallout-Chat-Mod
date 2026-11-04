// Actual Node HTTP response lifetimes. The same fixture runs source in CI and dist in the supported image.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const backend = path.resolve(process.env.RUNTIME_FIXTURE_BACKEND || path.join(__dirname, '../..'));
const source = path.resolve(process.env.RUNTIME_FIXTURE_SOURCE || path.join(backend, 'src'));
const sdk = Module.createRequire(path.join(backend, 'package.json'));
const compiled = !fs.existsSync(path.join(source, 'runtime/coordinator.ts'));
if (!compiled) {
  const esbuild = sdk('esbuild');
  Module._extensions['.ts'] = (module, filename) => module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code, filename);
}
const actual = relative => path.join(source, compiled ? relative.replace(/\.ts$/, '.js') : relative);
let runtime, prisma;
const runtimeBinding = { get runtime() { return runtime; } };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const originalLoad = Module._load;
Module._load = function (name, parent, main) {
  if (parent?.filename.startsWith(source + path.sep)) {
    if (name.endsWith('/config/environment')) return { __esModule: true, default: { NODE_ENV: 'test', GITHUB_PAT: 'fixture-pat', GITHUB_OWNER: 'fixture-owner', GITHUB_REPO: 'fixture-repo' } };
    if (name.endsWith('/config/prisma')) return { __esModule: true, get default() { return prisma; } };
    if (name.endsWith('/config/logger')) return { __esModule: true, default: logger };
    if (name.endsWith('/config/storage')) return {};
    if (name.endsWith('/services/playerReportService') || name === './playerReportService') return { __esModule: true, default: {} };
    if (name.endsWith('/runtime')) return runtimeBinding;
    if (!name.startsWith('.') && !path.isAbsolute(name)) return originalLoad.call(this, sdk.resolve(name), parent, main);
  }
  return originalLoad.call(this, name, parent, main);
};
const { RuntimeCoordinator } = require(actual('runtime/coordinator.ts'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const summary = state => ({ phase: state.phase, ingressClosed: state.ingressClosed, active: state.active, failures: state.failures });
async function fixture(label, invoke) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-round8-'));
  runtime = new RuntimeCoordinator(path.join(directory, 'control'));
  try { return { label, ...await invoke() }; }
  finally { runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function metadata(mode) {
  return fixture('mcp-read-' + mode, async () => {
    const { fetchClientMetadataJson } = require(actual('services/mcpClientMetadataService.ts'));
    const started = deferred(), destroying = deferred(), sockets = new Set(), facts = {};
    let incoming, request, serverResponse, releaseDestroy, completed = false;
    const canceled = mode.endsWith('close-held');
    const server = http.createServer((req, res) => {
      serverResponse = res;
      if (mode === 'request-error-close-held') { req.socket.destroy(); return; }
      res.writeHead(mode === 'redirect-close-held' ? 302 : mode === 'status-close-held' ? 503 : 200,
        { 'Content-Type': mode === 'media-close-held' ? 'text/html' : 'application/json', Connection: 'close' });
      res.write(mode === 'size-close-held' ? Buffer.alloc(65537, 120) : '{"fixture":');
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const operation = runtime.run('accepted-mcp-read', () => fetchClientMetadataJson(new URL('https://metadata.example/client.json'), {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request: (_url, options, callback) => {
        facts.pinnedLookup = typeof options.lookup === 'function';
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/client.json', agent: false }, res => {
          incoming = res; facts.actualResponse = res instanceof http.IncomingMessage;
          if (canceled && mode !== 'request-error-close-held') {
            const destroy = res._destroy;
            res._destroy = function (error, done) {
              facts.destroyRequested = true; releaseDestroy = () => { releaseDestroy = null; destroy.call(this, error, done); }; destroying.resolve();
            };
          }
          res.once('end', () => { facts.responseEnded = true; }); res.once('close', () => { facts.responseClosed = true; });
          callback(res); started.resolve();
        });
        request = req; facts.actualRequest = req instanceof http.ClientRequest;
        if (mode === 'request-error-close-held') {
          req.once('socket', socket => {
            const destroy = socket._destroy;
            socket._destroy = function (error, done) { facts.destroyRequested = true; releaseDestroy = () => { releaseDestroy = null; destroy.call(this, error, done); }; started.resolve(); destroying.resolve(); };
          });
        }
        req.once('close', () => { facts.requestClosed = true; });
        return req;
      },
    })).then(value => { facts.value = value; completed = true; }, error => { facts.rejected = true; facts.errorClass = error.constructor.name; completed = true; });
    try {
      await started.promise;
      if (mode === 'peer-abort-close-held') serverResponse.destroy();
      if (['size-close-held', 'peer-abort-close-held', 'timeout-close-held', 'request-error-close-held'].includes(mode)) await destroying.promise;
      else await pause(25);
      facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed;
      facts.responseClosedAtCheckpoint = Boolean(incoming?.closed); facts.requestClosedAtCheckpoint = request.closed;
      if (releaseDestroy) releaseDestroy();
      if (!incoming?.destroyed && serverResponse) serverResponse.end(mode === 'json-malformed-held' ? 'broken' : 'true}');
      if (canceled && !facts.destroyRequested) { await destroying.promise; releaseDestroy?.(); }
      await operation;
      if (incoming && !incoming.readableEnded && !incoming.closed) await new Promise(resolve => incoming.once('close', resolve));
      const final = await runtime.drain({ timeoutMs: 500, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
      return { facts, ...summary(final) };
    } finally { releaseDestroy?.(); request?.destroy(); serverResponse?.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
}
async function restCase(item) {
  return fixture('github-rest-' + item.label, async () => {
    const service = require(actual('services/githubService.ts')), facts = { nativeFetch: true, tls: true, requests: [] }, sockets = new Set();
    const server = https.createServer({ key: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_KEY), cert: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_CERT) }, (req, res) => {
      facts.requests.push({ method: req.method, path: req.url, status: item.status }); req.resume(); req.once('end', () => {
        res.writeHead(item.status, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(typeof item.body === 'string' ? item.body : JSON.stringify(item.body));
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolve); });
    try {
      await runtime.run('accepted-github-rest', async () => {
        try { facts.value = await service[item.method](...item.args); facts.returned = true; }
        catch (error) { facts.rejected = true; facts.errorClass = error.constructor.name; }
      });
      const final = await runtime.drain({ timeoutMs: 500, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
      return { facts, ...summary(final) };
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
}
const metadataModes = ['redirect-close-held', 'status-close-held', 'media-close-held', 'success-held', 'json-malformed-held', 'size-close-held', 'peer-abort-close-held', 'timeout-close-held', 'request-error-close-held'];
(async () => {
  const args = process.argv.slice(2), results = [];
  if (args.includes('--github')) {
    for (const item of require('./github-rest-outcomes.cjs').cases) if (args.length === 1 || args.includes(item.label)) results.push(await restCase(item));
  } else for (const mode of metadataModes) if (!args.length || args.includes(mode)) results.push(await metadata(mode));
  const sourceHashes = Object.fromEntries(['runtime/coordinator.ts', 'services/mcpClientMetadataService.ts', 'services/githubService.ts', 'runtime/nativeFetch.ts'].map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(actual(relative))).digest('hex')]));
  console.log(JSON.stringify({ node: process.version, compiled, sourceHashes, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
