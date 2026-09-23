const lists = new Map();
const redis = {
  lPush: jest.fn(async (key, value) => { lists.set(key, [value, ...(lists.get(key) ?? [])]); }),
  lTrim: jest.fn(async (key, start, end) => { lists.set(key, (lists.get(key) ?? []).slice(start, end + 1)); }),
  expire: jest.fn(async () => true),
  lRange: jest.fn(async (key, start, end) => (lists.get(key) ?? []).slice(start, end + 1)),
};
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
jest.mock('../src/config/environment', () => ({ __esModule: true, default: {
  HUD_IDENTITY_HASH_SECRET: 'private-diagnostic-test-secret',
} }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

const {
  parseHudRoomDiagnostic, recordRoomDiagnostic, listRoomDiagnostics, rosterNameRef,
} = require('../src/services/relay/roomDiagnostics');
const { getRoomDiagnostics } = require('../src/controllers/roomDiagnosticsController');

beforeEach(() => { lists.clear(); jest.clearAllMocks(); });

test('accepts only the bounded allowlisted HUD diagnostic schema', () => {
  expect(parseHudRoomDiagnostic('FCMCTL/1/DIAG:event=roster_hold;provider=zfe;source=MapMenuData;count=0;build=2.10.114'))
    .toEqual({ event: 'roster_hold', provider: 'zfe', source: 'MapMenuData', rosterCount: 0, build: '2.10.114' });
  for (const body of [
    'FCMCTL/1/DIAG:event=freeform;provider=zfe;source=MapMenuData;count=0;build=2.10.114',
    'FCMCTL/1/DIAG:event=roster_hold;provider=evil;source=MapMenuData;count=0;build=2.10.114',
    'FCMCTL/1/DIAG:event=roster_hold;provider=zfe;source=PrivateName;count=0;build=2.10.114',
    'FCMCTL/1/DIAG:event=roster_hold;provider=zfe;source=MapMenuData;count=25;build=2.10.114',
    'FCMCTL/1/DIAG:event=roster_hold;provider=zfe;source=MapMenuData;count=0;build=2.10.114;message=private',
  ]) expect(parseHudRoomDiagnostic(body)).toBeNull();
});

test('stores bounded global and per-user evidence without raw identifiers', async () => {
  const userId = `user_${'1'.repeat(32)}`;
  await recordRoomDiagnostic(userId, { event: 'roster_observed', rosterRefs: [rosterNameRef('privateplayer')] });
  const global = await listRoomDiagnostics(undefined, 10);
  const perUser = await listRoomDiagnostics(userId, 10);
  expect(global).toEqual(perUser);
  expect(global[0]).toMatchObject({ event: 'roster_observed', userRef: expect.stringMatching(/^[0-9a-f]{12}$/) });
  expect(JSON.stringify(global)).not.toContain(userId);
  expect(JSON.stringify(global)).not.toContain('privateplayer');
  expect(redis.lTrim).toHaveBeenCalled();
  expect(redis.expire).toHaveBeenCalled();
});

test('admin reader accepts relay identities and rejects unrelated identifiers', async () => {
  const userId = `user_${'a'.repeat(32)}`;
  await recordRoomDiagnostic(userId, { event: 'roster_observed' });
  const json = jest.fn();
  const next = jest.fn();
  await getRoomDiagnostics({ query: { userId, limit: '10' } }, { json }, next);
  expect(next).not.toHaveBeenCalled();
  expect(json).toHaveBeenCalledWith({ data: { scope: 'user', count: 1, items: expect.any(Array) } });

  await getRoomDiagnostics({ query: { userId: '11111111-1111-4111-8111-111111111111' } }, { json }, next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
});
