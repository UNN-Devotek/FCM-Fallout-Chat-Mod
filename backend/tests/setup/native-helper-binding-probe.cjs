const http = require('node:http'), path = require('node:path');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
module.exports = async function probeNativeHelperBinding(runtime, helper, mode, source) {
  const started = deferred(), gate = deferred(), callback = deferred(), transportClosed = deferred(), sockets = new Set(), facts = { mode, initializationCalls: 0 };
  const initialize = runtime.initializeSdkLifetime.bind(runtime);
  runtime.initializeSdkLifetime = fn => { facts.initializationCalls++; facts.activeAtInitialization = runtime.snapshot().active.map(work => work.label); return initialize(fn); };
  let response, completed = false;
  const server = http.createServer((req, res) => {
    facts.requests = (facts.requests || 0) + 1;
    res.once('finish', () => { facts.responseFinished = true; }); res.once('close', () => { facts.responseClosed = true; });
    req.resume(); req.once('end', () => { facts.requestEnded = true; response = res; res.writeHead(200, { Connection: 'close' });
      if (mode === 'body-held') { res.write('synthetic '); started.resolve(); } else res.end('synthetic result');
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); if (!sockets.size) transportClosed.resolve(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const operation = runtime.run('accepted-bound-native-result', async () => {
    const result = await helper.beginRuntimeFetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: '{"fixture":true}' });
    facts.body = await result.text();
    if (mode === 'callback-held') {
      void gate.promise.then(() => runtime.required('accepted-bound-native-callback', async () => { facts.callbackDone = true; })); callback.resolve();
    }
  }).then(() => { completed = true; });
  try {
    if (mode === 'body-held') { await started.promise; facts.held = await runtime.drain({ timeoutMs: 40 }); facts.completedAtCheckpoint = completed; response.end('result'); }
    else if (mode === 'callback-held') { await callback.promise; await operation; facts.held = await runtime.drain({ timeoutMs: 40 }); facts.callbackDoneAtCheckpoint = Boolean(facts.callbackDone); gate.resolve(); }
    await operation;
    await transportClosed.promise;
    const final = await runtime.drain({ timeoutMs: 500, close: true, closeIngress: () => new Promise(resolve => server.close(resolve)) });
    facts.unintendedRuntimeLoaded = [path.join(source, 'runtime.ts'), path.join(source, 'runtime.js'), path.join(source, 'runtime/index.ts'), path.join(source, 'runtime/index.js')].some(file => Boolean(require.cache[file]));
    facts.unintendedEnvironmentLoaded = [path.join(source, 'config/environment.ts'), path.join(source, 'config/environment.js')].some(file => Boolean(require.cache[file]));
    facts.terminalSockets = sockets.size;
    return { facts, phase: final.phase, active: final.active, failures: final.failures, ingressClosed: final.ingressClosed, accountingEpoch: final.accountingEpoch, inspectionEpoch: final.inspectionEpoch };
  } finally {
    gate.resolve(); response?.end();
    const closures = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    await operation; await Promise.all([new Promise(resolve => server.close(resolve)), ...closures]); runtime.initializeSdkLifetime = initialize;
  }
};
