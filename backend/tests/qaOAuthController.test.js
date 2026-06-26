const express = require('express');
const request = require('supertest');

const env = require('../src/config/environment');
env.DEV_GUILD_ID = 'dev-guild-1';
env.DEV_QA_ROLE_ID = 'qa-role-1';

const { makeQaCallbackHandler } = require('../src/controllers/qaOAuthController');

function depsWith({ roles, installToken = 'inst-123' }) {
  const grants = {};
  const minted = [];
  return {
    grants,
    minted,
    impl: {
      consumeState: async () => installToken,
      exchangeCode: async () => ({ accessToken: 'access-tok' }),
      fetchIdentity: async () => ({ id: 'discord-1', username: 'Tester', global_name: 'Tester', avatar: null }),
      fetchDevGuildRoles: async () => roles,
      upsertUser: async (identity) => ({ id: 'user-1', displayName: identity.username }),
      mintSession: async (userId) => { const t = 'sess-' + userId; minted.push(t); return t; },
      storeGrant: async (it, grant) => { grants[it] = grant; },
    },
  };
}

function app(handler) {
  const a = express();
  a.get('/auth/discord/qa/callback', handler);
  return a;
}

test('user WITH the QA role -> session minted + grant stored + success page', async () => {
  const d = depsWith({ roles: ['qa-role-1'] });
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 's' });
  expect(res.status).toBe(200);
  expect(res.text).toMatch(/return to the app|QA access granted/i);
  expect(d.minted).toHaveLength(1);
  expect(d.grants['inst-123']).toMatchObject({ token: 'sess-user-1', role: 'user', displayName: 'Tester' });
});

test('user WITHOUT the QA role -> no grant, no session, denial page', async () => {
  const d = depsWith({ roles: ['other-role'] });
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 's' });
  expect(res.status).toBe(403);
  expect(res.text).toMatch(/QA role/i);
  expect(d.minted).toHaveLength(0);
  expect(d.grants['inst-123']).toBeUndefined();
});

test('invalid/expired state -> 400, nothing minted', async () => {
  const d = depsWith({ roles: ['qa-role-1'] });
  d.impl.consumeState = async () => null;
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 'bad' });
  expect(res.status).toBe(400);
  expect(d.minted).toHaveLength(0);
});
