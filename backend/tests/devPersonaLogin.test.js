const { makeDevPersonaCallbackHandler, makeDevPersonaStatusHandler } = require('../src/controllers/devPersonaLoginController');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
}

function callbackDeps(overrides = {}) {
  return {
    consumeState: async () => ({ installToken: 'install-1', persona: 'developer' }),
    exchangeCode: async () => ({ accessToken: 'oauth-token' }),
    fetchIdentity: async () => ({ id: 'discord-1', username: 'Developer' }),
    checkDeveloperAccess: async () => ({ discordUserId: 'discord-1', authorized: true }),
    issueSession: async () => ({ token: 'session-1', userId: 'user-1', displayName: 'System Developer', role: 'developer' }),
    storeGrant: async () => {},
    ...overrides,
  };
}

function callbackRequest(query) {
  return { query, headers: {}, protocol: 'https' };
}

describe('hosted DEV persona OAuth callback', () => {
  test('requires a valid dual-role authorization result before issuing a grant', async () => {
    const issueSession = jest.fn();
    const storeGrant = jest.fn();
    const storeDenial = jest.fn().mockResolvedValue(undefined);
    const handler = makeDevPersonaCallbackHandler(callbackDeps({
      checkDeveloperAccess: async () => ({
        discordUserId: 'discord-1',
        authorized: false,
        reason: 'Missing developer role in the prod guild.',
      }),
      issueSession,
      storeGrant,
      storeDenial,
    }));
    const res = response();

    await handler(callbackRequest({ code: 'code-1', state: 'state-1' }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/developer role/i);
    expect(issueSession).not.toHaveBeenCalled();
    expect(storeGrant).not.toHaveBeenCalled();
    expect(storeDenial).toHaveBeenCalledWith('install-1', 'Missing developer role in the prod guild.');
  });

  test('authorized developer receives a short-lived overlay grant', async () => {
    const grant = { token: 'session-1', userId: 'user-1', displayName: 'System Developer', role: 'developer' };
    const issueSession = jest.fn().mockResolvedValue(grant);
    const storeGrant = jest.fn().mockResolvedValue(undefined);
    const handler = makeDevPersonaCallbackHandler(callbackDeps({ issueSession, storeGrant }));
    const res = response();

    await handler(callbackRequest({ code: 'code-1', state: 'state-1' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/access granted|return to the app/i);
    expect(issueSession).toHaveBeenCalledWith('install-1', 'developer');
    expect(storeGrant).toHaveBeenCalledWith('install-1', grant);
  });

  test('expired or invalid OAuth state never issues a session', async () => {
    const issueSession = jest.fn();
    const handler = makeDevPersonaCallbackHandler(callbackDeps({
      consumeState: async () => null,
      issueSession,
    }));
    const res = response();

    await handler(callbackRequest({ code: 'code-1', state: 'expired' }), res);

    expect(res.statusCode).toBe(400);
    expect(issueSession).not.toHaveBeenCalled();
  });
});

describe('hosted DEV persona grant polling', () => {
  test('returns a grant once and deletes it', async () => {
    const grant = { token: 'session-1', userId: 'user-1', displayName: 'System Developer', role: 'developer' };
    const consumeGrant = jest.fn().mockResolvedValue(grant);
    const handler = makeDevPersonaStatusHandler({
      consumeGrant,
    });
    const res = response();

    await handler({ params: { installToken: 'install-1' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { authorized: true, ...grant } });
    expect(consumeGrant).toHaveBeenCalledWith('install-1');
  });

  test('reports pending when no grant exists', async () => {
    const handler = makeDevPersonaStatusHandler({ consumeGrant: async () => null });
    const res = response();

    await handler({ params: { installToken: 'install-1' } }, res);

    expect(res.body).toEqual({ data: { authorized: false } });
  });

  test('returns a denied result once and deletes it', async () => {
    const consumeDenial = jest.fn().mockResolvedValue('Missing developer role in the prod guild.');
    const handler = makeDevPersonaStatusHandler({
      consumeGrant: async () => null,
      consumeDenial,
    });
    const res = response();

    await handler({ params: { installToken: 'install-1' } }, res);

    expect(res.body).toEqual({ data: { authorized: false, error: 'Missing developer role in the prod guild.' } });
    expect(consumeDenial).toHaveBeenCalledWith('install-1');
  });
});
