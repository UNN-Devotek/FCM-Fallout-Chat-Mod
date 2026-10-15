'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const backend = path.resolve(process.env.RUNTIME_FIXTURE_BACKEND || path.join(__dirname, '../..'));
const source = path.resolve(process.env.RUNTIME_FIXTURE_SOURCE || path.join(backend, 'src'));
const requireSdk = require('node:module').createRequire(path.join(backend, 'package.json'));
if (fs.existsSync(path.join(source, 'runtime/coordinator.ts'))) {
  const esbuild = requireSdk('esbuild');
  require.extensions['.ts'] = (module, filename) => module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22',
  }).code, filename);
}
const load = name => require(path.join(source, 'runtime', name));
const { RuntimeCoordinator, MaintenanceError } = load('coordinator');
const { createRuntimeDiscordClient, loginRuntimeDiscordClient } = load('discordClient');
const { createRuntimeSessionStore } = load('sessionStore');
const { accountHttpIngress, instrumentHttpHandlers } = load('ingress');
const { GatewayIntentBits, version: discordVersion } = requireSdk('discord.js');
const { WebSocketServer } = requireSdk('ws');
const express = requireSdk('express'), session = requireSdk('express-session'), signature = requireSdk('cookie-signature');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(label, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-sdk-callback-'));
  const runtime = new RuntimeCoordinator(directory);
  try { return { label, ...await run(runtime) }; }
  finally { runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); }
}
async function discord(mode) {
  return fixture('discord-' + mode, async runtime => {
    const facts = { requests: 0 }, callbackGate = deferred(), commandGate = deferred(), received = deferred();
    const sockets = new Set(), gateway = new WebSocketServer({ noServer: true });
    let client, port;
    const botId = '100000000000000001', token = Buffer.from(botId).toString('base64') + '.synthetic.synthetictokennotreal';
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v10/gateway/bot') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ url: `ws://127.0.0.1:${port}/`, shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 60000, max_concurrency: 1 } })); return;
      }
      if (req.method !== 'POST' || !['/api/v10/channels/100000000000000001/messages', '/api/v10/webhooks/100000000000000001/private-fixture-token'].includes(req.url)) {
        res.writeHead(405); res.end(); return;
      }
      req.resume(); req.on('end', async () => {
        facts.requests++; received.resolve();
        if (mode === 'rest-held') await commandGate.promise;
        if (mode === 'rest-lost-reply') { res.destroy(); return; }
        if (mode === 'rest-unknown') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'private-fixture-unconfirmed-response' })); return; }
        res.setHeader('Content-Type', 'application/json'); res.writeHead(201);
        res.end(JSON.stringify({ id: '100000000000000002', channel_id: botId, content: 'synthetic fixture message' }));
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => gateway.handleUpgrade(req, socket, head, ws => gateway.emit('connection', ws)));
    gateway.on('connection', ws => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      ws.on('message', raw => {
        const packet = JSON.parse(raw.toString());
        if (packet.op === 1) ws.send(JSON.stringify({ op: 11, d: null }));
        if (packet.op === 2) {
          if (packet.d.token !== token) { ws.close(4004); return; }
          facts.identified = true;
          ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { v: 10,
            user: { id: botId, username: 'FixtureBot', discriminator: '0000', avatar: null, bot: true, verified: true, flags: 0 },
            guilds: [], session_id: 'fixture-session', resume_gateway_url: `ws://127.0.0.1:${port}/`, application: { id: botId, flags: 0 } } }));
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
    try {
      await runtime.run('startup', async () => {
        client = createRuntimeDiscordClient(runtime, { intents: [GatewayIntentBits.Guilds], rest: { api: `http://127.0.0.1:${port}/api` } });
        facts.sdkRetries = client.rest.options.retries;
        client.on('error', () => {});
        if (mode.startsWith('login')) {
          if (mode === 'login-callback') client.once('ready', () => { void (async () => { await callbackGate.promise; facts.callbackCompleted = true; })(); });
          await loginRuntimeDiscordClient(runtime, client, token, 3000);
          facts.readyUser = client.user.id;
        } else client.rest.setToken(token);
      });
      runtime.registerParticipant('discord-client', { inspect: async () => ({ pending: 0 }), close: async () => { await client.destroy(); facts.destroyed = true; } });
      if (mode.startsWith('rest')) {
        if (mode === 'rest-callback') client.rest.once('response', () => { void (async () => { await callbackGate.promise; facts.callbackCompleted = true; })(); });
        const route = ['rest-unknown', 'rest-lost-reply'].includes(mode) ? '/webhooks/100000000000000001/private-fixture-token' : '/channels/100000000000000001/messages';
        const operation = client.rest.post(route, { body: { content: 'synthetic fixture message' } }).then(reply => { facts.replyId = reply.id; }, () => { facts.rejected = true; });
        await bounded(received.promise);
        if (mode === 'rest-held') { facts.held = await runtime.drain({ timeoutMs: 35 }); commandGate.resolve(); }
        await bounded(operation);
      }
      if (mode.endsWith('callback')) {
        facts.held = await runtime.drain({ timeoutMs: 35, close: true });
        facts.destroyedBeforeCallback = !!facts.destroyed;
        callbackGate.resolve(); await pause(20);
      }
      await pause(20);
      const drained = await runtime.drain({ timeoutMs: 300, close: true });
      return { facts, phase: drained.phase, active: drained.active, failures: drained.failures, closed: drained.closedParticipants };
    } finally {
      callbackGate.resolve(); commandGate.resolve(); if (client) await client.destroy();
      for (const ws of gateway.clients) ws.terminate(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); await new Promise(resolve => gateway.close(resolve));
    }
  });
}
async function browser(mode, outcome) {
  return fixture(`browser-${mode}-${outcome}`, async runtime => {
    const facts = { calls: [], callbackCount: 0, handledErrors: [] }, commandGate = deferred(), callbackGate = deferred(), received = deferred();
    const payload = JSON.stringify({ cookie: { originalMaxAge: 14400000, expires: new Date(Date.now() + 14400000).toISOString(), httpOnly: true, path: '/' }, discordUser: { id: '100000000000000001' } });
    const command = async name => {
      facts.calls.push(name); received.resolve(); if (outcome === 'held') await commandGate.promise;
      if (outcome === 'unknown') throw new Error('private-fixture-session-response-unknown');
      return name === 'set' ? 'OK' : 1;
    };
    const client = { get: async () => { if (outcome === 'read-unknown') throw new Error('private-session-read-unknown'); return payload; }, set: () => command('set'), expire: () => command('expire'), del: () => command('del'),
      scanIterator: async function* () { if (outcome === 'discovery-unknown') throw new Error('private-session-discovery-unknown'); yield ['sess:private-fixture-session-id']; } };
    const store = createRuntimeSessionStore({ client,
      ...(outcome === 'serialization-refused' ? { serializer: { parse: JSON.parse, stringify: () => { throw new Error('Fixture serialization refused'); } } } : {}),
      ...(outcome === 'touch-disabled' ? { disableTouch: true } : {}),
    }, runtime);
    const app = express(); app.use(accountHttpIngress(runtime));
    app.use(session({ store, secret: 'synthetic-session-secret', resave: false, saveUninitialized: false,
      cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 14400000 } }));
    app.get('/', (req, res) => {
      if (mode === 'set') req.session.discordUser = { id: '100000000000000001' };
      if (mode === 'destroy') { req.session.destroy(err => { facts.callbackCount++; facts.callbackError = !!err; res.end('fixture response'); }); return; }
      res.end('fixture response');
    });
    app.use((err, req, res, next) => { facts.handledErrors.push(err.name); if (!res.headersSent) res.status(500).end('fixture error'); });
    instrumentHttpHandlers(app, runtime);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      let operation;
      if (outcome === 'frozen') {
        runtime.freeze('fixture');
        operation = store.set('private-fixture-session-id', JSON.parse(payload), err => { facts.callbackCount++; facts.maintenanceRefusal = err instanceof MaintenanceError; });
      } else if (mode === 'clear' || outcome === 'callback-held') operation = runtime.run('accepted-browser', () => new Promise(resolve => {
        const cb = err => {
          facts.callbackCount++; facts.callbackError = !!err; resolve();
          if (outcome === 'callback-held') void (async () => { await callbackGate.promise; facts.callbackCompleted = true; })();
          else facts.callbackCompleted = true;
        };
        if (mode === 'clear') void store.clear(cb); else void store[mode]('private-fixture-session-id', JSON.parse(payload), cb);
      }));
      else {
        const cookie = mode !== 'set' ? 'connect.sid=' + encodeURIComponent('s:' + signature.sign('private-fixture-session-id', 'synthetic-session-secret')) : undefined;
        operation = new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/', ...(cookie ? { headers: { cookie } } : {}) }, res => {
            res.resume(); res.once('end', () => { facts.responseStatus = res.statusCode; resolve(); });
          }); req.once('error', reject); req.setTimeout(3000, () => req.destroy(new Error('Fixture HTTP deadline')));
        });
      }
      if (outcome === 'held') { await bounded(received.promise); facts.held = await runtime.drain({ timeoutMs: 35 }); commandGate.resolve(); }
      await bounded(operation);
      if (outcome === 'callback-held') { facts.held = await runtime.drain({ timeoutMs: 35 }); callbackGate.resolve(); }
      await pause(20);
      const drained = await runtime.drain({ timeoutMs: 250, close: true });
      return { facts, phase: drained.phase, active: drained.active, failures: drained.failures };
    } finally { commandGate.resolve(); callbackGate.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}
(async () => {
  const results = [];
  for (const mode of ['login-success', 'login-callback', 'rest-success', 'rest-held', 'rest-callback', 'rest-unknown', 'rest-lost-reply']) results.push(await discord(mode));
  for (const mode of ['set', 'touch', 'destroy', 'clear']) for (const outcome of ['success', 'held', 'unknown']) results.push(await browser(mode, outcome));
  results.push(await browser('clear', 'discovery-unknown')); results.push(await browser('set', 'callback-held'));
  results.push(await browser('touch', 'read-unknown')); results.push(await browser('set', 'serialization-refused')); results.push(await browser('touch', 'touch-disabled'));
  results.push(await browser('set', 'frozen'));
  console.log(JSON.stringify({ node: process.version, discordVersion, actualSdk: true, fixtureOnly: true, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
