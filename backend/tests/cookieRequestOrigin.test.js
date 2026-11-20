const express = require('express');
const request = require('supertest');
const { requireCookieRequestOrigin } = require('../src/middleware/cookieRequestOrigin');
const { errorHandler } = require('../src/middleware/errorHandler');

function fixture() {
  let writes = 0;
  const app = express();
  app.use(requireCookieRequestOrigin(['https://dashboard.example:444', 'https://api.example/oauth']));
  app.post('/write', (_req, res) => res.json({ writes: ++writes }));
  app.get('/callback', (_req, res) => res.sendStatus(204));
  app.use(errorHandler);
  return { app, writes: () => writes };
}

test.each([
  {},
  { Origin: 'null', Referer: 'https://dashboard.example:444/page' },
  { Origin: 'https://attacker.example' },
  { Origin: 'https://dashboard.example:444.attacker.example' },
  { Origin: 'https://dashboard.example' },
  { Origin: 'http://dashboard.example:444' },
  { Origin: 'https://dashboard.example:444/path' },
  { Referer: 'https://attacker.example/?next=https://dashboard.example:444' },
])('rejects an untrusted or missing cookie-write origin: %j', async headers => {
  const { app, writes } = fixture();
  const response = await request(app).post('/write').set('Cookie', 'connect.sid=synthetic').set(headers);
  expect(response.status).toBe(403);
  expect(response.body.status).toBe(403);
  expect(writes()).toBe(0);
});

test.each([
  { Origin: 'https://dashboard.example:444' },
  { Origin: 'https://api.example' },
  { Referer: 'https://dashboard.example:444/settings?tab=profile' },
])('allows configured browser writes without replacing later auth: %j', async headers => {
  const { app } = fixture();
  const response = await request(app).post('/write').set('Cookie', 'connect.sid=synthetic').set(headers);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ writes: 1 });
});

test('preserves cookie-free native/Bearer requests and OAuth callback navigation', async () => {
  const { app } = fixture();
  expect((await request(app).post('/write').set('Authorization', 'Bearer synthetic')).status).toBe(200);
  expect((await request(app).get('/callback').set('Cookie', 'connect.sid=synthetic').set('Origin', 'https://discord.example')).status).toBe(204);
});
