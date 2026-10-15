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

async function embed(mode) {
  return fixture('embed-stream-' + mode, async () => {
    const { fetchRemoteImage } = require(actual('services/embedAssetService.ts'));
    const started = deferred(), destroying = deferred(), sockets = new Set(), facts = { requests: 0, lookups: 0 };
    let serverResponse, incoming, clientRequest, releaseDestroy, operationDone = false, clocks = 0;
    const cancellation = mode.endsWith('close-held');
    const server = http.createServer((req, res) => {
      facts.requests++;
      if (req.url === '/final') { res.writeHead(200, { 'Content-Length': '3' }); res.end('abc'); return; }
      serverResponse = res;
      if (mode === 'redirect-held' || mode === 'redirect-deadline-close-held') {
        res.writeHead(302, { Location: 'https://fixture.example/final' }); res.write('redirect body held');
      } else if (mode === 'status-close-held') { res.writeHead(503); res.write('rejected body'); }
      else if (mode === 'encoding-close-held') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.write('rejected encoding'); }
      else if (mode === 'declared-size-close-held') { res.writeHead(200, { 'Content-Length': String(10 * 1024 * 1024 + 1) }); res.write('too large'); }
      else if (mode === 'chunk-size-close-held') { res.writeHead(200); res.write(Buffer.alloc(10 * 1024 * 1024 + 1)); }
      else { res.writeHead(200, { 'Content-Length': '3' }); res.write('a'); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const operation = runtime.run('accepted-embed-stream', () => fetchRemoteImage('https://fixture.example/start', {
      lookup: async () => {
        facts.lookups++;
        if (mode === 'rebound-close-held' && facts.lookups === 2) throw new Error('synthetic failed rebound');
        return [{ address: '93.184.216.34', family: 4 }];
      },
      ...(mode.includes('deadline') ? { now: () => clocks++ ? 14925 : 0 } : {}),
      request: (url, _options, callback) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url.pathname, agent: false }, res => {
          if (url.pathname === '/start') {
            incoming = res; facts.actualIncomingMessage = res instanceof http.IncomingMessage;
            if (cancellation) {
              // Hold a concrete instance's destruction callback, not a promise
              // descendant which would itself make an old broken helper green.
              const destroy = res._destroy;
              res._destroy = function (error, done) {
                facts.destroyRequested = true;
                releaseDestroy = () => { releaseDestroy = null; destroy.call(this, error, done); };
                destroying.resolve();
              };
            }
            res.once('end', () => { facts.responseEnded = true; });
            res.once('close', () => { facts.responseClosed = true; });
            started.resolve();
          }
          callback(res);
        });
        if (url.pathname === '/start') {
          clientRequest = req; facts.actualClientRequest = req instanceof http.ClientRequest;
          req.once('close', () => { facts.requestClosed = true; });
        }
        return req;
      },
    })).then(value => { facts.bytes = value.buffer.length; operationDone = true; }, error => { facts.error = true; facts.status = error.status; operationDone = true; });
    try {
      await started.promise;
      if (mode === 'peer-abort-close-held') { await pause(10); serverResponse.destroy(); }
      if (cancellation) await destroying.promise;
      else await pause(30);
      facts.held = summary(await runtime.drain({ timeoutMs: 40 }));
      facts.completedAtCheckpoint = operationDone;
      facts.responseEndedAtCheckpoint = incoming.readableEnded;
      facts.responseClosedAtCheckpoint = incoming.closed;
      facts.requestClosedAtCheckpoint = clientRequest.closed;
      facts.serverFinishedAtCheckpoint = serverResponse.writableFinished;
      if (releaseDestroy) releaseDestroy();
      if (!cancellation) serverResponse.end(mode === 'redirect-held' ? 'end' : 'bc');
      await operation;
      const final = await runtime.drain({ timeoutMs: 500, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
      return { facts, ...summary(final) };
    } finally {
      if (releaseDestroy) releaseDestroy();
      clientRequest?.destroy(); serverResponse?.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function github(mode) {
  return fixture('github-native-' + mode, async () => {
    const service = require(actual('services/githubService.ts'));
    const facts = { nativeFetch: true, tls: true, requests: [], unlinkCalls: 0, threadDeleteCalls: 0 }, sockets = new Set(), bodyStarted = deferred();
    let releaseBody, completed = false, heldResponse = false;
    const malformed = mode.endsWith('malformed');
    const payload = malformed ? '{"data":' : mode.endsWith('missing-data') ? '{}'
      : mode.endsWith('missing-mutation') ? '{"data":{}}'
      : mode.endsWith('missing-field') ? '{"data":{"deleteIssue":{}}}'
      : mode.endsWith('graphql-error') || mode.startsWith('ticket-forbidden') ? JSON.stringify({ data: { deleteIssue: null }, errors: [{ type: mode.endsWith('graphql-error') ? 'INTERNAL' : 'FORBIDDEN', path: ['deleteIssue'], message: 'private fixture response must not be journaled' }] })
      : '{"data":{"deleteIssue":{"clientMutationId":null}}}';
    const server = https.createServer({ key: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_KEY), cert: fs.readFileSync(process.env.RUNTIME_FIXTURE_TLS_CERT) }, (req, res) => {
      facts.requests.push({ method: req.method, path: req.url });
      req.resume(); req.once('end', () => {
        const steam = mode.startsWith('steam-'), mirror = mode.startsWith('mirror-'), lookup = req.url.includes('/releases/tags/');
        const body = steam ? 'is_valid:true\n' : mirror ? '{"id":17}' : req.url === '/graphql' ? payload : mode.endsWith('close-malformed') ? '{"number":' : mode.endsWith('close-missing') ? '{}' : '{"number":17,"state":"closed"}';
        const hold = !heldResponse && (mode === 'steam-refused-body-held'
          || mode === 'mirror-lookup404-body-held' && lookup
          || mode === 'mirror-lookup-refused-body-held' && lookup
          || mode === 'mirror-mutation-refused-body-held' && !lookup);
        const refused = hold && (mode === 'mirror-lookup-refused-body-held' || mode === 'mirror-mutation-refused-body-held');
        const status = mode === 'steam-refused-body-held' ? 403 : refused ? 503 : mirror && lookup && !heldResponse && mode !== 'mirror-update' ? 404 : 200;
        res.writeHead(status, { 'Content-Type': steam ? 'text/plain' : 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
        if (hold) { heldResponse = true; res.write(body.slice(0, 3)); releaseBody = () => { releaseBody = null; res.end(body.slice(3)); }; bodyStarted.resolve(); }
        else res.end(body);
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolve); });
    try {
      if (mode.startsWith('steam-') || mode.startsWith('mirror-')) {
        process.env.GITHUB_RELEASE_TOKEN = 'fixture-only-mirror-token'; process.env.GITHUB_OWNER = 'fixture-owner'; process.env.GITHUB_REPO = 'fixture-repo';
        const operation = runtime.run('accepted-native-provider', async () => {
          if (mode.startsWith('steam-')) facts.providerAccepted = await require(actual('services/steamAuthService.ts')).validateSteamAssertion({ 'openid.claimed_id': 'fixture-assertion' });
          else await require(actual('services/githubReleaseService.ts')).createGitHubRelease('0.0.1-fixture', 'synthetic fixture notes');
          completed = true;
        });
        if (mode.endsWith('body-held')) { await bodyStarted.promise; facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed; releaseBody(); }
        await operation; facts.returned = completed;
      } else if (mode.startsWith('ticket-')) {
        prisma = { githubIssueThread: {
          findUnique: async () => ({ issueNumber: 17, issueNodeId: 'I_fixture_17', discordThreadId: '123456789012345678' }),
          deleteMany: async () => { facts.unlinkCalls++; return { count: 1 }; },
        } };
        const client = new EventEmitter();
        require(actual('services/ticketService.ts')).register(client);
        const interaction = { customId: 'ght:delconfirm:17', isButton: () => true, memberPermissions: { has: () => true }, user: { id: '123456789012345679' },
          channel: { id: '123456789012345678', isThread: () => true, delete: async () => { facts.threadDeleteCalls++; } },
          deferReply: async () => { interaction.deferred = true; }, editReply: async payload => { facts.reply = payload.content; }, reply: async () => {} };
        await runtime.run('accepted-ticket-deletion', () => client.listeners('interactionCreate')[0](interaction));
      } else {
        await runtime.run('accepted-github-deletion', async () => {
          try { await service.deleteIssue('I_fixture_17'); facts.returned = true; }
          catch (error) { facts.rejected = true; facts.errorClass = error.constructor.name; }
        });
      }
      // Observe the real native-fetch descendants, including a valid response.
      // A bounded observation is not a claim that an internal promise leaks forever.
      facts.after500ms = summary(await runtime.drain({ timeoutMs: 500 }));
      const started = Date.now();
      const final = await runtime.drain({ timeoutMs: 5000, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
      facts.finalObservationMs = Date.now() - started;
      return { facts, ...summary(final) };
    } finally {
      releaseBody?.();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function nativeSdk(mode) {
  return fixture('native-fetch-' + mode, async () => {
    const helper = actual('runtime/nativeFetch.ts');
    const begin = fs.existsSync(helper) ? require(helper).beginRuntimeFetch : global.fetch;
    const facts = { nativeFetch: true, requests: 0 }, entered = deferred(), callback = deferred(), gate = deferred(), transportClosed = deferred(), sockets = new Set();
    let releaseServer, completed = false;
    const server = http.createServer((req, res) => {
      facts.requests++; facts.method = req.method; facts.contentType = req.headers['content-type'];
      res.once('finish', () => { facts.responseFinished = true; }); res.once('close', () => { facts.responseClosed = true; });
      releaseServer = () => req.resume();
      req.once('end', () => {
        facts.requestEnded = true;
        res.writeHead(mode.endsWith('http-error') ? 503 : 200, { 'Content-Type': 'application/json', Connection: 'close' });
        if (mode.endsWith('body-held') || mode.endsWith('aborted')) {
          res.write('{"ok":'); releaseServer = () => res.end('true}'); entered.resolve();
          if (mode.endsWith('aborted')) setImmediate(() => res.destroy());
        } else { res.end('{"ok":true}'); entered.resolve(); }
      });
      if (mode.endsWith('headers-held')) { req.pause(); entered.resolve(); } else req.resume();
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); if (!sockets.size) transportClosed.resolve(); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const operation = runtime.required('native-fetch:accepted-result', async () => {
      const input = 'http://127.0.0.1:' + server.address().port;
      const body = mode.startsWith('form-') ? new URLSearchParams({ code: 'fixture-code', grant_type: 'authorization_code' }) : '{"input":"synthetic"}';
      const headers = {};
      if (mode === 'json-preparation-held') Object.defineProperty(headers, 'X-Fixture', { enumerable: true, get() {
        facts.preparationEntered = true; void gate.promise.then(() => { facts.preparationDone = true; }); return 'prepared';
      } });
      const response = await begin(input, mode.startsWith('get-') ? undefined : { method: 'POST', body, headers });
      facts.headersReturned = true;
      if (!response.ok) { await response.text(); throw new Error('Fixture upstream refusal'); }
      const value = await response.json(); facts.parsed = value.ok === true;
      if (mode.endsWith('callback-held')) { callback.resolve(); await gate.promise; facts.callbackDone = true; }
    }, { stage: 'native-fetch-result-unconfirmed' }).then(() => { facts.returned = true; completed = true; }, () => { facts.rejected = true; completed = true; });
    try {
      if (mode.endsWith('headers-held') || mode.endsWith('body-held')) {
        await entered.promise;
        facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed;
        releaseServer();
      } else if (mode.endsWith('callback-held')) {
        await callback.promise; facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed; gate.resolve();
      } else if (mode === 'json-preparation-held') {
        await operation; facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.preparationDoneAtCheckpoint = Boolean(facts.preparationDone); gate.resolve();
      }
      await operation;
      // Body consumption and server-side TCP close are distinct notifications.
      // Observe this fixture's actual Connection:close before final facts;
      // the held-work checkpoints above occur before any release/teardown.
      await transportClosed.promise;
      const final = await runtime.drain({ timeoutMs: 500, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
      facts.openServerSockets = sockets.size;
      return { facts, ...summary(final) };
    } finally { gate.resolve(); releaseServer?.(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
}

const embedModes = ['redirect-held', 'success-held', 'status-close-held', 'encoding-close-held', 'declared-size-close-held', 'chunk-size-close-held', 'peer-abort-close-held', 'rebound-close-held', 'deadline-close-held', 'redirect-deadline-close-held'];
const githubModes = ['valid', 'malformed', 'missing-data', 'missing-mutation', 'missing-field', 'graphql-error', 'ticket-malformed', 'ticket-missing-mutation', 'ticket-valid', 'ticket-forbidden', 'ticket-forbidden-close-malformed', 'ticket-forbidden-close-missing', 'steam-success', 'steam-refused-body-held', 'mirror-create', 'mirror-update', 'mirror-lookup404-body-held', 'mirror-lookup-refused-body-held', 'mirror-mutation-refused-body-held'];
const nativeModes = ['json-success', 'form-success', 'json-headers-held', 'form-headers-held', 'json-body-held', 'form-body-held', 'json-callback-held', 'form-callback-held', 'json-http-error', 'form-http-error', 'json-aborted', 'form-aborted', 'get-body-held', 'json-preparation-held'];
(async () => {
  const args = process.argv.slice(2), results = [];
  if (args.includes('--native-sdk')) {
    for (const mode of nativeModes) if (args.length === 1 || args.includes(mode)) results.push(await nativeSdk(mode));
  } else if (!args.includes('--github')) {
    for (const mode of embedModes) if (!args.length || args.includes(mode)) results.push(await embed(mode));
  } else {
    for (const mode of githubModes) if (args.length === 1 || args.includes(mode)) results.push(await github(mode));
  }
  const files = ['runtime/coordinator.ts', 'services/embedAssetService.ts', 'services/githubService.ts', 'services/ticketService.ts', 'services/steamAuthService.ts', 'services/githubReleaseService.ts'];
  if (fs.existsSync(actual('runtime/nativeFetch.ts'))) files.push('runtime/nativeFetch.ts');
  const sourceHashes = Object.fromEntries(files.map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(actual(relative))).digest('hex')]));
  console.log(JSON.stringify({ node: process.version, compiled, sourceHashes, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
