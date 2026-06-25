const express = require('express');
const request = require('supertest');

const setMock = jest.fn(async () => {});
const getMock = jest.fn(async () => '1.4.0-qa');
jest.mock('../src/services/activeQaVersion', () => ({
  setActiveQaVersion: (...a) => setMock(...a),
  getActiveQaVersion: (...a) => getMock(...a),
}));

const env = require('../src/config/environment');
env.ADMIN_API_KEY = 'test-admin-key';
const { requireAdminKey } = require('../src/middleware/requireAdminKey');
const { setQaActiveVersion, getQaActiveVersion } = require('../src/controllers/qaVersionController');

function app() {
  const a = express();
  a.use(express.json());
  a.post('/api/admin/qa/active-version', requireAdminKey, setQaActiveVersion);
  a.get('/api/admin/qa/active-version', requireAdminKey, getQaActiveVersion);
  return a;
}

beforeEach(() => { setMock.mockClear(); getMock.mockClear(); });

test('POST without admin key -> 401', async () => {
  const res = await request(app()).post('/api/admin/qa/active-version').send({ version: '1.4.0-qa' });
  expect(res.status).toBe(401);
  expect(setMock).not.toHaveBeenCalled();
});

test('POST with key + version -> 200 and stores it', async () => {
  const res = await request(app())
    .post('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key')
    .send({ version: '1.4.0-qa' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { activeVersion: '1.4.0-qa' } });
  expect(setMock).toHaveBeenCalledWith('1.4.0-qa');
});

test('POST with key but no version -> 400', async () => {
  const res = await request(app())
    .post('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key')
    .send({});
  expect(res.status).toBe(400);
});

test('GET with key -> current active version', async () => {
  const res = await request(app())
    .get('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { activeVersion: '1.4.0-qa' } });
});
