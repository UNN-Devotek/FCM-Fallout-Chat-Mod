// Current source functions and real native transport; no fetch/SDK/global patches.
// Compiled mode uses the exact emitted functions, source mode strips only types.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto'), Module = require('node:module');
const { spawnSync } = require('node:child_process');
const backend = path.resolve(process.env.RUNTIME_FIXTURE_BACKEND || path.join(__dirname, '../..'));
const source = path.resolve(process.env.RUNTIME_FIXTURE_SOURCE || path.join(backend, 'src'));
const sdk = Module.createRequire(path.join(backend, 'package.json'));
const compiled = !fs.existsSync(path.join(source, 'runtime/coordinator.ts'));
if (!compiled) Module._extensions['.ts'] = (module, filename) => module._compile(sdk('esbuild').transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code, filename);
process.env.NODE_ENV = 'test';
process.env.MINIO_ENDPOINT = 'http://127.0.0.1:1';
process.env.MINIO_ROOT_USER = 'synthetic';
process.env.MINIO_ROOT_PASSWORD = 'synthetic-only';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-disposal-'));
process.env.FCM_RUNTIME_CONTROL_DIR = path.join(directory, 'control');
const actual = relative => path.join(source, compiled ? relative.replace(/\.ts$/, '.js') : relative);
const { runtime } = require(actual('runtime/index.ts'));
const nativeHelper = require(actual('runtime/nativeFetch.ts'));
const required = require(actual('lib/requiredEffects.ts'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = state => ({ phase: state.phase, active: state.active, failures: state.failures, ingressClosed: state.ingressClosed });
const cases = [
  ['avatar-refused', 'services/avatarService.ts', 'captureAvatar'],
  ['image-refused', 'lib/imageStorage.ts', 'fetchRemoteImage'],
  ['image-mime-refused', 'lib/imageStorage.ts', 'fetchRemoteImage'],
  ['avatar-success', 'services/avatarService.ts', 'captureAvatar'],
  ['image-success', 'lib/imageStorage.ts', 'fetchRemoteImage'],
  ['avatar-body-held', 'services/avatarService.ts', 'captureAvatar'],
  ['image-body-held', 'lib/imageStorage.ts', 'fetchRemoteImage'],
  ['wiki-refused', 'controllers/wikiImageController.ts', 'fetchWithRetry'],
  ['camp-image-refused', 'controllers/campImageController.ts', 'fetchWithRetry'],
  ['verify-missing', 'controllers/verifyDevRoleController.ts', 'defaultProdMemberRolesFetcher'],
  ['verify-refused', 'controllers/verifyDevRoleController.ts', 'defaultProdMemberRolesFetcher'],
  ['fandom-limited', 'lib/fandomApiClient.ts', 'apiGet'],
  ['fandom-refused', 'lib/fandomApiClient.ts', 'apiGet'],
  ['steam-profile-refused', 'services/steamProfileService.ts', 'fetchSteamDisplayName'],
  ['bethesda-refused', 'services/serverStatusService.ts', 'fetchFromBethesda'],
  ['nukacrypt-refused', 'services/nukeCodesService.ts', 'fetchFromNukaCrypt'],
  ['minerva-refused', 'services/minervaService.ts', 'getMinervaInventory'],
  ['dev-oauth-refused', 'services/devAuthService.ts', 'fetchGuildMemberRoles', 0],
  ['prod-verify-refused', 'services/devAuthService.ts', 'defaultProdVerifyClient'],
  ['dev-side-missing', 'services/devAuthService.ts', 'fetchGuildMemberRoles', 1],
  ['dev-side-refused', 'services/devAuthService.ts', 'fetchGuildMemberRoles', 1],
  ['qa-identity-refused', 'controllers/qaOAuthController.ts', 'fetchIdentity'],
  ['qa-guild-missing', 'controllers/qaOAuthController.ts', 'fetchDevGuildRoles'],
  ['qa-guild-refused', 'controllers/qaOAuthController.ts', 'fetchDevGuildRoles'],
  ['dev-identity-refused', 'controllers/devPersonaLoginController.ts', 'fetchIdentity'],
  ['tenor-refused', 'controllers/tenorSearchController.ts', 'tenorSearch'],
  ['role-missing', 'services/roleVerificationService.ts', 'verifyAdminUser'],
  ['role-refused', 'services/roleVerificationService.ts', 'verifyAdminUser'],
  ['ticket-refused', 'services/ticketService.ts', 'onThreadMessage'],
  ['camp-ingest-refused', 'services/campService.ts', 'ingestCampDatabase'],
  ['camp-update-refused', 'services/campService.ts', 'getCampUpdateStatus'],
  ['camp-sync-refused', 'services/campService.ts', 'runCampSync'],
  ['oauth-member-refused', 'server.ts', '/auth/discord/callback'],
  ['oauth-public-unused', 'server.ts', '/auth/discord/callback'],
  ['link-member-refused', 'server.ts', '/auth/discord/link/callback'],
  ['nexus-userinfo-refused', 'server.ts', '/auth/nexus/callback'],
];

// Skip strings/comments while finding the original function's closing brace.
// Syntax is checked by the compiler/Function; no branches are rewritten.
function closingBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      for (i++; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === quote) break; }
    } else if (char === '/' && next === '/') { i = text.indexOf('\n', i + 2); if (i < 0) break; }
    else if (char === '/' && next === '*') { i = text.indexOf('*/', i + 2) + 1; if (i === 0) throw Error('Unclosed comment'); }
    else if (char === '/' && /(?:[([=,:!?&|{;]|\breturn|\bthrow)\s*$/.test(text.slice(0, i))) {
      let characterClass = false;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') characterClass = true;
        else if (text[i] === ']') characterClass = false;
        else if (text[i] === '/' && !characterClass) break;
      }
    }
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  throw Error('Unclosed actual function');
}
function functionExpression(text, name, occurrence = 0) {
  if (name.startsWith('/')) {
    const marker = new RegExp('app\\.get\\([\'"]' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]');
    const route = marker.exec(text); if (!route) throw Error('Actual route missing ' + name);
    const offset = text.indexOf('async (', route.index);
    const arrow = text.indexOf('=>', offset), body = text.indexOf('{', arrow);
    return text.slice(offset, closingBrace(text, body));
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^[ \\t]*(?:(?:async\\s+)?function\\s+' + escaped + '\\s*\\(|(?:async\\s+)?' + escaped + '\\s*\\(|(?:const|let)\\s+' + escaped + '\\s*=\\s*async\\s*\\()', 'gm');
  const matches = [...text.matchAll(pattern)]; const match = matches[occurrence];
  if (!match) throw Error('Actual function missing ' + name);
  const parameters = text.indexOf('(', match.index), body = text.indexOf('{', text.indexOf(')', parameters));
  const end = closingBrace(text, body), expression = text.slice(match.index, end);
  if (/^(?:const|let) /.test(expression)) return expression.slice(expression.indexOf('=') + 1).trim();
  if (/function /.test(match[0])) return expression;
  return `({ ${expression} }).${name}`;
}
function loadFunction(file, name, deps, occurrence = 0) {
  const filename = actual(file), bytes = fs.readFileSync(filename);
  const text = compiled ? bytes.toString() : sdk('esbuild').transformSync(bytes.toString(), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  const expression = functionExpression(text, name, occurrence);
  // Bind exact emitted namespace imports to the explicit fixture dependencies.
  // Their real implementations are used for runtime, required effects and fetch.
  const namespace = {};
  for (const match of text.matchAll(/(?:const|var)\s+([\w$]+)\s*=\s*(?:__importDefault\(|__importStar\(|__toESM\()?require\(["']([^"']+)["']\)\)?/g)) {
    const from = match[2];
    const value = /nativeFetch$/.test(from) ? { ...nativeHelper, beginRuntimeFetch: deps.fetch } : /requiredEffects$/.test(from) ? required : /(?:^|\/)runtime$/.test(from) ? { runtime }
      : /environment$/.test(from) ? { default: deps.env } : /logger$/.test(from) ? { default: deps.logger } : /prisma$/.test(from) ? { default: deps.prisma }
      : /redis$/.test(from) ? { getRedisClient: deps.getRedisClient } : /storage$/.test(from) ? { ensureBucket: deps.ensureBucket, uploadAvatar: deps.uploadAvatar }
      : /memberFetchRevoke$/.test(from) ? { shouldRevokeOnMemberFetchStatus: deps.shouldRevokeOnMemberFetchStatus }
      : /steamAuthService$/.test(from) ? { isValidSteamId: deps.isValidSteamId } : /chatName$/.test(from) ? { sanitizeChatName: deps.sanitizeChatName }
      : /playerReportService$/.test(from) ? { default: deps.playerReportService } : /oauthState$/.test(from) ? { parseBoundOAuthState: deps.parseBoundOAuthState } : deps;
    namespace[match[1]] = value;
  }
  const bindings = { ...deps, ...namespace };
  return { fn: new Function(...Object.keys(bindings), `return (${expression});`)(...Object.values(bindings)),
    provenance: { file, owner: name, occurrence, compiled, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), functionSha256: crypto.createHash('sha256').update(expression).digest('hex') } };
}

async function runCase(label) {
  const spec = cases.find(value => value[0] === label); if (!spec) throw Error('Unknown native response case ' + label);
  const facts = { label, node: process.version, nativeFetch: true, requests: [], responsesFinished: 0, responsesClosed: 0, physicalSocketCloses: 0, writes: 0 };
  const sockets = new Set();
  let releaseBody, bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      const upstream = new URL(req.url, 'http://fixture');
      const prelude = spec[2].startsWith('/') && (upstream.pathname.endsWith('/token') || upstream.pathname.endsWith('/@me'));
      const body = prelude ? JSON.stringify(upstream.pathname.endsWith('/token') ? { access_token: 'fixture-token' } : { id: '123456789012345678', username: 'fixture' }) : 'x'.repeat(100);
      const status = prelude || label === 'oauth-public-unused' || label.endsWith('-success') || label.endsWith('-body-held') || label === 'image-mime-refused' ? 200 : label.endsWith('-missing') ? 404 : label === 'fandom-limited' ? 429 : 403;
      res.once('finish', () => facts.responsesFinished++); res.once('close', () => facts.responsesClosed++);
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), 'Content-Type': label === 'image-mime-refused' ? 'text/html' : 'image/png', Connection: 'close' });
      res.write(body.slice(0, 1));
      releaseBody = () => { if (!res.destroyed) res.end(body.slice(1)); };
      bodyStarted();
      if (!label.endsWith('-body-held')) setTimeout(releaseBody, 30);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); facts.physicalSocketCloses++; }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetch = (input, init) => {
    const url = new URL(input); facts.requests.push({ host: url.hostname, path: url.pathname, method: init?.method || 'GET' });
    const target = `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`;
    return nativeHelper.beginRuntimeFetch(target, init);
  };
  const redis = { get: async () => label === 'nexus-userinfo-refused' ? JSON.stringify({ sessionId: 'fixture-session', codeVerifier: 'fixture-verifier' }) : null,
    getDel: async () => label.startsWith('link-') ? 'fixture-install' : JSON.stringify({ sessionId: 'fixture-session', intent: 'report' }), del: async () => 0, set: async () => { facts.cacheWrites = (facts.cacheWrites || 0) + 1; } };
  const response = { status(code) { facts.httpStatus = code; return this; }, send() { facts.sent = true; return this; }, json() { facts.sent = true; return this; }, redirect(url) { facts.redirect = url; }, setHeader() {} };
  const env = { NODE_ENV: 'test', DISCORD_TOKEN: 'fixture-token', PROD_VERIFY_URL: 'https://falloutchatmod.com/api/internal/verify-dev-role', PROD_VERIFY_TOKEN: 'fixture-token',
    DISCORD_SERVER_ID: 'fixture-guild', DEV_GUILD_ID: 'fixture-dev-guild', CLIENT_ORIGINS: ['http://fixture-ui'], TENOR_API_KEY: 'fixture-key', NEXUS_OAUTH_CLIENT_ID: 'fixture-client', NEXUS_OAUTH_CLIENT_SECRET: 'fixture-secret' };
  const deps = { fetch, env, logger: { info() {}, warn() {}, error() {} }, runtime, ...required, ...nativeHelper,
    FETCH_RETRIES: 2, FETCH_TIMEOUT_MS: 6000, FETCH_TIMEOUT: 12000, MAX_JSON_BYTES: 4 * 1024 * 1024, REPORT_IMAGE_MAX_BYTES: 5 * 1024 * 1024,
    bucketReady: false, ensureBucket: async () => { facts.bucketChecked = true; }, uploadAvatar: async (_id, buffer) => { facts.uploadedBytes = buffer.length; },
    buildAvatarUrl: id => '/avatars/' + id, ALLOWED_HOSTS: new Set(['static.wikia.nocookie.net', 'mrsblobby.github.io']), ALLOWED_FANDOM_SUFFIX: '.fandom.com', ALLOWED_MIME_PREFIXES: ['image/webp', 'image/png', 'image/jpeg', 'image/gif'],
    FANDOM_API: 'https://fallout.fandom.com/api.php', FANDOM_UA: 'fixture-agent', STATUS_URL: 'https://api.bethesda.net/status/ext-server-status?product_id=8', CODES_URL: 'https://api.nukacrypt.com/api/codes',
    inventoryCache: new Map(), INVENTORY_SOURCE: 'https://raw.githubusercontent.com/Grandpere/f76-tools/main/data/sources/nukaknights/minerva',
    CAMP_DB_URL: 'https://mrsblobby.github.io/76-CAMPDatabase/Live/final_workshop_db.json', CAMP_UPDATE_CACHE: 'fixture-camp-updates', CAMP_SYNC_AT_KEY: 'fixture-camp-sync', CAMP_HASH_KEY: 'fixture-camp-hash', UPDATE_CACHE_TTL: 30,
    getRedisClient: async () => redis, prisma: { user: { updateMany: async () => { facts.writes++; return { count: 0 }; } } },
    isValidSteamId: require(actual('services/steamAuthService.ts')).isValidSteamId, sanitizeChatName: require(actual('utils/chatName.ts')).sanitizeChatName,
    shouldRevokeOnMemberFetchStatus: require(actual('utils/memberFetchRevoke.ts')).shouldRevokeOnMemberFetchStatus,
    RateLimitError: require(actual('lib/fandomApiClient.ts')).RateLimitError, tenorCache: new Map(), cachePut() {}, CACHE_TTL_MS: 300000,
    isAllowedDiscordAttachmentUrl: url => new URL(url).hostname === 'cdn.discordapp.com',
    playerReportService: { findReportByThread: async () => ({ id: 'fixture-report' }) },
    devBotToken: 'fixture-token', prodGuildId: 'fixture-prod-guild',
    parseBoundOAuthState: (raw, sessionId) => { const value = JSON.parse(raw); return value.sessionId === sessionId ? value : null; },
    PIP_BOY_HTML: () => 'fixture-policy-result' };
  if (compiled) {
    // Compiled imports still use their exact native helper; the default fetch
    // fixture redirects only this function's transport to the owned loopback.
    deps.beginRuntimeFetch = fetch;
    for (const key of ['nativeFetch']) deps[key] = { ...nativeHelper, beginRuntimeFetch: fetch };
  }
  deps.isAllowedImageHost = loadFunction('lib/imageStorage.ts', 'isAllowedImageHost', deps).fn;
  deps.isAllowedMime = loadFunction('lib/imageStorage.ts', 'isAllowedMime', deps).fn;
  const loaded = loadFunction(spec[1], spec[2], deps, spec[3]); facts.provenance = loaded.provenance;
  deps.ingestCampDatabase = loadFunction('services/campService.ts', 'ingestCampDatabase', deps).fn;
  const fn = label === 'camp-sync-refused' ? loadFunction(spec[1], spec[2], deps).fn : loaded.fn;
  const request = { query: { q: 'fixture', code: 'fixture-code', state: 'fixture-state' }, headers: { host: 'fixture-ui' }, protocol: 'http', sessionID: 'fixture-session', session: { save(done) { done(); } } };
  try {
    let completed = false;
    const operation = runtime.run('accepted-native-response-' + label, async () => {
      if (label.startsWith('avatar-')) return fn('fixture-user', 'fixture-hash');
      if (label.startsWith('image-')) { const image = await fn('https://static.wikia.nocookie.net/fixture.png', 1024, 1000); return image && { bytes: image.buf.length, contentType: image.contentType }; }
      if (spec[2].startsWith('/')) return fn(request, response);
      if (label.startsWith('wiki-') || label.startsWith('camp-image-')) return fn('https://static.wikia.nocookie.net/fixture.png');
      if (label.startsWith('verify-') || label.startsWith('dev-oauth-') || label.startsWith('dev-side-')) return fn('fixture-guild', '123456789012345678', 'fixture-token');
      if (label.startsWith('fandom-')) return fn({ action: 'query' });
      if (label.startsWith('steam-')) return fn('76561198000000000', 'fixture-key', fetch);
      if (label.startsWith('prod-verify-')) return fn('123456789012345678');
      if (label.startsWith('qa-identity-') || label.startsWith('dev-identity-')) return fn('fixture-token');
      if (label.startsWith('qa-guild-')) return fn('123456789012345678', 'fixture-token');
      if (label.startsWith('tenor-')) return fn(request, response, error => { throw error; });
      if (label.startsWith('role-')) return fn({ discord_id: '123456789012345678', role: 'admin', username: 'fixture' });
      if (label.startsWith('ticket-')) return fn({ author: { bot: false }, channel: { id: 'fixture-thread', isThread: () => true }, attachments: new Map([['fixture', { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/fixture/image.png', size: 100 }]]) });
      if (label.startsWith('minerva-')) return fn(1);
      return fn();
    }).then(value => { completed = true; facts.result = value === undefined ? 'undefined' : value; }, error => { completed = true; facts.rejected = true; facts.errorName = error.constructor.name; facts.errorMessage = error.message; });
    if (label.endsWith('-body-held')) {
      await started;
      facts.held = summary(await runtime.drain({ timeoutMs: 40 })); facts.completedAtCheckpoint = completed;
      releaseBody();
    }
    await operation;
    await pause(150);
    facts.socketsBeforeDrain = sockets.size;
    facts.beforeDrain = summary(runtime.snapshot());
    facts.responseClosuresBeforeIngressClose = facts.responsesClosed;
    facts.final = summary(await runtime.drain({ timeoutMs: 250, close: true, closeIngress: async () => {
      const closed = new Promise(resolve => server.close(resolve));
      // Native cancellation may open an idle replacement pool connection.
      // Response terminal facts and admitted-work completion are already
      // recorded above. Stop only this fixture's remaining local connections.
      server.closeAllConnections();
      await closed;
    } }));
    return facts;
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

if (require.main === module) {
  (async () => {
    const mode = process.argv[2];
    let result;
    if (mode === '--all') {
      const results = [];
      for (const [label] of cases) {
        const output = path.join(directory, label + '.json');
        const child = spawnSync(process.execPath, [__filename, label], { env: { ...process.env, RUNTIME_FIXTURE_OUTPUT: output }, encoding: 'utf8', timeout: 10000 });
        process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
        if (child.status !== 0 || !fs.existsSync(output)) throw Error('Native fixture process failed ' + label + ' status ' + child.status);
        results.push(JSON.parse(fs.readFileSync(output, 'utf8')));
      }
      result = { node: process.version, results };
    } else result = await runCase(mode);
    if (process.env.RUNTIME_FIXTURE_OUTPUT) fs.writeFileSync(process.env.RUNTIME_FIXTURE_OUTPUT, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
}
module.exports = { cases, functionExpression };
