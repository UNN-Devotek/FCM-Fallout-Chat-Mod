// Source/emitted contracts with actual coordinator/helpers and explicit synthetic stores.
// No SDK, global Module, timer or prototype replacement; this is not real-store evidence.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const br = createRequire(path.join(__dirname, '../../package.json')), parser = br('@babel/parser'), esbuild = br('esbuild');
const userId = '11111111-1111-1111-1111-111111111111', partyId = '22222222-2222-2222-2222-222222222222';
const cases = [
  ['ban', 'healthy', false], ['ban', 'redis-discovery', true], ['ban', 'row-discovery', true],
  ['ban', 'redis-delete', true], ['ban', 'db-delete', true], ['ban', 'audit', true],
  ['ban', 'invalid-id', false], ['ban', 'primary-refusal', false], ['ban', 'held', false],
  ['unmute', 'healthy', false], ['unmute', 'redis-discovery', true], ['unmute', 'redis-set', true], ['unmute', 'audit', true], ['unmute', 'primary-refusal', false],
  ['party', 'last', false], ['party', 'count', true], ['party', 'owner', false], ['party', 'owner-discovery', true], ['party', 'owner-fallback', true],
  ['party', 'absent', false], ['party', 'optional-notify', false], ['party', 'audit', true],
  ['discord', 'healthy', false], ['discord', 'redis-discovery', true], ['discord', 'no-token-discovery', true], ['discord', 'cache-delete', true], ['discord', 'db-delete', true], ['discord', 'relay', true], ['discord', 'absent', false],
  ['steam', 'healthy', false], ['steam', 'redis-discovery', true], ['steam', 'no-token-discovery', true], ['steam', 'remaining-provider', false], ['steam', 'absent', false],
  ['generic', 'healthy', false], ['generic', 'last-provider', false], ['generic', 'no-change', false],
  ['relay-name', 'healthy', false], ['relay-name', 'discovery', true], ['relay-name', 'absent', false], ['relay-name', 'no-change', false],
  ['register', 'healthy', false], ['register', 'redis-discovery', true],
  ['blacklist', 'healthy', false], ['blacklist', 'discovery', true],
  ['relay-notice', 'healthy', false], ['relay-notice', 'discovery', true],
  ['rebind', 'healthy', false], ['rebind', 'discovery', true], ['history', 'healthy', false], ['history', 'discovery', true],
  ['nested', 'propagation', true], ['nested', 'no-primary', false], ['nested', 'expected-completion', false], ['nested', 'rollback', false],
].map(([group, mode, failure]) => ({ group, mode, failure, label: group + ':' + mode }));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function loader(root) {
  const compiled = !fs.existsSync(path.join(root, 'runtime/coordinator.ts')), cache = new Map(), hashes = {};
  const file = relative => path.join(root, relative + (compiled ? '.js' : '.ts'));
  const code = filename => { const content = fs.readFileSync(filename, 'utf8'); hashes[path.relative(root, filename)] = sha(content); return compiled ? content : esbuild.transformSync(content, { loader: 'ts', format: 'cjs', target: 'node22' }).code; };
  let runtime, fixturePrisma;
  function load(relative) {
    const filename = file(relative); if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const localRequire = name => {
      if (relative === 'utils/resolveActorId' && name === '../config/prisma') return { __esModule: true, default: fixturePrisma };
      if (relative === 'lib/requiredEffects' && name === '../runtime') { if (!runtime) throw Error('Missing current contract runtime'); return { runtime }; }
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name)).replace(/\.[jt]s$/, ''));
      return br(name);
    };
    vm.runInThisContext('(function(require,module,exports){' + code(filename) + '\n})', { filename })(localRequire, module, module.exports);
    return module.exports;
  }
  function selected(relative, name, bindings, callback = false) {
    const filename = file(relative), text = fs.readFileSync(filename, 'utf8'); hashes[path.relative(root, filename)] = sha(text);
    const ast = parser.parse(text, { sourceType: 'unambiguous', plugins: ['typescript'] }); let found;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (!callback && node.type === 'FunctionDeclaration' && node.id?.name === name) found = node;
      if (callback && node.type === 'CallExpression' && node.arguments[0]?.value === '/provider/:provider') found = node.arguments[node.arguments.length - 1];
      for (const [key, value] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value); }
    }
    visit(ast); if (!found) throw Error('Actual function not found: ' + relative + '/' + name);
    const original = text.slice(found.start, found.end); hashes[relative + '#' + name] = sha(original);
    const expression = callback ? '(' + original + ')' : original + '\n' + name;
    const transformed = compiled ? expression : esbuild.transformSync(expression, { loader: 'ts', format: 'cjs', target: 'node22', supported: { 'dynamic-import': false } }).code;
    return vm.runInNewContext(transformed, { module: { exports: {} }, exports: {}, console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, ...bindings }, { filename });
  }
  return { load, selected, compiled, hashes, bindPrisma: value => { fixturePrisma = value; }, bind: value => { runtime = value; } };
}
async function execute(root, spec) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-discovery-')), modules = loader(root);
  const { RuntimeCoordinator } = modules.load('runtime/coordinator'), runtime = new RuntimeCoordinator(directory); modules.bind(runtime);
  const effects = modules.load('lib/requiredEffects'), ingress = modules.load('runtime/ingress'), params = modules.load('utils/reqParams');
  const state = { primary: false, sessions: 1, cache: 1, audits: 0, immunity: false, member: true, partyDeleted: false, owner: 'old', identity: true, publication: 0, nameCopied: false };
  const calls = [], forwarded = [], logs = []; let release, checkpoint;
  const fault = () => Object.assign(new Error('synthetic-token synthetic-secret raw-query synthetic chat'), { code: spec.mode === 'primary-refusal' ? 'P2025' : 'ECONNRESET', token: 'synthetic-token' });
  const fail = stage => { calls.push(stage); if (spec.mode === stage) throw fault(); };
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => { logs.push(level); }]));
  const prisma = {
    user: { update: async () => { fail('primary-refusal'); state.primary = true; state.identity = false; return { id: userId }; }, findUnique: async () => ({ id: userId, discordId: spec.mode === 'absent' ? null : spec.group === 'steam' ? (spec.mode === 'remaining-provider' ? '100000000000000001' : null) : '100000000000000001', steamId: spec.mode === 'absent' ? null : '76561198000000000', installToken: 'synthetic-token' }) },
    session: { findMany: async () => { fail('row-discovery'); return [{ token: 'synthetic-token' }]; }, deleteMany: async () => { fail('db-delete'); state.sessions = 0; return { count: 1 }; }, delete: async () => { fail('db-delete'); state.sessions = 0; return {}; } },
    auditLog: { create: async () => { fail('audit'); state.audits++; return { id: 'fixture-audit' }; } },
    partyMember: { findFirst: async ({ where }) => { if (where.userId) return spec.mode === 'absent' ? null : { id: userId, role: ['owner', 'owner-discovery', 'owner-fallback'].includes(spec.mode) ? 'owner' : 'member' }; if (where.role) { fail('owner-discovery'); return spec.mode === 'owner-fallback' ? null : { id: partyId, userId: partyId }; } fail('owner-fallback'); return { id: partyId, userId: partyId }; }, delete: async () => { state.member = false; state.primary = true; return {}; }, count: async () => { fail('count'); return ['owner', 'owner-discovery', 'owner-fallback', 'optional-notify'].includes(spec.mode) ? 1 : 0; }, update: async () => { state.owner = 'new'; return {}; }, findMany: async () => { fail('optional-notify'); return []; } },
    party: { update: async ({ data }) => { if (data.isDeleted) state.partyDeleted = true; if (data.ownerId) state.owner = 'new'; return {}; } },
    linkedIdentity: { count: async () => 0, findFirst: async () => ({ id: userId }), deleteMany: async () => { state.primary = spec.mode !== 'no-change'; return { count: spec.mode === 'no-change' ? 0 : 1 }; } },
    hudPairingToken: { updateMany: async () => { state.primary = true; return { count: 1 }; }, findFirst: async () => { fail('discovery'); return spec.mode === 'absent' ? null : { fo76Name: 'synthetic chat', linkedUserId: userId }; } },
    nameBlacklistEntry: { create: async () => { state.primary = true; return { id: userId }; } },
  };
  const redis = { del: async () => { fail('cache-delete'); fail('redis-delete'); state.cache = 0; return 1; }, set: async () => { fail('redis-set'); state.immunity = true; state.primary = true; return 'OK'; }, publish: async () => { state.publication++; return 1; }, incr: async () => { state.primary = true; return 1; } };
  let acquisition = 0;
  const getRedisClient = async () => {
    calls.push('getRedisClient'); acquisition++;
    if (['redis-discovery', 'no-token-discovery', 'discovery'].includes(spec.mode) && (spec.group !== 'relay-notice' || acquisition > 1)) throw fault();
    if (spec.mode === 'held') await new Promise(resolve => { release = resolve; });
    return redis;
  };
  modules.bindPrisma(prisma);
  const actorIds = modules.load('utils/resolveActorId');
  const common = { ...effects, runtime, prisma, getRedisClient, logger, ...params, ...actorIds, resolveActorId_1: actorIds,
    requiredEffects_1: effects, prisma_1: { default: prisma }, redis_1: { getRedisClient }, logger_1: { default: logger }, reqParams_1: params,
    runtime_1: { runtime }, createError: (status, message) => Object.assign(new Error(message), { status }), UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    PARTIES_ENABLED: true, features_1: { PARTIES_ENABLED: true },
    resolveCallerId: req => req.user.id, isValidSteamId: value => /^\d{17}$/.test(value || ''), steamAuthService_1: { isValidSteamId: value => /^\d{17}$/.test(value || '') },
  };
  common.errorHandler_1 = { createError: common.createError };
  common.validateUuid = modules.selected('controllers/usersController', 'validateUuid', common);
  const fn = (file, name, bindings = {}) => modules.selected(file, name, { ...common, ...bindings });
  let handler;
  if (spec.group === 'ban') handler = fn('controllers/usersController', 'banUser');
  else if (spec.group === 'unmute') { const immunity = fn('services/autoModService', 'setSpamImmunity', { SPAM_IMMUNITY_TTL_SECONDS: 3600 }); handler = fn('controllers/usersController', 'unmuteUser', { setSpamImmunity: immunity, autoModService_1: { setSpamImmunity: immunity } }); }
  else if (spec.group === 'party') {
    const notifyBindings = { importHandlers: () => ({ broadcastToPartyMembers: async () => {} }), resolveOnlineCheck: () => () => false };
    handler = fn('controllers/partiesController', 'leaveParty', { emitMemberUpdate: fn('controllers/partiesController', 'emitMemberUpdate', notifyBindings), emitPartyDeleted: fn('controllers/partiesController', 'emitPartyDeleted', notifyBindings) });
  } else if (['discord', 'steam', 'generic'].includes(spec.group)) {
    if (spec.group === 'generic') prisma.user.findUnique = async () => ({ discordId: spec.mode === 'last-provider' ? null : '100000000000000001' });
    const hasLinkedProvider = fn('services/linkedIdentityService', 'hasLinkedProvider');
    const unlinkProviderIdentity = fn('services/linkedIdentityService', 'unlinkProviderIdentity', { hasLinkedProvider });
    handler = modules.selected('routes/link', 'unlinkCallback', { ...common, unlinkProviderIdentity, linkedIdentityService_1: { unlinkProviderIdentity }, require: () => ({ evictRelayUser: async () => { fail('relay'); return 1; } }) }, true);
  } else if (spec.group === 'relay-name') {
    prisma.user.update = async () => { state.nameCopied = true; return {}; };
    if (spec.mode === 'no-change') { prisma.hudPairingToken.updateMany = async () => ({ count: 0 }); prisma.hudPairingToken.findFirst = async () => { throw fault(); }; }
    const entry = fn('services/relay/tokenService', 'markRelayTokenLinked', { invalidateVerificationCache: () => {} }); handler = async () => await entry('user_synthetic', userId);
  } else if (spec.group === 'register') {
    const existingUser = { id: userId, username: 'pending-fixture', isBanned: false, discordId: null, steamId: '76561198000000000', installToken: userId };
    prisma.user.findUnique = async () => existingUser; prisma.user.findFirst = async () => null;
    prisma.device = { findUnique: async () => null };
    prisma.user.upsert = async () => { state.primary = true; return existingUser; };
    prisma.session.create = async () => { state.sessionCreated = true; return {}; };
    const nameChecks = modules.load('utils/nameBlacklist'), discriminator = modules.load('utils/discriminator'), equality = modules.load('utils/constantTimeEquals');
    const environment = { APP_CLIENT_KEY: 'synthetic-secret' };
    const handlers = { refreshClientIdentity: () => 0, resolveDisplayName: user => user.username };
    const syntheticRequire = name => name.includes('deviceAuthService') ? { extractSignatureHeaders: () => null } : name.includes('nameBlacklistService') ? { findBlacklistMatch: () => null } : handlers;
    handler = fn('controllers/usersController', 'register', { ...nameChecks, ...discriminator, ...equality, ...handlers,
      nameBlacklist_1: nameChecks, discriminator_1: discriminator, constantTimeEquals_1: equality, handlers_1: handlers,
      env: environment, environment_1: { default: environment }, SESSION_TTL_SECONDS: 86400,
      uuidv4: () => 'synthetic-token', uuid_1: { v4: () => 'synthetic-token' }, require: syntheticRequire, __importStar: value => value,
    });
  } else if (spec.group === 'blacklist') {
    const refreshBlacklist = fn('services/nameBlacklistService', 'refreshBlacklist', { loadBlacklist: async () => {}, PUBSUB_CHANNEL: 'fixture:blacklist' });
    handler = fn('controllers/nameBlacklistController', 'createBlacklistEntry', { refreshBlacklist, nameBlacklistService_1: { refreshBlacklist }, createSchema: { safeParse: () => ({ success: true, data: { pattern: 'synthetic', matchType: 'exact', enabled: true } }) } });
  } else if (spec.group === 'relay-notice') {
    prisma.hudPairingToken.findFirst = async () => ({ linkedUserId: userId });
    const local = fn('services/relay/relayHandler', 'pushLinkCompleteLocal', { subscribers: new Set(), flushLocalPresenceToRedis: () => {}, onlinePresenceService_1: { flushLocalPresenceToRedis: () => {} }, sendRaw: () => true });
    const entry = fn('services/relay/relayHandler', 'notifyLinkComplete', { pushLinkCompleteLocal: local, RELAY_CONTROL_CHANNEL: 'fixture:relay', relayInstanceId: 'fixture' }); handler = async () => await entry('user_synthetic');
  } else if (['rebind', 'history'].includes(spec.group)) {
    const primary = fn('services/relay/worldIdService', 'setWorldId', { worldKey: value => 'fixture:' + value, TTL_SECONDS: 60, getRedisClient: async () => redis, redis_1: { getRedisClient: async () => redis } });
    const notify = fn('services/relay/serverChat', spec.group === 'rebind' ? 'publishRebind' : 'publishHistoryResync', { SERVER_EVENTS_CHANNEL: 'fixture:server' });
    // Exact first writer and notification functions, with an explicitly synthetic compound caller.
    handler = async () => await effects.runRequiredBundle('session', 'fixture:binding-notification', async () => { await primary(userId, 'fixture'); await notify(userId, 'fixture'); });
  } else {
    handler = async () => await effects.runRequiredBundle('domain', 'fixture:nested-owner', async () => {
      if (!['no-primary', 'rollback'].includes(spec.mode)) await effects.runRequiredMutation('domain', 'fixture:primary', {}, () => { state.primary = true; });
      if (spec.mode === 'rollback') { await effects.runRequiredTransaction('domain', 'fixture:transaction', {}, async () => { const client = {}; effects.bindRequiredTransactionClient(client); await effects.runRequiredMutation('domain', 'fixture:tx-write', {}, () => {}, undefined, client); throw fault(); }, { confirmedRollback: () => true }).catch(() => {}); return; }
      await effects.runRequiredBundle('domain', 'fixture:nested-read', async () => { throw fault(); }, spec.mode === 'expected-completion' ? () => true : undefined).catch(() => {});
    });
  }
  const response = new EventEmitter(); response.writableFinished = false; response.status = status => { response.statusCode = status; return response; }; response.json = body => { response.body = body; response.writableFinished = true; response.emit('finish'); };
  const app = { router: { stack: [{ handle: handler }] } }; ingress.instrumentHttpHandlers(app, runtime);
  const request = { method: 'POST', params: { id: spec.mode === 'invalid-id' ? 'invalid' : partyId, provider: spec.group === 'generic' ? 'nexus' : spec.group }, body: { reason: 'synthetic chat' }, adminUser: { id: userId }, user: { id: userId }, sessionToken: spec.mode === 'no-token-discovery' ? undefined : 'synthetic-token' };
  if (spec.group === 'register') { request.headers = { 'x-app-client-key': 'synthetic-secret' }; request.body = { username: 'pending-fixture', installToken: userId }; }
  try {
    const operation = app.router.stack[0].handle(request, response, error => { forwarded.push({ code: error.code, status: error.status }); response.writableFinished = true; response.emit('finish'); });
    if (spec.mode === 'held') { while (!release) await new Promise(resolve => setImmediate(resolve)); checkpoint = await runtime.drain({ timeoutMs: 20, maintenance: false }); release(); }
    await operation; if (!response.writableFinished) { response.writableFinished = true; response.emit('finish'); }
    await new Promise(resolve => setImmediate(resolve));
    const final = await runtime.drain({ timeoutMs: 300, close: true, maintenance: false, closeIngress: async () => {} });
    const journal = fs.existsSync(runtime.failuresPath) ? fs.readFileSync(runtime.failuresPath, 'utf8') : '';
    const persisted = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8'));
    return { ...spec, state, calls, forwarded, logs, response: response.body, checkpoint, final, persisted, journal, hashes: modules.hashes };
  } finally { release?.(); runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); }
}
async function run(root) { const results = []; for (const spec of cases) results.push(await execute(root, spec)); return { node: process.version, syntheticContractOnly: true, results }; }
module.exports = { cases, run };
if (require.main === module) run(process.argv[2] || path.join(__dirname, '../../src')).then(value => { fs.writeFileSync(process.env.FCM_DISCOVERY_RESULT, JSON.stringify(value, null, 2) + '\n'); console.log(JSON.stringify(value)); }).catch(error => { console.error(error); process.exitCode = 1; });
