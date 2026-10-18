// The same fixture executes source in required CI and actual dist in the supported image.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const http = require('node:http'), { EventEmitter } = require('node:events'), { execFile } = require('node:child_process');
const { createHook } = require('node:async_hooks');
const backend = path.resolve(process.env.RUNTIME_FIXTURE_BACKEND || path.join(__dirname, '../..'));
const source = path.resolve(process.env.RUNTIME_FIXTURE_SOURCE || path.join(backend, 'src'));
const sdk = Module.createRequire(path.join(backend, 'package.json')), compiled = !fs.existsSync(path.join(source, 'runtime/coordinator.ts'));
if (!compiled) {
  const esbuild = sdk('esbuild');
  Module._extensions['.ts'] = (module, filename) => module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code, filename);
}
const actual = relative => path.join(source, compiled ? relative.replace(/\.ts$/, '.js') : relative);
const serverSource = () => fs.readFileSync(process.env.RUNTIME_FIXTURE_SERVER_SOURCE || path.join(backend, 'src/server.ts'), 'utf8');
const originalLoad = Module._load;
let runtime;
Module._load = function (name, parent, main) {
  if (parent?.filename.startsWith(source + path.sep)) {
    if (name.endsWith('/config/environment')) return { __esModule: true, default: { NODE_ENV: 'test', FCM_DRAIN_TIMEOUT_MS: 500 } };
    if (name.endsWith('/config/prisma')) return { __esModule: true, default: {} };
    if (name.endsWith('/config/storage')) return {};
    if (name.endsWith('/runtime')) return { runtime };
    if (!name.startsWith('.') && !path.isAbsolute(name)) return originalLoad.call(this, sdk.resolve(name), parent, main);
  }
  return originalLoad.call(this, name, parent, main);
};
const { RuntimeCoordinator } = require(actual('runtime/coordinator.ts'));
const { accountHttpIngress, instrumentHttpHandlers } = require(actual('runtime/ingress.ts'));
const express = sdk('express'), multer = sdk('multer');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const listen = server => new Promise(resolve => server.once('listening', resolve));
async function fixture(label, run) {
  if (process.env.RUNTIME_ROUND7_TRACE) process.stderr.write('start ' + label + '\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-round7-'));
  runtime = new RuntimeCoordinator(path.join(directory, 'control'));
  try { const value = { label, ...await run(runtime, directory) }; if (process.env.RUNTIME_ROUND7_TRACE) process.stderr.write('done ' + label + '\n'); return value; }
  finally { runtime.disposeForTests(); fs.chmodSync(directory, 0o700); fs.rmSync(directory, { recursive: true, force: true }); }
}
const result = snapshot => ({ phase: snapshot.phase, active: snapshot.active, failures: snapshot.failures, fences: snapshot.fences, closed: snapshot.closedParticipants });

async function embed(mode) {
  return fixture('embed-' + mode, async runtime => {
    const { fetchRemoteImage } = require(actual('services/embedAssetService.ts'));
    const facts = { lookups: 0, requests: 0 }, gate = deferred(), readStarted = deferred();
    let clocks = 0;
    const lookup = async () => {
      facts.lookups++;
      if (mode === 'held' || mode === 'timeout' || (mode.startsWith('rebound-') && facts.lookups === 2)) { readStarted.resolve(); await gate.promise; }
      if (mode === 'error') throw new Error('private-dns-error');
      return [{ address: '8.8.8.8', family: 4 }];
    };
    const request = (_url, _options, callback) => {
      facts.requests++; const req = new EventEmitter(); let incoming;
      if (mode === 'constructor-error') throw new Error('Fixture request constructor error');
      req.end = () => setImmediate(async () => {
        if (mode === 'request-held') { readStarted.resolve(); await gate.promise; }
        if (mode === 'request-error') { req.emit('error', new Error('Fixture request error')); req.emit('close'); return; }
        const response = new EventEmitter(); response.statusCode = 200; response.headers = { 'content-length': '3' };
        incoming = response;
        response.destroy = error => {
          if (response.destroyed) return response; response.destroyed = true;
          setImmediate(() => { if (error) response.emit('error', error); response.emit('close'); }); return response;
        };
        response.resume = () => response;
        callback(response);
        const body = () => setImmediate(() => { response.emit('data', Buffer.from('abc')); response.emit('end'); response.emit('close'); req.emit('close'); });
        if (mode.startsWith('rebound-')) gate.promise.then(body); else body();
      });
      req.destroy = error => {
        if (req.destroyed) return req; req.destroyed = true;
        setImmediate(() => { if (error) req.emit('error', error); incoming?.destroy(error); req.emit('close'); }); return req;
      };
      return req;
    };
    const operation = runtime.run('accepted-embed-import', () => fetchRemoteImage('https://fixture.example/image.png', {
      lookup, request, now: mode.endsWith('timeout') ? () => clocks++ ? 14975 : 0 : Date.now,
    })).then(value => { facts.bytes = value.body?.length ?? value.buffer?.length; }, error => { facts.status = error.status; });
    try {
      if (['held', 'request-held', 'rebound-held'].includes(mode)) { await readStarted.promise; facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve(); }
      if (mode.endsWith('timeout')) { await operation; facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve(); }
      await operation; await pause(10);
      return { facts, ...result(await runtime.drain({ timeoutMs: 150, close: true, closeIngress: async () => {} })) };
    } finally { gate.resolve(); }
  });
}

async function staticRead(mode) {
  return fixture('static-' + mode, async (runtime, directory) => {
    const target = path.join(directory, 'fixture.bin');
    fs.writeFileSync(target, 'fixture-file');
    if (!mode.endsWith('success')) fs.truncateSync(target, 32 * 1024 * 1024);
    const app = express(), facts = {}, gate = deferred(), closed = deferred(), teardown = deferred();
    const handler = express.static(directory);
    const readModule = path.join(source, 'runtime', compiled ? 'fileReads.js' : 'fileReads.ts');
    const read = fs.existsSync(readModule) ? require(readModule) : null;
    const installed = read ? read.accountFileRead(handler, runtime) : handler;
    if (mode.startsWith('frozen-')) {
      runtime.freeze('fixture');
      const text = serverSource(), prefix = 'app.use(accountHttpIngress(runtime, ';
      const start = text.indexOf(prefix) + prefix.length, end = text.indexOf('\n}));', start);
      const callback = new Function('runtime', 'frozenDownloads', 'serveScript', 'getHealth', 'return ' + text.slice(start, end + 2))(
        runtime, installed, (() => {
          const prefix = 'const serveScript = ', scriptStart = text.indexOf(prefix) + prefix.length;
          const scriptEnd = text.indexOf("\napp.get('/install.sh'", scriptStart);
          const script = text.slice(scriptStart, scriptEnd).trim().replace(/;$/, '')
            .replace('name: string', 'name').replace('_req: Request, res: Response', '_req, res');
          return new Function('scriptCandidates', 'fs', 'runtime', 'sendFileRead', 'return ' + script)(() => [target], fs, runtime, read.sendFileRead);
        })(), () => { throw new Error('Unexpected health fixture'); });
      app.use(accountHttpIngress(runtime, callback));
    } else {
      app.use(accountHttpIngress(runtime));
      app.use('/downloads', mode.startsWith('sendfile-') && read
        ? (_req, res) => read.sendFileRead(res, mode === 'sendfile-missing-abort' ? target + '.missing' : target, runtime).catch(() => res.destroy()) : installed);
    }
    app.use((error, _req, res, _next) => { facts.error = error.code; if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    instrumentHttpHandlers(app, runtime);
    const server = app.listen(0, '127.0.0.1'); await listen(server);
    let client, stream;
    server.on('request', (_req, res) => {
      res.once('close', closed.resolve);
      res.on('pipe', incoming => {
        stream = incoming; facts.actualReadStream = incoming.constructor.name;
        incoming.once('close', () => { facts.streamClosed = incoming.closed; });
        if (mode.endsWith('held')) {
          const destroy = incoming._destroy;
          incoming._destroy = function (error, done) { teardown.resolve(); gate.promise.then(() => destroy.call(this, error, done)); };
        }
        if (mode === 'error') incoming.destroy(Object.assign(new Error('fixture read failed'), { code: 'EIO' }));
      });
      if (['preopen-abort', 'head-aborted', '304-aborted', 'sendfile-preopen-abort', 'sendfile-missing-abort', 'sendfile-preopen-held'].includes(mode)) res.destroy();
    });
    try {
      await new Promise((resolve, reject) => {
        client = http.get({ host: '127.0.0.1', port: server.address().port, path: mode.startsWith('frozen-script-') ? '/install.sh' : '/downloads/fixture.bin',
          method: mode.startsWith('head-') ? 'HEAD' : 'GET', headers: mode.startsWith('304-') ? { 'if-modified-since': new Date(Date.now() + 3600000).toUTCString() } : {},
        }, response => {
          facts.status = response.statusCode; facts.bytes = 0;
          response.on('data', chunk => { facts.bytes += chunk.length; if (!mode.endsWith('success')) { client.destroy(); resolve(); } });
          response.once('end', resolve);
          response.once('error', mode.endsWith('success') ? reject : resolve);
        }); client.on('error', mode.endsWith('success') ? reject : resolve);
      });
      await closed.promise;
      if (mode.endsWith('held')) { await teardown.promise; facts.held = result(await runtime.drain({ timeoutMs: 40 })); facts.closedWhileHeld = stream.closed; gate.resolve(); }
      await pause(20);
      return { facts, ...result(await runtime.drain({ timeoutMs: 150, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) })) };
    } finally { gate.resolve(); if (client) client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}

function releaseUpload(directory, configureStorage) {
    const text = serverSource();
  const snippet = text.slice(text.indexOf('const RELEASE_FILENAME_RE ='), text.indexOf("app.post('/admin/upload-release'"));
  const uploadModule = path.join(source, 'runtime', compiled ? 'diskUpload.js' : 'diskUpload.ts');
  const bindings = fs.existsSync(uploadModule) ? require(uploadModule) : {};
  return new Function('multer', 'path', 'downloadsDir', 'runtime', 'createRuntimeDiskUpload', snippet + '\nreturn releaseUpload;')(
    multer, path, directory, runtime, (options, runtime) => bindings.createRuntimeDiskUpload(options, runtime, configureStorage));
}
async function upload(mode) {
  return fixture('upload-' + mode, async (runtime, directory) => {
    const downloads = path.join(directory, 'downloads'); fs.mkdirSync(downloads);
    const filename = 'FalloutChatMod_Setup_v1.2.3.exe';
    if (mode.startsWith('replacement-')) fs.writeFileSync(path.join(downloads, filename), 'older-installer');
    const facts = {}, gate = deferred(), cleanup = deferred(), callbackEntered = deferred();
    const metadataEntered = deferred(), inputClosed = deferred(), errorObserved = deferred(), cleanupCompleted = deferred(), teardownReached = deferred();
    let metadataResume, writeResume, resultResume, captureMetadata = false, metadataHook;
    const canceledWrite = mode === 'write-abort-canceled', heldResultAbort = mode === 'cleanup-result-callback-abort', heldResultSuccess = mode === 'result-success-held';
    const configureStorage = heldResultAbort || heldResultSuccess ? storage => {
      const handle = storage._handleFile;
      storage._handleFile = function (req, file, done) {
        return handle.call(this, req, file, (error, info) => {
          facts.actualPipelineResultCalls = (facts.actualPipelineResultCalls || 0) + 1;
          facts.pipelineErrored = Boolean(error); facts.storageResultPending = true;
          resultResume = () => { facts.storageResultPending = false; resultResume = null; done(error, info); };
          callbackEntered.resolve();
        });
      };
    } : undefined;
    const uploader = releaseUpload(downloads, configureStorage);
    const storage = uploader.storage;
    if (mode.startsWith('metadata-') || canceledWrite || heldResultAbort || heldResultSuccess) {
      const handle = storage._handleFile;
      storage._handleFile = function (req, file, done) {
        file.stream.once('close', () => { facts.inputClosed = file.stream.closed; inputClosed.resolve(); });
        return handle.call(this, req, file, (...args) => { facts.storageCallbackCalls = (facts.storageCallbackCalls || 0) + 1; done(...args); });
      };
    }
    if (mode.startsWith('metadata-')) {
      const field = mode === 'metadata-destination-abort' ? 'getDestination' : 'getFilename';
      const original = storage[field];
      if (mode === 'metadata-lstat-abort') {
        // Hold only the actual native callback resource allocated by this exact
        // SDK filename/preflight invocation. No fs function/prototype is patched.
        metadataHook = createHook({ init(_id, type, _trigger, resource) {
          if (!captureMetadata || type !== 'FSREQCALLBACK') return;
          // init fires in FSReqCallback's constructor, before node:fs assigns
          // oncomplete. Intercept only that resource's subsequent assignment.
          Object.defineProperty(resource, 'oncomplete', { configurable: true, set(complete) {
            if (typeof complete !== 'function') throw new Error('Unsupported actual lstat callback resource');
            Object.defineProperty(this, 'oncomplete', { configurable: true, writable: true, value: function (...args) {
              facts.metadataPending = true; facts.actualMetadataResource = type;
              metadataResume = () => { facts.metadataPending = false; complete.apply(this, args); };
              metadataEntered.resolve();
            } });
          } });
        } }); metadataHook.enable();
        storage[field] = function (...args) { captureMetadata = true; try { return original.apply(this, args); } finally { captureMetadata = false; } };
      } else storage[field] = function (...args) {
        facts.metadataPending = true;
        metadataResume = () => { facts.metadataPending = false; original.apply(this, args); };
        metadataEntered.resolve();
      };
    }
    if (['cleanup-failure', 'cleanup-held', 'cleanup-callback-held', 'partial-cleanup-failure'].includes(mode) || canceledWrite || heldResultAbort) {
      const remove = storage._removeFile;
      storage._removeFile = function (req, file, done) {
        cleanup.resolve();
        if (mode.endsWith('cleanup-failure')) fs.chmodSync(downloads, 0o500);
        const invoke = () => remove.call(this, req, file, error => {
          fs.chmodSync(downloads, 0o700); facts.cleanupCode = error?.code;
          facts.cleanupCompleted = true; cleanupCompleted.resolve();
          if (mode === 'cleanup-callback-held') { callbackEntered.resolve(); gate.promise.then(() => done(error)); } else done(error);
        });
        if (mode === 'cleanup-held') gate.promise.then(invoke); else invoke();
      };
    }
    const writeReached = deferred();
    if (mode.includes('write-') || mode.startsWith('partial-') || ['replacement-partial', 'cleanup-stream-close-held', 'callback-held'].includes(mode) || heldResultAbort || heldResultSuccess) {
      const handle = storage._handleFile;
      storage._handleFile = function (req, file, done) {
        const pipe = file.stream.pipe;
        file.stream.pipe = function (output, options) {
          facts.actualWriteStream = output.constructor.name;
          output.once('finish', () => { facts.outputFinished = true; });
          output.once('error', () => { facts.outputErrored = true; });
          output.once('close', () => { facts.outputClosed = output.closed; });
          const write = output._write, destroy = output._destroy;
          if (canceledWrite) {
            output._write = function (chunk, encoding, callback) {
              write.call(this, chunk, encoding, error => { callback(error); writeReached.resolve(); });
            };
            output._destroy = function (error, callback) {
              writeResume = () => { writeResume = null; destroy.call(this, error, callback); }; teardownReached.resolve();
            };
          }
          if (heldResultAbort) output._write = function (chunk, encoding, callback) {
            write.call(this, chunk, encoding, error => { callback(error); writeReached.resolve(); });
          };
          if (mode === 'write-held') output._write = function (chunk, encoding, callback) { writeReached.resolve(); gate.promise.then(() => write.call(this, chunk, encoding, callback)); };
          if (['write-close-held', 'cleanup-stream-close-held'].includes(mode)) output._destroy = function (error, callback) { writeReached.resolve(); gate.promise.then(() => destroy.call(this, error, callback)); };
          if (mode.startsWith('partial-') || mode === 'replacement-partial') output._write = function (chunk, encoding, callback) {
            write.call(this, chunk.subarray(0, 5), encoding, error => callback(error || Object.assign(new Error('fixture partial write failure'), { code: 'EIO' })));
          };
          return pipe.call(this, output, options);
        };
        return handle.call(this, req, file, (error, info) => {
          done(error, info);
          if (mode === 'callback-held') { callbackEntered.resolve(); void (async () => { await gate.promise; facts.callbackCompleted = true; })(); }
        });
      };
    }
    if (mode === 'permission-refused') fs.chmodSync(downloads, 0o500);
    if (mode === 'size-limit') uploader.limits = { fileSize: 8 };
    const app = express(); app.use(accountHttpIngress(runtime));
    let finalHandler = async (req, res) => { facts.saved = req.file.size; res.json({ ok: true }); };
    if (mode === 'validation-cleanup-failure') {
      const text = serverSource(), prefix = "}, releaseUpload.single('file'), ";
      const start = text.indexOf(prefix) + prefix.length, end = text.indexOf('\n});', start);
      const handler = text.slice(start, end + 2).replace('req: Request, res: Response', 'req, res');
      const actualHandler = new Function('runtime', 'fs', 'path', 'downloadsDir', 'return ' + handler)(runtime, fs, path, downloads);
      finalHandler = (req, res) => { req.file.filename = '..'; return actualHandler(req, res); };
    }
    app.post('/fixture', uploader.single('file'), finalHandler);
    app.use(async (error, _req, res, _next) => { facts.error = error.code; facts.storageErrors = error.storageErrors?.map(value => value.code); errorObserved.resolve(); res.status(500).json({ error: true }); });
    instrumentHttpHandlers(app, runtime);
    const server = app.listen(0, '127.0.0.1'); await listen(server);
    const boundary = 'round7-fixture-boundary';
    const rejectedSecond = ['cleanup-success', 'cleanup-failure', 'cleanup-held', 'replacement-cleanup', 'cleanup-callback-held', 'cleanup-stream-close-held'].includes(mode);
    const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${mode === 'invalid-filename' ? 'invalid.exe' : filename}"\r\nContent-Type: application/octet-stream\r\n\r\nsynthetic-installer-bytes\r\n`;
    const body = Buffer.from(prefix +
      (rejectedSecond ? `--${boundary}\r\nContent-Disposition: form-data; name="extra"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nsecond-file\r\n` : '') + `--${boundary}--\r\n`);
    let client;
    const operation = new Promise((resolve, reject) => {
      client = http.request({ host: '127.0.0.1', port: server.address().port, path: '/fixture', method: 'POST', headers: {
        'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': body.length,
      } }, response => { facts.status = response.statusCode; response.resume(); response.once('end', resolve); });
      client.on('error', mode.startsWith('metadata-') || canceledWrite || heldResultAbort ? resolve : reject);
      if (mode.startsWith('metadata-') || canceledWrite || heldResultAbort) client.write(prefix);
      else client.end(body);
    });
    try {
      if (mode.startsWith('metadata-')) {
        await metadataEntered.promise; client.destroy(); await operation; await inputClosed.promise; await pause(15);
        facts.held = result(await runtime.drain({ timeoutMs: 40 })); facts.pendingAtCheckpoint = facts.metadataPending;
        metadataResume(); metadataHook?.disable(); await errorObserved.promise; await pause(20);
      }
      if (canceledWrite || heldResultAbort) {
        await writeReached.promise;
        client.destroy(); await operation; await inputClosed.promise;
        if (canceledWrite) await teardownReached.promise;
        if (heldResultAbort) { await callbackEntered.promise; await cleanupCompleted.promise; }
        await pause(15);
        facts.held = result(await runtime.drain({ timeoutMs: 40 }));
        facts.resultPendingAtCheckpoint = facts.storageResultPending;
        facts.storageCallbacksAtCheckpoint = facts.storageCallbackCalls || 0;
        facts.closedAtCheckpoint = facts.outputClosed === true;
        facts.fileExistsAtCheckpoint = fs.existsSync(path.join(downloads, filename));
        if (canceledWrite) writeResume(); else resultResume();
        await cleanupCompleted.promise; await errorObserved.promise; await pause(20);
      }
      if (heldResultSuccess) {
        await callbackEntered.promise; await pause(15);
        facts.held = result(await runtime.drain({ timeoutMs: 40 }));
        facts.resultPendingAtCheckpoint = facts.storageResultPending;
        facts.storageCallbacksAtCheckpoint = facts.storageCallbackCalls || 0;
        facts.closedAtCheckpoint = facts.outputClosed === true;
        facts.fileExistsAtCheckpoint = fs.existsSync(path.join(downloads, filename));
        resultResume();
      }
      if (mode === 'cleanup-held') { await cleanup.promise; facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve(); }
      if (mode.startsWith('write-') && !canceledWrite) { await writeReached.promise; facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve(); }
      if (mode === 'cleanup-stream-close-held') {
        await writeReached.promise; facts.fileExistsWhileHeld = fs.existsSync(path.join(downloads, filename));
        facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve();
      }
      if (mode === 'cleanup-callback-held' || mode === 'callback-held') {
        await callbackEntered.promise; await pause(10); facts.held = result(await runtime.drain({ timeoutMs: 40 })); gate.resolve();
      }
      await operation; await pause(20); fs.chmodSync(downloads, 0o700); facts.residual = fs.readdirSync(downloads);
      facts.residualBytes = facts.residual.length ? fs.statSync(path.join(downloads, facts.residual[0])).size : 0;
      return { facts, ...result(await runtime.drain({ timeoutMs: 150, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) })) };
    } finally { gate.resolve(); if (facts.metadataPending) metadataResume?.(); writeResume?.(); resultResume?.(); metadataHook?.disable(); fs.chmodSync(downloads, 0o700); client?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}

async function cli(directory, action) {
  const args = compiled ? [actual('runtime/cli.ts'), action] : ['--require', __filename, actual('runtime/cli.ts'), action];
  return new Promise(resolve => execFile(process.execPath, args, { timeout: 2000, env: { ...process.env, FCM_RUNTIME_CONTROL_DIR: directory, RUNTIME_ROUND7_PRELOAD_ONLY: '1' } }, (error, stdout, stderr) => {
    resolve({ code: error?.code || 0, response: stdout ? JSON.parse(stdout) : null, stderr });
  }));
}
async function control(mode) {
  return fixture('control-' + mode, async (runtime, directory) => {
    const { openRuntimeControl } = require(actual('runtime/control.ts'));
    const facts = {}, gate = deferred(), shutdownReceived = deferred();
    const server = await openRuntimeControl(runtime, async () => { facts.ingressClosed = true; }, () => { facts.processClosed = true; });
    server.on('connection', socket => socket.on('data', data => { if (data.toString().includes('shutdown')) shutdownReceived.resolve(); }));
    try {
      if (mode === 'freeze-failure') {
        fs.chmodSync(runtime.controlDir, 0o500);
        facts.command = await cli(runtime.controlDir, 'freeze');
        fs.chmodSync(runtime.controlDir, 0o700); facts.markerExists = fs.existsSync(runtime.markerPath);
      } else if (mode === 'freeze-prior-failure' || mode === 'freeze-journal-failure') {
        if (mode === 'freeze-journal-failure') fs.chmodSync(runtime.controlDir, 0o500);
        runtime.recordFailure('fixture-required', new Error('private fixture effect'));
        fs.chmodSync(runtime.controlDir, 0o700);
        facts.command = await cli(runtime.controlDir, 'freeze'); facts.markerExists = fs.existsSync(runtime.markerPath);
      } else if (mode === 'checkpoint-failure') {
        runtime.freeze('fixture'); fs.chmodSync(runtime.controlDir, 0o500);
        facts.command = await cli(runtime.controlDir, 'shutdown'); fs.chmodSync(runtime.controlDir, 0o700);
        facts.markerExists = fs.existsSync(runtime.markerPath);
      } else if (mode === 'shutdown-held-timeout') {
        const operation = runtime.run('fixture-held', () => gate.promise);
        facts.command = await cli(runtime.controlDir, 'shutdown'); facts.markerExists = fs.existsSync(runtime.markerPath);
        facts.incomplete = result(runtime.snapshot()); gate.resolve(); await operation;
      } else if (mode === 'already-closed-no-ingress') {
        await runtime.drain({ timeoutMs: 150, close: true });
        facts.command = await cli(runtime.controlDir, 'shutdown'); facts.markerExists = fs.existsSync(runtime.markerPath);
      } else {
        const operation = runtime.run('fixture-held', () => gate.promise);
        const first = cli(runtime.controlDir, 'drain');
        for (let count = 0; runtime.snapshot().phase !== 'draining' && count < 100; count++) await pause(5);
        const second = cli(runtime.controlDir, 'shutdown'); await shutdownReceived.promise; gate.resolve(); await operation;
        facts.drain = await first; facts.shutdown = await second;
      }
      return { facts, ...result(runtime.snapshot()) };
    } finally { gate.resolve(); fs.chmodSync(runtime.controlDir, 0o700); await new Promise(resolve => server.close(resolve)); }
  });
}
if (!process.env.RUNTIME_ROUND7_PRELOAD_ONLY) {
  (async () => {
    const results = [];
    for (const mode of ['success', 'held', 'error', 'timeout', 'request-held', 'request-error', 'constructor-error', 'rebound-held', 'rebound-timeout']) results.push(await embed(mode));
    for (const mode of ['success', 'aborted', 'held', 'error', 'preopen-abort', 'frozen-success', 'frozen-aborted', 'frozen-held', 'sendfile-success', 'sendfile-aborted', 'sendfile-held',
      'head-success', 'head-aborted', '304-success', '304-aborted', 'sendfile-preopen-abort', 'sendfile-missing-abort', 'sendfile-preopen-held', 'frozen-script-success', 'frozen-script-aborted', 'frozen-script-held']) results.push(await staticRead(mode));
    for (const mode of ['success', 'cleanup-success', 'cleanup-failure', 'cleanup-held', 'replacement-cleanup', 'write-held', 'write-close-held', 'partial-error', 'partial-cleanup-failure', 'replacement-partial', 'permission-refused', 'size-limit', 'invalid-filename',
      'cleanup-callback-held', 'cleanup-stream-close-held', 'callback-held', 'validation-cleanup-failure',
      'metadata-destination-abort', 'metadata-filename-abort', 'metadata-lstat-abort', 'write-abort-canceled', 'cleanup-result-callback-abort', 'result-success-held']) results.push(await upload(mode));
    for (const mode of ['freeze-failure', 'join-shutdown', 'freeze-prior-failure', 'freeze-journal-failure', 'checkpoint-failure', 'shutdown-held-timeout', 'already-closed-no-ingress']) results.push(await control(mode));
    const crypto = require('node:crypto'), hashes = {};
    for (const relative of ['runtime/coordinator.ts', 'runtime/control.ts', 'runtime/cli.ts', 'runtime/fileReads.ts', 'runtime/diskUpload.ts', 'services/embedAssetService.ts']) {
      if (fs.existsSync(actual(relative))) hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(actual(relative))).digest('hex');
    }
    const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const installedExpress = Module.createRequire(sdk.resolve('express'));
    const installed = (name, resolver) => {
      const main = resolver.resolve(name), directory = path.dirname(main);
      return { version: JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version,
        main: path.relative(backend, main), mainSha256: hashFile(main) };
    };
    const multerDirectory = path.dirname(sdk.resolve('multer'));
    const sdks = { express: installed('express', sdk),
      send: { ...installed('send', installedExpress), resolvedBy: 'installed-express' },
      serveStatic: installed('serve-static', installedExpress),
      multer: { ...installed('multer', sdk), diskStorageSha256: hashFile(path.join(multerDirectory, 'storage/disk.js')),
        middlewareSha256: hashFile(path.join(multerDirectory, 'lib/make-middleware.js')) } };
    process.stdout.write(JSON.stringify({ node: process.version, compiled, sourceHashes: hashes,
      serverSourceSha256: crypto.createHash('sha256').update(serverSource()).digest('hex'), sdks, results }) + '\n');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
