const { EventEmitter } = require('events');
const { validateClientMetadata, validateRedirectUri, matchesRegisteredRedirectUri, McpClientMetadataError, fetchClientMetadataJson, resolveOAuthClient, registerOAuthClient, clearCimdCacheForTests } = require('../src/services/mcpClientMetadataService');
const { authorizationServerMetadata, protectedResourceMetadata } = require('../src/controllers/mcpOAuthController');

function response() {
  return { payload: null, json(value) { this.payload = value; return this; } };
}

describe('MCP OAuth discovery and client validation', () => {
  beforeEach(() => { clearCimdCacheForTests(); jest.clearAllMocks(); });
  test('publishes RFC 8414 authorization-server metadata with PKCE and registration', () => {
    const res = response(); authorizationServerMetadata({}, res);
    expect(res.payload.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(res.payload.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.payload.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(res.payload.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.payload.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  test('publishes protected-resource metadata bound to the MCP audience', () => {
    const res = response(); protectedResourceMetadata({}, res);
    expect(res.payload.resource).toMatch(/\/mcp$/);
    expect(res.payload.authorization_servers).toHaveLength(1);
  });

  test.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'http://127.0.0.1:49152/callback',
    'http://[::1]:54321/oauth/callback',
    'http://localhost:3000/callback',
  ])('accepts an exact safe client callback: %s', uri => expect(validateRedirectUri(uri)).toBe(new URL(uri).href));

  test.each([
    'http://example.com/callback',
    'ftp://example.com/callback',
    'https://user:pass@example.com/callback',
    'https://example.com/callback#fragment',
  ])('rejects unsafe callback: %s', uri => expect(() => validateRedirectUri(uri)).toThrow(McpClientMetadataError));

  test('allows only an ephemeral port for a portless registered HTTP loopback callback', () => {
    const registered = ['http://127.0.0.1/callback/codex', 'http://localhost/callback/codex'];
    expect(matchesRegisteredRedirectUri(registered, 'http://127.0.0.1:40301/callback/codex')).toBe(true);
    expect(matchesRegisteredRedirectUri(registered, 'http://localhost:49152/callback/codex')).toBe(true);
    expect(matchesRegisteredRedirectUri(registered, 'http://127.0.0.1:40301/callback/other')).toBe(false);
    expect(matchesRegisteredRedirectUri(registered, 'http://127.0.0.2:40301/callback/codex')).toBe(false);
    expect(matchesRegisteredRedirectUri(['https://client.example/callback'], 'https://client.example:443/callback')).toBe(false);
  });

  test('accepts only public authorization-code clients and preserves CIMD identity', () => {
    expect(validateClientMetadata({ client_id: 'https://client.example/metadata.json', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })).toMatchObject({ client_id: 'https://client.example/metadata.json', client_name: 'Claude' });
    expect(() => validateClientMetadata({ redirect_uris: ['https://ok.example/cb'], token_endpoint_auth_method: 'client_secret_post' })).toThrow('only public clients');
    expect(() => validateClientMetadata({ redirect_uris: ['https://ok.example/cb', 'https://ok.example/cb'] })).toThrow('unique');
    expect(() => validateClientMetadata({ redirect_uris: ['https://ok.example/cb'], grant_types: ['client_credentials'] })).toThrow('unsupported grant_type');
  });

  test('DCR rejects caller-owned client_id and keeps generated fields server-owned', async () => {
    await expect(registerOAuthClient({ client_id: 'attacker', redirect_uris: ['https://claude.ai/cb'] })).rejects.toThrow('assigned by the authorization server');
    const registered = await registerOAuthClient({ redirect_uris: ['https://claude.ai/cb'] }, { create: jest.fn(async ({ data }) => data) });
    expect(registered.client_id).toMatch(/^fcm_client_/); expect(registered.client_id_issued_at).toEqual(expect.any(Number));
  });

  function transport(responses) {
    const request = jest.fn((_url, _options, callback) => {
      const req = new EventEmitter(); let response; req.setTimeout = jest.fn();
      req.destroy = error => { if (req.destroyed) return; req.destroyed = true; queueMicrotask(() => { if (error) req.emit('error', error); response?.destroy(error); req.emit('close'); }); };
      req.end = () => {
        const item = responses.shift(); response = new EventEmitter(); response.statusCode = item.status ?? 200; response.headers = item.headers ?? { 'content-type': 'application/json' }; response.resume = jest.fn();
        response.destroy = error => { if (response.destroyed) return; response.destroyed = true; queueMicrotask(() => { if (error) response.emit('error', error); response.emit('close'); req.destroy(); }); }; callback(response);
        queueMicrotask(() => { if (response.destroyed) return; if (item.body) response.emit('data', Buffer.from(item.body)); if (response.destroyed) return; response.emit('end'); response.destroy(); });
      }; return req;
    });
    return request;
  }

  test('CIMD requires exact client_id and reuses only an unexpired bounded cache', async () => {
    const clientId = 'https://client.example/metadata.json'; let now = 1000;
    const request = transport([
      { body: JSON.stringify({ client_id: clientId, client_name: 'Client', redirect_uris: ['https://claude.ai/cb'] }) },
      { body: JSON.stringify({ client_id: clientId, client_name: 'Client', redirect_uris: ['https://claude.ai/new'] }) },
    ]);
    const fetch = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request };
    const db = { findUnique: jest.fn(async () => null), upsert: jest.fn(async ({ create }) => ({ ...create, disabledAt: null })) };
    await resolveOAuthClient(clientId, { fetch, db, now: () => now }); await resolveOAuthClient(clientId, { fetch, db, now: () => now }); expect(request).toHaveBeenCalledTimes(1);
    now += 300001; await resolveOAuthClient(clientId, { fetch, db, now: () => now }); expect(request).toHaveBeenCalledTimes(2);
    clearCimdCacheForTests();
    await expect(resolveOAuthClient(clientId, { db, fetch: { ...fetch, request: transport([{ body: JSON.stringify({ client_name: 'Client', redirect_uris: ['https://claude.ai/cb'] }) }]) } })).rejects.toThrow('client_id is required');
    await expect(resolveOAuthClient(clientId, { db, fetch: { ...fetch, request: transport([{ body: JSON.stringify({ client_id: 'https://other.example/meta', client_name: 'Client', redirect_uris: ['https://claude.ai/cb'] }) }]) } })).rejects.toThrow('exactly match');
    await expect(resolveOAuthClient('https://client.example/', { db, fetch: { ...fetch, request: transport([{ body: JSON.stringify({ client_id: 'https://client.example/', client_name: 'Client', redirect_uris: ['https://claude.ai/cb'] }) }]) } })).rejects.toThrow('metadata path');
    await expect(resolveOAuthClient(clientId, { db, fetch: { ...fetch, request: transport([{ body: JSON.stringify({ client_id: clientId, redirect_uris: ['https://claude.ai/cb'] }) }]) } })).rejects.toThrow('client_name');
  });

  test('CIMD fetch rejects private DNS, wrong content type, oversized content, and unsafe redirects', async () => {
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: transport([]) })).rejects.toThrow('not public');
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: transport([{ headers: { 'content-type': 'text/html' }, body: '{}' }]) })).rejects.toThrow('JSON media type');
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: transport([{ headers: { 'content-type': 'application/client-metadata+json; charset=utf-8' }, body: '{}' }]) })).resolves.toEqual({});
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: transport([{ headers: { 'content-type': 'application/jsonp' }, body: '{}' }]) })).rejects.toThrow('JSON media type');
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: transport([{ body: 'x'.repeat(65537) }]) })).rejects.toThrow('too large');
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: transport([{ status: 302, headers: { location: 'http://127.0.0.1/meta' } }]) })).rejects.toThrow('redirects are not allowed');
    let lookups = 0;
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), {
      lookup: async () => ++lookups === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      request: transport([{ status: 302, headers: { location: 'https://internal.example/meta' } }]),
    })).rejects.toThrow('redirects are not allowed'); expect(lookups).toBe(1);
    const timeoutRequest = jest.fn(() => { const req = new EventEmitter(); req.setTimeout = (_ms, callback) => queueMicrotask(callback); req.destroy = error => { queueMicrotask(() => { req.emit('error', error); req.emit('close'); }); }; req.end = jest.fn(); return req; });
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), { lookup, request: timeoutRequest })).rejects.toThrow('timed out');
  });

  test.each([
    ['0.1.2.3', 4], ['10.1.2.3', 4], ['100.64.0.1', 4], ['169.254.1.1', 4],
    ['172.16.0.1', 4], ['192.0.2.1', 4], ['192.31.196.1', 4], ['192.52.193.1', 4],
    ['192.88.99.1', 4], ['192.175.48.1', 4], ['198.18.0.1', 4], ['198.51.100.1', 4],
    ['203.0.113.1', 4], ['224.0.0.1', 4], ['240.0.0.1', 4],
    ['::1', 6], ['::ffff:127.0.0.1', 6], ['64:ff9b:1::1', 6], ['100::1', 6],
    ['2001:db8::1', 6], ['3ffe::1', 6], ['3fff::1', 6], ['5f00::1', 6], ['fe80::1', 6], ['ff02::1', 6],
  ])('CIMD rejects special-use address %s', async (address, family) => {
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), {
      lookup: async () => [{ address, family }], request: transport([]),
    })).rejects.toThrow('not public');
  });

  test.each([
    ['8.8.8.8', 4], ['93.184.216.34', 4], ['2606:4700:4700::1111', 6],
  ])('CIMD permits globally routable address %s', async (address, family) => {
    await expect(fetchClientMetadataJson(new URL('https://client.example/meta'), {
      lookup: async () => [{ address, family }], request: transport([{ body: '{}' }]),
    })).resolves.toEqual({});
  });
});
