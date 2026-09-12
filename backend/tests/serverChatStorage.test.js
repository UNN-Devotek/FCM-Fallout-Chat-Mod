const redis = { lPush: jest.fn(), lTrim: jest.fn(), expire: jest.fn(), publish: jest.fn() };
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
const { publishServerMessage, SERVER_EVENTS_CHANNEL } = require('../src/services/relay/serverChat');
beforeEach(() => { for (const fn of Object.values(redis)) fn.mockReset().mockResolvedValue(1); });
test.each(['lPush', 'lTrim', 'expire', 'publish'])('rejects failed %s rather than issuing a false success', async operation => {
  redis[operation].mockRejectedValue(new Error(operation));
  await expect(publishServerMessage('r:one', 7, { id: 7 })).rejects.toThrow(operation);
});
test('stores and publishes exactly one canonical event', async () => {
  const event = { id: 7, messageId: 'server:r:one:7' };
  await publishServerMessage('r:one', 7, event);
  expect(redis.lPush).toHaveBeenCalledTimes(1); expect(redis.publish).toHaveBeenCalledTimes(1);
  expect(redis.publish).toHaveBeenCalledWith(SERVER_EVENTS_CHANNEL, JSON.stringify({ kind: 'msg', worldId: 'r:one', cursor: 7, event }));
});
