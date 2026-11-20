// Actual Redis subscription owner and relay receivers; only stores/socket sinks
// and valid nameplate preparation are synthetic. Required-effect helpers stay real.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const br = require('node:module').createRequire(path.join(__dirname, '../../package.json'));
const esbuild = br('esbuild');
const { loader } = require('./runtime-publication-prerequisites.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const uid = 'user_11111111111111111111111111111111';
const account = '22222222-2222-2222-2222-222222222222';
const ownInstance = '33333333-3333-3333-3333-333333333333';
const otherInstance = '44444444-4444-4444-4444-444444444444';
const groups = ['link-required', 'hud-send-receipt', 'hud-layout', 'nameplate-presence', 'link-complete'];
const modes = ['healthy', 'client-fail', 'cursor-response-lost', 'self-origin', 'frozen', 'no-target', 'delivery-throw'];
const cases = groups.flatMap(group => modes.map(mode => ({ group, mode, label: group + ':' + mode,
  failure: ['client-fail', 'cursor-response-lost', 'delivery-throw'].includes(mode) })));
cases.push(...['link-required', 'hud-send-receipt'].map(group => ({ group, mode: 'no-target-client-fail',
  label: group + ':no-target-client-fail', failure: false })));
cases.push({ group: 'link-complete', mode: 'pairing-lookup-fail', label: 'link-complete:pairing-lookup-fail', failure: true });

async function execute(root, group, mode) {
  const m = loader(root);
  const variant = fs.existsSync(path.join(root, 'config/redis.ts')) ? 'source' : 'compiled';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-relay-receiver-'));
  const runtime = new (m.load('runtime/coordinator').RuntimeCoordinator)(directory);
  m.bind(runtime);
  const effects = m.load('lib/requiredEffects');
  const state = { clientConnectAttempts: 0, cursorAttempts: 0, cursorValue: 0,
    deliveryAttempts: 0, delivered: 0, warnings: 0, publications: 0, pairingLookups: 0, frames: [] };
  const warnings = [];
  const logger = { info() {}, debug() {}, error() {}, warn(...args) {
    state.warnings++;
    warnings.push(args.filter(value => typeof value === 'string'));
  } };
  const fault = () => Object.assign(new Error('synthetic-private-receiver-secret'), { code: 'ECONNRESET' });
  const received = new Map();
  const primary = {
    isOpen: false, on() { return this; },
    async connect() {
      state.clientConnectAttempts++;
      if (mode === 'client-fail' || mode === 'no-target-client-fail') throw fault();
      this.isOpen = true;
    },
    async incr() {
      state.cursorAttempts++;
      state.cursorValue++; // The store applies INCR before losing its response.
      if (mode === 'cursor-response-lost') throw fault();
      return state.cursorValue;
    },
    async publish() { state.publications++; return 1; },
  };
  const subscriber = { isOpen: true, on() { return this; },
    async subscribe(channel, callback) { received.set(channel, callback); } };
  let clients = 0;
  const configPath = path.join(root, 'config/redis.' + (variant === 'source' ? 'ts' : 'js'));
  const configText = fs.readFileSync(configPath, 'utf8');
  m.hashes[path.relative(root, configPath)] = sha(configText);
  const configCode = variant === 'source'
    ? esbuild.transformSync(configText, { loader: 'ts', format: 'cjs', target: 'node22' }).code : configText;
  const configModule = { exports: {} };
  const configRequire = name => {
    if (name === 'redis') return { createClient: () => [primary, subscriber][clients++] };
    if (name === './environment') return { __esModule: true, default: {} };
    if (name === './logger') return { __esModule: true, default: logger };
    if (name === '../runtime') return { runtime };
    throw Error('Unexpected config import: ' + name);
  };
  vm.runInThisContext('(function(require,module,exports){' + configCode + '\n})', { filename: configPath })(
    configRequire, configModule, configModule.exports);
  assert.equal(clients, 2);
  const { getRedisClient, getSubscriberClient } = configModule.exports;
  const target = { userId: uid, linkedUserId: group === 'link-required' ? null : account,
    ws: { readyState: 1 }, cursor: 0 };
  const subscribers = new Set(mode.startsWith('no-target') ? [] : [target]);
  const deliver = frame => {
    state.deliveryAttempts++;
    if (mode === 'delivery-throw') throw fault();
    state.frames.push(JSON.parse(frame)); state.delivered++; return true;
  };
  const sendSubscriberFrame = (_sub, frame) => deliver(frame);
  const sendRaw = (_ws, frame) => deliver(frame);
  const prisma = { hudPairingToken: { findFirst: async () => {
    state.pairingLookups++;
    if (mode === 'pairing-lookup-fail') throw fault();
    return { linkedUserId: account };
  } } };
  const common = { ...effects, runtime, logger, getRedisClient, getSubscriberClient, prisma, subscribers,
    sendSubscriberFrame, sendRaw, flushLocalPresenceToRedis: () => {} };
  const fn = (file, name, bindings = {}) => m.selected(file, name, { ...common, ...bindings });
  const nextRelaySeq = fn('services/relay/relaySeq', 'nextRelaySeq', { RELAY_SEQ_KEY: 'relay:seq' });
  const linkNoticeBody = fn('services/relay/relayHandler', 'linkNoticeBody', { LINK_URL: 'synthetic-local-value' });
  const pushRecoveredLinkNoticeLocal = fn('services/relay/relayHandler', 'pushRecoveredLinkNoticeLocal', { nextRelaySeq, linkNoticeBody });
  const pushHudSendReceiptLocal = fn('services/relay/relayHandler', 'pushHudSendReceiptLocal', { nextRelaySeq });
  const pushNameplatePresenceLocal = fn('services/relay/relayHandler', 'pushNameplatePresenceLocal', { nextRelaySeq, NAMEPLATE_EVENT: 'FCMNAMEPLATES/1;' });
  const parseHudLayout = fn('services/relay/hudLayoutService', 'parseHudLayout', { HUD_COLOR_FIELDS: [] });
  const pushHudLayoutLocal = fn('services/relay/relayHandler', 'pushHudLayoutLocal', { parseHudLayout, HUD_LAYOUT_EVENT: 'FCMLAYOUT/1;' });
  const pushLinkCompleteLocal = fn('services/relay/relayHandler', 'pushLinkCompleteLocal');
  const ensurePubSub = fn('services/relay/relayHandler', 'ensurePubSub', { pubSubReady: false,
    REDIS_BROADCAST_CHANNEL: 'fixture:broadcast', RELAY_CONTROL_CHANNEL: 'fixture:control',
    SERVER_EVENTS_CHANNEL: 'fixture:server', UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    relayInstanceId: ownInstance, INSTANCE_ID: ownInstance, pushRecoveredLinkNoticeLocal,
    pushHudSendReceiptLocal, pushNameplatePresenceLocal, pushHudLayoutLocal, pushLinkCompleteLocal,
    parseNameplateReply: value => value });
  try {
    await runtime.run('synthetic:subscriber-registration', ensurePubSub);
    assert.equal(received.size, 3);
    const payload = { kind: group, sourceInstanceId: mode === 'self-origin' ? ownInstance : otherInstance,
      relayUserId: uid, linkedUserId: account, code: 'ABCDEFGH', requestId: 'fixture',
      layout: { x: 10, y: 10, width: 300, height: 200 },
      response: { success: true, messageId: account },
      reply: { version: 1, requestId: 'fixture', context: 'hud:fixture', ttlMs: 100, names: [] } };
    if (mode === 'frozen') runtime.freezeForRestart();
    received.get('fixture:control')(JSON.stringify(payload), 'fixture:control');
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const afterDelivery = runtime.snapshot();
    const final = await runtime.drain({ timeoutMs: 500, close: true, maintenance: false,
      closeIngress: async () => {} });
    const checkpoint = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8'));
    const journal = fs.existsSync(runtime.failuresPath) ? fs.readFileSync(runtime.failuresPath, 'utf8') : '';
    assert.equal(final.active.length, 0);
    assert.equal(final.phase, checkpoint.phase);
    assert(!journal.includes('synthetic-private-receiver-secret'));
    return { group, mode, state, warnings, afterDelivery, final, checkpoint, journal,
      hashes: m.hashes, aliases: [...new Set(m.aliases)] };
  } finally {
    runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true });
    assert(!fs.existsSync(directory));
  }
}

async function run(root) {
  const results = [];
  for (const spec of cases) results.push({ ...spec, ...await execute(root, spec.group, spec.mode) });
  return { node: process.version, syntheticOnly: true, results };
}
module.exports = { cases, run };
if (require.main === module) run(process.argv[2]).then(result => {
  fs.writeFileSync(process.env.FCM_DISCOVERY_RESULT, JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });
