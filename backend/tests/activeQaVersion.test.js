jest.mock('../src/config/redis', () => {
  const store = {};
  return {
    __store: store,
    getRedisClient: async () => ({
      get: async (k) => (k in store ? store[k] : null),
      set: async (k, v) => { store[k] = v; },
    }),
  };
});

const redisMock = require('../src/config/redis');
const env = require('../src/config/environment');
const { getActiveQaVersion, setActiveQaVersion, initActiveQaVersion } = require('../src/services/activeQaVersion');

beforeEach(() => {
  for (const k of Object.keys(redisMock.__store)) delete redisMock.__store[k];
});

test('get returns null when unset', async () => {
  expect(await getActiveQaVersion()).toBeNull();
});

test('set then get round-trips', async () => {
  await setActiveQaVersion('1.4.0-qa');
  expect(await getActiveQaVersion()).toBe('1.4.0-qa');
});

test('init seeds from env when key is empty', async () => {
  env.QA_ACTIVE_VERSION = '1.4.0-qa';
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBe('1.4.0-qa');
});

test('init does NOT overwrite an existing key', async () => {
  env.QA_ACTIVE_VERSION = '1.4.0-qa';
  await setActiveQaVersion('1.5.0-qa');
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBe('1.5.0-qa');
});

test('init is a no-op when env is empty', async () => {
  env.QA_ACTIVE_VERSION = '';
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBeNull();
});
