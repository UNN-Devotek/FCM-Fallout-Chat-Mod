const express = require('express');
const request = require('supertest');

const env = require('../src/config/environment');
env.QA_BUILD_LOCK = true;

const { makeQaStatusHandler } = require('../src/controllers/qaStatusController');

function depsWith({ active = '1.4.0-qa', grant = null }) {
  const deleted = [];
  return {
    deleted,
    impl: {
      getActiveQaVersion: async () => active,
      readGrant: async () => grant,
      deleteGrant: async (it) => { deleted.push(it); },
    },
  };
}

function app(handler) {
  const a = express();
  a.get('/api/auth/qa-status/:installToken', handler);
  return a;
}

test('stale build (version mismatch, lock on) -> 426', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: { token: 't', displayName: 'X', role: 'user' } });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.3.0-qa');
  expect(res.status).toBe(426);
  expect(d.deleted).toHaveLength(0); // grant preserved; user just needs to update
});

test('current build + grant present -> authorized with token, grant consumed', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: { token: 'sess-1', userId: 'u1', displayName: 'Tester', role: 'user' } });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.4.0-qa');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { authorized: true, token: 'sess-1', displayName: 'Tester', role: 'user' } });
  expect(d.deleted).toEqual(['inst-1']);
});

test('current build, no grant yet -> authorized:false', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: null });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.4.0-qa');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { authorized: false } });
});
