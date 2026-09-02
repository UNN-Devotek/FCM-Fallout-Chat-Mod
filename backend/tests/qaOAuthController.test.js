const express = require('express');
const request = require('supertest');

// Prisma mock for the real defaultQaCallbackDeps.upsertUser detach-then-upsert path.
const prismaMock = {
  user: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn().mockResolvedValue({ id: 'user-1', username: 'discord:discord-1' }),
  },
};
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));

const env = require('../src/config/environment');
env.DEV_GUILD_ID = 'dev-guild-1';
env.DEV_QA_ROLE_ID = 'qa-role-1';

const { makeQaCallbackHandler, defaultQaCallbackDeps } = require('../src/controllers/qaOAuthController');

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

// Regression: a returning tester who reinstalls (new installToken) must not hit
// the User.discordId @unique constraint, even when their PRIOR row has a real
// onboarded username (not a `discord:`/`pending-` placeholder). The detach must
// release the link from ANY other install, scoped only by `NOT: { installToken }`.
describe('defaultQaCallbackDeps.upsertUser — discordId detach before upsert', () => {
  const identity = { id: 'discord-1', username: 'Tester', global_name: 'Tester', avatar: null };

  beforeEach(() => {
    prismaMock.user.updateMany.mockClear().mockResolvedValue({ count: 1 });
    prismaMock.user.upsert.mockClear().mockResolvedValue({ id: 'user-1', username: 'discord:discord-1' });
  });

  test('detaches the discordId from other installs without restricting by username', async () => {
    await defaultQaCallbackDeps.upsertUser(identity, 'inst-new');

    expect(prismaMock.user.updateMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.user.updateMany.mock.calls[0][0].where;
    expect(where.discordId).toBe('discord-1');
    expect(where.NOT).toEqual({ installToken: 'inst-new' });
    // The bug was an extra username scope that skipped real-name rows — assert it's gone.
    expect(where.OR).toBeUndefined();
    expect(JSON.stringify(where)).not.toMatch(/username/);
  });

  test('detach runs before the upsert (so the unique link is free)', async () => {
    const order = [];
    prismaMock.user.updateMany.mockImplementation(async () => { order.push('updateMany'); return { count: 1 }; });
    prismaMock.user.upsert.mockImplementation(async () => { order.push('upsert'); return { id: 'user-1', username: 'discord:discord-1' }; });

    await defaultQaCallbackDeps.upsertUser(identity, 'inst-new');

    expect(order).toEqual(['updateMany', 'upsert']);
    expect(prismaMock.user.upsert.mock.calls[0][0].where).toEqual({ installToken: 'inst-new' });
  });
});
