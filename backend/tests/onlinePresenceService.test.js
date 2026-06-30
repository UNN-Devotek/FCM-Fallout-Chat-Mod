function createFakeRedis() {
  const sets = new Map();

  return {
    multi() {
      const ops = [];
      return {
        del(key) {
          ops.push(() => { sets.delete(key); });
          return this;
        },
        sAdd(key, members) {
          ops.push(() => {
            const values = Array.isArray(members) ? members : [members];
            sets.set(key, new Set(values));
          });
          return this;
        },
        expire() {
          ops.push(() => {});
          return this;
        },
        async exec() {
          ops.forEach((op) => op());
          return [];
        },
      };
    },
    async sMembers(key) {
      return Array.from(sets.get(key) ?? []);
    },
    async *scanIterator({ MATCH }) {
      const prefix = MATCH.replace('*', '');
      for (const key of sets.keys()) {
        if (key.startsWith(prefix)) yield key;
      }
    },
    _sets: sets,
  };
}

describe('onlinePresenceService', () => {
  let fakeRedis;
  let service;

  beforeEach(() => {
    jest.resetModules();
    fakeRedis = createFakeRedis();

    jest.doMock('../src/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    jest.doMock('../src/config/redis', () => ({
      __esModule: true,
      getRedisClient: jest.fn().mockResolvedValue(fakeRedis),
    }));

    service = require('../src/services/onlinePresenceService');
  });

  test('deduplicates users across local sockets and backend instances', async () => {
    service.noteUserConnected('user-1');
    service.noteUserConnected('user-1');
    service.noteUserConnected('user-2');
    await service.flushLocalPresenceToRedis();

    fakeRedis._sets.set(`${service.ONLINE_USERS_KEY_PREFIX}other-instance`, new Set(['user-1', 'user-3']));

    await expect(service.getGlobalOnlineCount(0)).resolves.toBe(3);
  });

  test('keeps a user counted during disconnect grace until the grace expires', async () => {
    service.noteUserConnected('user-9');

    expect(service.noteUserPendingDisconnect('user-9')).toBe(true);
    await service.flushLocalPresenceToRedis();
    await expect(service.getGlobalOnlineCount(0)).resolves.toBe(1);

    service.noteUserDisconnected('user-9');
    await service.flushLocalPresenceToRedis();
    await expect(service.getGlobalOnlineCount(0)).resolves.toBe(0);
  });
});
