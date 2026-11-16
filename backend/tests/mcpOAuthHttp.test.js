const state = new Map();
const redis = {
  set: jest.fn(async (key, value, options = {}) => {
    if (options.NX && state.has(key)) return null;
    state.set(key, value); return 'OK';
  }),
  get: jest.fn(async key => state.get(key) ?? null),
  getDel: jest.fn(async key => { const value = state.get(key); state.delete(key); return value ?? null; }),
};
const authz = { issueAuthorizationCode: jest.fn(async () => ({ code: 'issued-code' })), exchangeAuthorizationCode: jest.fn(async () => ({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 600, scopes: ['fcm:read'] })), refresh: jest.fn(), revokeToken: jest.fn(async () => {}) };
const mockRoleAuth = jest.fn(async () => ({ authorized: true, role: 'admin' }));
const clients = { redirectUris: ['https://claude.ai/api/mcp/auth_callback'], metadata: { client_name: 'Claude' }, disabledAt: null };
const mockRegister = jest.fn(async body => { if (Object.prototype.hasOwnProperty.call(body, 'client_id')) throw new Error('client_id is assigned by the authorization server'); return { ...body, client_id: 'registered', client_id_issued_at: 1 }; });
const mockResolveClient = jest.fn(async () => clients);

jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
jest.mock('../src/middleware/rateLimiter', () => ({ mcpOAuthLimiter: (_req, _res, next) => next() }));
jest.mock('../src/services/mcpAuthorizationService', () => ({ MCP_SCOPES: ['fcm:read', 'fcm:discord:write', 'fcm:moderation:write'], McpOAuthError: class McpOAuthError extends Error { constructor(code, message) { super(message); this.code = code; } }, mcpAuthorizationService: authz }));
jest.mock('../src/services/mcpClientMetadataService', () => ({
  McpClientMetadataError: class extends Error {},
  registerOAuthClient: mockRegister,
  resolveOAuthClient: mockResolveClient,
  matchesRegisteredRedirectUri: (registeredUris, requested) => {
    if (registeredUris.includes(requested)) return true;
    const callback = new URL(requested);
    return registeredUris.some(registered => {
      const metadata = new URL(registered);
      return callback.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) && callback.port
        && metadata.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(metadata.hostname) && !metadata.port
        && metadata.hostname === callback.hostname && metadata.pathname === callback.pathname && metadata.search === callback.search;
    });
  },
}));
jest.mock('../src/services/mcpRoleService', () => ({ mcpRoleService: { authorize: mockRoleAuth } }));

const express = require('express');
const session = require('express-session');
const request = require('supertest');
const http = require('http');
const env = require('../src/config/environment');
env.NODE_ENV = 'production'; env.MCP_REMOTE_ENABLED = true; env.MCP_ISSUER_URL = 'https://falloutchatmod.com'; env.MCP_RESOURCE_URL = 'https://falloutchatmod.com/mcp'; env.MCP_OAUTH_STATE_SECRET = 'test-state-secret-that-is-at-least-32-chars'; env.DISCORD_CLIENT_ID = 'discord-client'; env.DISCORD_CLIENT_SECRET = 'discord-secret';
const router = require('../src/routes/mcpOAuth').default;

function app() {
  const value = express(); value.use(express.json({ limit: '64kb', verify: (req, _res, body) => { req.rawBody = body; } })); value.use(express.urlencoded({ extended: false, verify: (req, _res, body) => { req.rawBody = body; } })); value.use(session({ secret: 'test-session-secret-long-enough', resave: false, saveUninitialized: false })); value.use(router); return value;
}
async function chunkedPost(target, path, body) {
  const server = target.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); for (let i = 0; i < body.length; i += 1000) req.write(body.slice(i, i + 1000)); req.end();
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

describe('MCP OAuth HTTP routes', () => {
  beforeEach(() => { state.clear(); jest.clearAllMocks(); mockRoleAuth.mockResolvedValue({ authorized: true, role: 'admin' }); mockResolveClient.mockResolvedValue(clients); mockRegister.mockImplementation(async body => { if (Object.prototype.hasOwnProperty.call(body, 'client_id')) { const ErrorType = require('../src/services/mcpClientMetadataService').McpClientMetadataError; throw new ErrorType('client_id is assigned by the authorization server'); } return { ...body, client_id: 'registered', client_id_issued_at: 1 }; }); env.MCP_REMOTE_ENABLED = true; global.fetch = jest.fn(); });
  afterAll(() => { delete global.fetch; });

  test('kill switch covers discovery, registration, token, and revocation immediately', async () => {
    env.MCP_REMOTE_ENABLED = false;
    for (const [method, path] of [['get', '/.well-known/oauth-authorization-server'], ['post', '/oauth/register'], ['post', '/oauth/token'], ['post', '/oauth/revoke']]) {
      const response = await request(app())[method](path); expect(response.status).toBe(404); expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  test('disabled remote MCP never shadows unrelated or legacy routes mounted later', async () => {
    env.MCP_REMOTE_ENABLED = false;
    const value = app();
    value.get('/api/mcp', (_req, res) => res.status(200).json({ legacy: 'mcp' }));
    value.get('/api/mcp-admin', (_req, res) => res.status(200).json({ legacy: 'admin' }));
    value.get('/api/me/mcp-tokens', (_req, res) => res.status(200).json({ legacy: 'tokens' }));
    value.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));
    for (const path of ['/api/mcp', '/api/mcp-admin', '/api/me/mcp-tokens', '/api/health']) {
      const response = await request(value).get(path); expect(response.status).toBe(200); expect(response.body).not.toEqual({ error: 'temporarily_unavailable' });
    }
  });

  test('DCR requires JSON and enforces request size independently of parsers', async () => {
    expect((await request(app()).post('/oauth/register').type('form').send({ redirect_uris: 'x' })).status).toBe(415);
    expect((await request(app()).post('/oauth/register').send({ client_name: 'x'.repeat(40_000), redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).status).toBe(413);
    expect((await request(app()).post('/oauth/register').send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).status).toBe(201);
    const supplied = await request(app()).post('/oauth/register').send({ client_id: 'attacker', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    expect(supplied.status).toBe(400); expect(supplied.body.error).toBe('invalid_client_metadata');
  });

  test('raw OAuth form cap rejects percent-encoded and chunked oversized bodies', async () => {
    const encoded = `token=${'%41'.repeat(3000)}`;
    expect((await request(app()).post('/oauth/revoke').set('Content-Type', 'application/x-www-form-urlencoded').send(encoded)).status).toBe(413);
    expect(await chunkedPost(app(), '/oauth/token', encoded)).toBe(413);
  });

  test('authorize binds signed single-use state to session and preserves exact callback/client state', async () => {
    const agent = request.agent(app());
    const response = await agent.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'fcm:read', state: 'client-state' });
    expect(response.status).toBe(302); const discord = new URL(response.headers.location); const oauthState = discord.searchParams.get('state');
    expect(discord.searchParams.get('scope')).toBe('identify guilds.members.read'); expect(state.get(`mcp_oauth_state:${oauthState}`)).toContain('.');
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'discord-token' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) });
    const callback = await agent.get('/oauth/discord/callback').query({ code: 'discord-code', state: oauthState });
    expect(callback.status).toBe(200); expect(callback.text).toContain('Authorize Claude');
    expect(callback.headers['content-security-policy']).toContain("form-action 'self' https://claude.ai;");
    expect(callback.text).toContain('type="hidden" name="decision" value="approve"');
    expect(callback.text).toContain('type="submit" value="Authorize"');
    expect((await agent.get('/oauth/discord/callback').query({ code: 'discord-code', state: oauthState })).status).toBe(403);
    const consentToken = callback.text.match(/name="consent_token" value="([^"]+)"/)[1];
    const consent = await agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' });
    const redirect = new URL(consent.headers.location); expect(redirect.origin + redirect.pathname).toBe(clients.redirectUris[0]); expect(redirect.searchParams.get('state')).toBe('client-state'); expect(redirect.searchParams.get('code')).toBe('issued-code');
    const repeatedConsent = await agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' });
    expect(repeatedConsent.status).toBe(302); expect(new URL(repeatedConsent.headers.location).searchParams.get('code')).toBe('issued-code');
  });

  test('concurrent duplicate approvals return the same callback instead of racing', async () => {
    const agent = request.agent(app());
    const response = await agent.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'fcm:read', state: 'client-state' });
    const oauthState = new URL(response.headers.location).searchParams.get('state');
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'discord-token' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) });
    const callback = await agent.get('/oauth/discord/callback').query({ code: 'discord-code', state: oauthState });
    const consentToken = callback.text.match(/name="consent_token" value="([^"]+)"/)[1];
    authz.issueAuthorizationCode.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { code: 'issued-code' };
    });

    const [first, second] = await Promise.all([
      agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' }),
      agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' }),
    ]);

    expect(first.status).toBe(302); expect(second.status).toBe(302);
    expect(new URL(first.headers.location).searchParams.get('code')).toBe('issued-code');
    expect(new URL(second.headers.location).searchParams.get('code')).toBe('issued-code');
  });

  test('a consent decision cannot be changed after it is bound', async () => {
    const agent = request.agent(app());
    const response = await agent.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'fcm:read' });
    const oauthState = new URL(response.headers.location).searchParams.get('state');
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'discord-token' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) });
    const callback = await agent.get('/oauth/discord/callback').query({ code: 'discord-code', state: oauthState });
    const consentToken = callback.text.match(/name="consent_token" value="([^"]+)"/)[1];

    expect((await agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' })).status).toBe(302);
    const conflict = await agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'deny' });
    expect(conflict.status).toBe(302);
    const conflictRedirect = new URL(conflict.headers.location);
    expect(conflictRedirect.searchParams.get('error')).toBe('invalid_request');
    expect(conflictRedirect.searchParams.get('error_description')).toBe('Consent decision is already final');
  });

  test('does not redirect an unvalidated redirect and redirects post-validation errors', async () => {
    const untrusted = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: 'https://evil.example/cb', resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) });
    expect(untrusted.status).toBe(400); expect(untrusted.headers.location).toBeUndefined();
    const trusted = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'bad', state: 'kept' });
    expect(trusted.status).toBe(302); expect(trusted.headers.location).toContain('state=kept'); expect(trusted.headers.location).toContain('error=invalid_scope');
  });

  test('accepts repeated identical resource indicators but rejects conflicting ones', async () => {
    const base = { client_id: 'registered', redirect_uri: clients.redirectUris[0], response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) };
    const accepted = await request(app()).get('/oauth/authorize').query({ ...base, resource: [env.MCP_RESOURCE_URL, env.MCP_RESOURCE_URL] });
    expect(accepted.status).toBe(302); expect(accepted.headers.location).toContain('discord.com/api/oauth2/authorize');
    const rejected = await request(app()).get('/oauth/authorize').query({ ...base, resource: [env.MCP_RESOURCE_URL, 'https://evil.example/mcp'] });
    expect(rejected.status).toBe(302); expect(rejected.headers.location).toContain('error=invalid_request');
  });

  test('accepts Codex ephemeral loopback ports from portless client metadata', async () => {
    clients.redirectUris = ['http://127.0.0.1/callback/CkPYkR2KjUtX'];
    const response = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: 'http://127.0.0.1:40301/callback/CkPYkR2KjUtX', resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) });
    expect(response.status).toBe(302); expect(response.headers.location).toContain('discord.com/api/oauth2/authorize');
    clients.redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
  });

  test('consent page CSP permits the post-approval redirect to the exact loopback callback origin', async () => {
    clients.redirectUris = ['http://127.0.0.1/callback/CkPYkR2KjUtX'];
    try {
      const agent = request.agent(app());
      const redirectUri = 'http://127.0.0.1:40301/callback/CkPYkR2KjUtX';
      const response = await agent.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: redirectUri, resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'fcm:read' });
      const oauthState = new URL(response.headers.location).searchParams.get('state');
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'discord-token' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) });
      const callback = await agent.get('/oauth/discord/callback').query({ code: 'discord-code', state: oauthState });
      expect(callback.status).toBe(200);
      const policy = callback.headers['content-security-policy'];
      expect(policy).toContain("form-action 'self' http://127.0.0.1:40301;");
      expect(policy).not.toContain('/callback');
      const consentToken = callback.text.match(/name="consent_token" value="([^"]+)"/)[1];
      const consent = await agent.post('/oauth/authorize/consent').type('form').send({ consent_token: consentToken, decision: 'approve' });
      expect(consent.status).toBe(302); expect(new URL(consent.headers.location).origin).toBe('http://127.0.0.1:40301');
      expect(consent.headers['content-security-policy']).toContain("form-action 'self';");
    } finally { clients.redirectUris = ['https://claude.ai/api/mcp/auth_callback']; }
  });

  test('callback fails closed on browser-session mismatch and redirects a validated role denial', async () => {
    const first = request.agent(app());
    const started = await first.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'original' });
    const oauthState = new URL(started.headers.location).searchParams.get('state');
    const mismatch = await request(app()).get('/oauth/discord/callback').query({ code: 'x', state: oauthState });
    expect(mismatch.status).toBe(302); expect(mismatch.headers.location).toContain('error=access_denied');

    const second = request.agent(app());
    const startedAgain = await second.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'original' });
    const nextState = new URL(startedAgain.headers.location).searchParams.get('state');
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'discord-token' }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123456789012345678' }) });
    mockRoleAuth.mockResolvedValueOnce({ authorized: false, reason: 'role_missing' });
    const denied = await second.get('/oauth/discord/callback').query({ code: 'x', state: nextState });
    expect(denied.status).toBe(302); expect(denied.headers.location).toContain('error=access_denied'); expect(denied.headers.location).toContain('state=original');
  });

  test('Discord provider denial consumes verified state and redirects only the trusted callback', async () => {
    const agent = request.agent(app());
    const started = await agent.get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'client-kept' });
    const oauthState = new URL(started.headers.location).searchParams.get('state');
    const denied = await agent.get('/oauth/discord/callback').query({ error: 'access_denied', state: oauthState });
    expect(denied.status).toBe(302); expect(denied.headers.location).toContain('error=access_denied'); expect(denied.headers.location).toContain('state=client-kept'); expect(global.fetch).not.toHaveBeenCalled();
    expect((await agent.get('/oauth/discord/callback').query({ error: 'access_denied', state: oauthState })).status).toBe(403);
    expect((await request(app()).get('/oauth/discord/callback').query({ error: 'access_denied', state: 'unknown' })).headers.location).toBeUndefined();
  });

  test('uses standards-specific response, scope, and grant errors', async () => {
    const base = { client_id: 'registered', redirect_uri: clients.redirectUris[0], resource: env.MCP_RESOURCE_URL, code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 's' };
    expect((await request(app()).get('/oauth/authorize').query({ ...base, response_type: 'token' })).headers.location).toContain('error=unsupported_response_type');
    expect((await request(app()).get('/oauth/authorize').query({ ...base, response_type: 'code', scope: 'unknown' })).headers.location).toContain('error=invalid_scope');
    expect((await request(app()).post('/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: 'registered', resource: env.MCP_RESOURCE_URL })).body.error).toBe('unsupported_grant_type');
  });

  test.each([
    [{}, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ response_type: 'code' }, 'invalid_request'],
    [{ response_type: 'code', resource: 'https://other.example/mcp' }, 'invalid_target'],
    [{ response_type: 'code', resource: env.MCP_RESOURCE_URL, code_challenge_method: 'plain', code_challenge: 'a'.repeat(43) }, 'invalid_request'],
    [{ response_type: 'code', resource: env.MCP_RESOURCE_URL, code_challenge_method: 'S256', code_challenge: 'short' }, 'invalid_request'],
    [{ response_type: 'code', resource: env.MCP_RESOURCE_URL, code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), scope: 'bad' }, 'invalid_scope'],
  ])('redirects trusted authorization validation failures with %s', async (fields, expected) => {
    const response = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0], state: 'preserved', ...fields });
    expect(response.status).toBe(302); const target = new URL(response.headers.location); expect(target.searchParams.get('error')).toBe(expected); expect(target.searchParams.get('state')).toBe('preserved');
  });

  test.each([
    { redirect_uri: clients.redirectUris[0] },
    { client_id: 'registered' },
    { client_id: 'registered', redirect_uri: 'https://evil.example/cb' },
  ])('never redirects before both client and exact redirect are trusted', async query => {
    const response = await request(app()).get('/oauth/authorize').query({ ...query, response_type: 'token', state: 'preserved' });
    expect(response.status).toBe(400); expect(response.headers.location).toBeUndefined();
  });

  test('byte-distinct redirect strings are not treated as canonical equivalents', async () => {
    clients.redirectUris = ['https://claude.ai:443/api/mcp/auth_callback'];
    const rejected = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: env.MCP_RESOURCE_URL, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) });
    expect(rejected.status).toBe(400); expect(rejected.headers.location).toBeUndefined();
    clients.redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
  });

  test('token/revoke require form content and use OAuth wire names', async () => {
    expect((await request(app()).post('/oauth/token').send({})).status).toBe(415);
    const token = await request(app()).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', client_id: 'registered', resource: env.MCP_RESOURCE_URL, redirect_uri: clients.redirectUris[0], code: 'code', code_verifier: 'v'.repeat(43) });
    expect(token.body).toMatchObject({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', scope: 'fcm:read' });
    expect((await request(app()).post('/oauth/revoke').type('form').send({ token: 'at' })).status).toBe(200); expect(authz.revokeToken).toHaveBeenCalledWith('at');
  });

  test('unknown infrastructure errors never reflect secret-like messages', async () => {
    mockRegister.mockRejectedValueOnce(new Error('DB_PASSWORD=super-secret'));
    const dcr = await request(app()).post('/oauth/register').send({ redirect_uris: ['https://claude.ai/cb'] }); expect(dcr.status).toBe(500); expect(dcr.text).not.toContain('super-secret');
    authz.exchangeAuthorizationCode.mockRejectedValueOnce(new Error('redis://:secret@host'));
    const token = await request(app()).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', client_id: 'registered', resource: env.MCP_RESOURCE_URL }); expect(token.status).toBe(500); expect(token.text).not.toContain('secret@host'); expect(token.body.error).toBe('server_error');
    authz.revokeToken.mockRejectedValueOnce(new Error('database secret value'));
    const revoke = await request(app()).post('/oauth/revoke').type('form').send({ token: 'x' }); expect(revoke.status).toBe(503); expect(revoke.text).not.toContain('database secret');
    mockResolveClient.mockRejectedValueOnce(new Error('DNS_API_KEY=secret'));
    const authorize = await request(app()).get('/oauth/authorize').query({ client_id: 'registered', redirect_uri: clients.redirectUris[0] }); expect(authorize.status).toBe(500); expect(authorize.text).not.toContain('DNS_API_KEY'); expect(authorize.headers.location).toBeUndefined();
  });
});
