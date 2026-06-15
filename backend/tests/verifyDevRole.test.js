/**
 * Tests for the PROD-side narrow dev-role verification endpoint and the
 * dev-side fallback deps that consume it.
 *
 *   - controllers/verifyDevRoleController.makeVerifyDevRoleHandler
 *   - services/devAuthService.makeDevSideDeps
 *
 * Spec: docs/deployment/hosted-dev-environment.md
 *       § "Developer authorization — dual Discord role gate".
 *
 * The Discord bot member fetch is mocked (injected fetcher / prod-verify client)
 * — no network.
 */

const express = require('express');
const request = require('supertest');

const PROD_GUILD = 'prod-guild-1';
const PROD_ROLE = 'prod-dev-role';
const DEV_GUILD = 'dev-guild-1';
const DEV_ROLE = 'dev-dev-role';
const SERVICE_TOKEN = 'super-secret-service-token';

// environment.ts loads .env.local with override:true, which would clobber any
// process.env we set here. So we require the (cached) env object and overwrite
// its fields directly — the controller/service read from this same object.
const env = require('../src/config/environment');
env.PROD_GUILD_ID = PROD_GUILD;
env.PROD_DEVELOPER_ROLE_ID = PROD_ROLE;
env.DEV_GUILD_ID = DEV_GUILD;
env.DEV_DEVELOPER_ROLE_ID = DEV_ROLE;
env.PROD_VERIFY_TOKEN = SERVICE_TOKEN;
env.PROD_VERIFY_URL = 'https://prod.example/api/internal/verify-dev-role';

const { makeVerifyDevRoleHandler } = require('../src/controllers/verifyDevRoleController');
const { makeDevSideDeps, checkDeveloperAccess } = require('../src/services/devAuthService');

/** Build an express app mounting the handler with the supplied fake fetcher. */
function appWith(fetcher) {
  const app = express();
  app.get('/api/internal/verify-dev-role', makeVerifyDevRoleHandler(fetcher));
  return app;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/internal/verify-dev-role', () => {
  test('valid token + member WITH role -> hasDevRole:true', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE, 'someother']);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { hasDevRole: true } });
    expect(fetcher).toHaveBeenCalledWith(PROD_GUILD, '123456789');
  });

  test('valid token + member WITHOUT role -> hasDevRole:false', async () => {
    const fetcher = jest.fn(async () => ['unrelated-role']);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { hasDevRole: false } });
  });

  test('member NOT in guild (null) -> hasDevRole:false (not an error)', async () => {
    const fetcher = jest.fn(async () => null);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { hasDevRole: false } });
  });

  test('missing service token -> 403', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE]);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' });
    expect(res.status).toBe(403);
    expect(res.body.title).toBe('Forbidden');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('invalid service token -> 403', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE]);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth('wrong-token'));
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('missing discordId -> 400', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE]);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('non-numeric discordId -> 400', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE]);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: 'not-a-snowflake' })
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('fetcher throws (transport failure) -> 502, never leaks false', async () => {
    const fetcher = jest.fn(async () => { throw new Error('discord down'); });
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth(SERVICE_TOKEN));
    expect(res.status).toBe(502);
  });

  test('response leaks ONLY hasDevRole — no roles/usernames', async () => {
    const fetcher = jest.fn(async () => [PROD_ROLE, 'secret-role']);
    const res = await request(appWith(fetcher))
      .get('/api/internal/verify-dev-role')
      .query({ discordId: '123456789' })
      .set(auth(SERVICE_TOKEN));
    expect(Object.keys(res.body.data)).toEqual(['hasDevRole']);
    expect(JSON.stringify(res.body)).not.toContain('secret-role');
  });
});

describe('makeDevSideDeps (dev-side fallback path)', () => {
  test('prod-guild read delegates to prod verify; true -> prod role synthesized', async () => {
    const prodVerify = jest.fn(async () => true);
    const deps = makeDevSideDeps(prodVerify, 'dev-bot-token');
    const roles = await deps.fetchGuildMemberRoles(PROD_GUILD, 'user-1', '');
    expect(prodVerify).toHaveBeenCalledWith('user-1');
    expect(roles).toEqual([PROD_ROLE]);
  });

  test('prod-guild read; false -> empty roles', async () => {
    const prodVerify = jest.fn(async () => false);
    const deps = makeDevSideDeps(prodVerify, 'dev-bot-token');
    const roles = await deps.fetchGuildMemberRoles(PROD_GUILD, 'user-1', '');
    expect(roles).toEqual([]);
  });

  test('checkDeveloperAccess: prod true + dev role present -> authorized', async () => {
    const prodVerify = jest.fn(async () => true);
    const deps = makeDevSideDeps(prodVerify, 'dev-bot-token');
    // Stub the dev-guild branch by overriding fetch on dev guild via spy.
    const orig = deps.fetchGuildMemberRoles.bind(deps);
    deps.fetchGuildMemberRoles = async (guildId, userId, tok) =>
      guildId === DEV_GUILD ? [DEV_ROLE] : orig(guildId, userId, tok);

    const r = await checkDeveloperAccess('user-1', deps, '');
    expect(r.authorized).toBe(true);
  });

  test('checkDeveloperAccess: prod false -> denied (prod guild)', async () => {
    const prodVerify = jest.fn(async () => false);
    const deps = makeDevSideDeps(prodVerify, 'dev-bot-token');
    deps.fetchGuildMemberRoles = (function (orig) {
      return async (guildId, userId, tok) =>
        guildId === DEV_GUILD ? [DEV_ROLE] : orig(guildId, userId, tok);
    })(deps.fetchGuildMemberRoles.bind(deps));

    const r = await checkDeveloperAccess('user-1', deps, '');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/prod guild/i);
  });
});
