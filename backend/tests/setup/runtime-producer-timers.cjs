// Actual runtime/index and native timers, without module/timer/SDK replacements.
// Source mode uses the installed compiler; compiled mode needs no dev dependency.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const { spawnSync } = require('node:child_process');
const modes = ['natural-timeout', 'cancel-before-fire', 'repeated-cancel', 'teardown-interval', 'connection-churn', 'mixed-freeze', 'held-timeout', 'held-interval', 'detached-callback', 'frozen-registration', 'native-handle'];
const mode = process.argv[2], output = process.argv[3];
if (mode === '--all') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-timer-cases-')), results = [], logs = [];
  try {
    for (const item of modes) {
      const resultFile = path.join(directory, item + '.json');
      const child = spawnSync(process.execPath, [__filename, item, resultFile], { encoding: 'utf8', timeout: 15000, cwd: directory });
      logs.push({ mode: item, status: child.status, stdout: child.stdout, stderr: child.stderr });
      if (child.error || child.status !== 0) throw Object.assign(new Error('Timer fixture child failed: ' + item), { logs });
      results.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
    }
    const value = { node: process.version, results, logs };
    if (output) fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n');
    console.log(JSON.stringify(value));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} else {
  if (!modes.includes(mode) && mode !== 'caller-aliases') throw new Error('Unknown timer fixture mode');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-producer-timer-'));
  process.env.NODE_ENV = 'test'; process.env.FCM_RUNTIME_CONTROL_DIR = path.join(directory, 'control');
  const backend = path.resolve(process.env.RUNTIME_FIXTURE_BACKEND || path.join(__dirname, '../..'));
  const source = path.resolve(process.env.RUNTIME_FIXTURE_SOURCE || path.join(backend, 'src'));
  const compiled = !fs.existsSync(path.join(source, 'runtime/index.ts'));
  if (!compiled) {
    const sdk = Module.createRequire(path.join(backend, 'package.json')), esbuild = sdk('esbuild');
    Module._extensions['.ts'] = (module, filename) => module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code, filename);
  }
  const actual = file => path.join(source, 'runtime', file + (compiled ? '.js' : '.ts'));
  const { runtime, producerInterval, producerTimeout, cancelProducerTimer } = require(actual('index'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const view = state => ({ phase: state.phase, active: state.active, failures: state.failures, producers: state.producers, stoppedProducers: state.stoppedProducers, ingressClosed: state.ingressClosed });
  (async () => {
    const baseline = runtime.snapshot().producers.length, facts = { baseline, invoked: 0 }, handles = [];
    const interval = (label, callback, delay = 30000) => { const handle = producerInterval(label, callback, delay); handles.push(handle); return handle; };
    const timeout = (label, callback, delay = 30000) => { const handle = producerTimeout(label, callback, delay); handles.push(handle); return handle; };
    if (mode === 'caller-aliases') {
      const callers = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')); facts.calls = [];
      for (const item of callers) for (const kind of ['interval', 'timeout']) {
        const handle = kind === 'interval' ? interval('caller-cancel', () => facts.invoked++) : timeout('caller-cancel', () => facts.invoked++);
        const segments = item.argument.split('.'), receiver = {}, root = segments.shift();
        let scope = receiver;
        if (!segments.length) scope[root] = handle;
        else {
          if (root !== 'this') scope = receiver[root] = {};
          while (segments.length > 1) scope = scope[segments.shift()] = {};
          scope[segments[0]] = handle;
        }
        const invoke = new Function(item.callee, 'scope', `with(scope) { ${item.expression}; }`);
        const registeredBefore = runtime.snapshot().producers.length; invoke.call(receiver, cancelProducerTimer, receiver); invoke.call(receiver, cancelProducerTimer, receiver);
        facts.calls.push({ file: item.file, expression: item.expression, kind, registeredBefore, registeredAfter: runtime.snapshot().producers.length });
      }
    } else if (mode === 'natural-timeout') {
      const started = deferred(); const handle = timeout('natural-timeout', () => { facts.invoked++; started.resolve(); }, 2);
      await started.promise; await pause(5); facts.afterFire = view(runtime.snapshot()); cancelProducerTimer(handle); cancelProducerTimer(handle);
    } else if (mode === 'cancel-before-fire' || mode === 'repeated-cancel') {
      const once = timeout('canceled-timeout', () => facts.invoked++, 10);
      const repeating = interval('canceled-interval', () => facts.invoked++, 10);
      for (let i = 0; i < (mode === 'repeated-cancel' ? 5 : 1); i++) { cancelProducerTimer(once); cancelProducerTimer(repeating); }
      await pause(30);
    } else if (mode === 'teardown-interval') {
      const started = deferred(); const handle = interval('connection-heartbeat', () => { facts.invoked++; started.resolve(); }, 5);
      await started.promise; cancelProducerTimer(handle); facts.invokedAtCancel = facts.invoked; await pause(25);
    } else if (mode === 'connection-churn') {
      facts.samples = []; let total = 0;
      for (const count of [1, 99, 900, 4000]) {
        for (let i = 0; i < count; i++) {
          const heartbeat = interval('ws-client-heartbeat', () => facts.invoked++);
          const grace = timeout('ws-disconnect-grace', () => facts.invoked++);
          const pending = { timer: grace }, alias = heartbeat;
          cancelProducerTimer(alias); cancelProducerTimer(pending.timer); cancelProducerTimer(alias);
        }
        total += count; const state = runtime.snapshot();
        facts.samples.push({ canceledPairs: total, registered: state.producers.length, snapshotBytes: Buffer.byteLength(JSON.stringify(state)) });
      }
    } else if (mode === 'mixed-freeze') {
      cancelProducerTimer(interval('canceled-interval', () => facts.invoked++));
      cancelProducerTimer(timeout('canceled-timeout', () => facts.invoked++));
      interval('live-interval', () => facts.invoked++); timeout('live-timeout', () => facts.invoked++);
      facts.beforeFreeze = view(runtime.snapshot()); runtime.freeze('timer fixture'); runtime.freeze('timer fixture again');
      facts.afterFreeze = view(runtime.snapshot()); for (const handle of handles) cancelProducerTimer(handle);
    } else if (mode.startsWith('held-') || mode === 'detached-callback') {
      const started = deferred(), gate = deferred(); let completed = false;
      const callback = mode === 'detached-callback' ? () => {
        facts.invoked++; void gate.promise.then(() => runtime.required('timer:callback-descendant', async () => { completed = true; })); started.resolve();
      } : async () => { facts.invoked++; started.resolve(); await gate.promise; completed = true; };
      const handle = mode === 'held-timeout' ? timeout('admitted-timer', callback, 2) : interval('admitted-timer', callback, 2);
      await started.promise; cancelProducerTimer(handle); facts.afterCancel = view(runtime.snapshot());
      facts.held = view(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed;
      gate.resolve(); facts.final = view(await runtime.drain({ timeoutMs: 500, close: true, closeIngress: async () => {} })); facts.completed = completed;
    } else if (mode === 'frozen-registration') {
      runtime.freeze('before registration'); interval('not-admitted-interval', () => facts.invoked++, 2); timeout('not-admitted-timeout', () => facts.invoked++, 2); await pause(20);
    } else if (mode === 'native-handle') {
      for (const handle of [interval('native-interval', () => facts.invoked++), timeout('native-timeout', () => facts.invoked++)]) {
        const before = handle.hasRef(); const sameUnref = handle.unref() === handle, unref = handle.hasRef();
        const sameRef = handle.ref() === handle, ref = handle.hasRef(); cancelProducerTimer(handle);
        (facts.handles ||= []).push({ before, sameUnref, unref, sameRef, ref });
      }
    }
    facts.beforeDrain = view(runtime.snapshot());
    const final = facts.final || view(await runtime.drain({ timeoutMs: 500, close: true, maintenance: false, closeIngress: async () => {} }));
    const value = { node: process.version, mode, compiled, sourceHashes: Object.fromEntries(['index', 'coordinator'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(actual(file))).digest('hex')])), facts, final,
      checkpointBytes: fs.readFileSync(runtime.checkpointPath).length };
    if (output) fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n'); console.log(JSON.stringify(value));
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
}
