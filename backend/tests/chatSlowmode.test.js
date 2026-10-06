const mockEval = jest.fn();
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn(async () => ({ eval: mockEval })) }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
const { checkChatSlowmode, chatSlowmodeKey, chatSlowmodeMessage, CHAT_SLOWMODE_SCRIPT } = require('../src/services/chatSlowmodeService');

beforeEach(() => mockEval.mockReset());
test('linked clients and Discord use the same identity; unlinked accounts remain distinct', () => {
  expect(chatSlowmodeKey({ id: 'overlay-account', discordId: '123' })).toBe(chatSlowmodeKey({ id: '123', discordId: '123' }));
  expect(chatSlowmodeKey({ id: 'hud-account', discordId: '123' })).toBe('chat_slowmode:discord:123');
  expect(chatSlowmodeKey({ id: '123' })).toBe('chat_slowmode:account:123');
});
test('uses an atomic shared operation with the agreed burst, window and cooldown', async () => {
  mockEval.mockResolvedValue([1, 2, 0]);
  await expect(checkChatSlowmode({ id: 'account', discordId: '123' })).resolves.toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
  expect(mockEval).toHaveBeenCalledWith(CHAT_SLOWMODE_SCRIPT, { keys: ['chat_slowmode:discord:123'], arguments: ['60000', '35000', '3'] });
});
test('returns the actual remaining cooldown and rounds the notice upward', async () => {
  mockEval.mockResolvedValue([0, 0, 34001]);
  await expect(checkChatSlowmode({ id: 'a' })).resolves.toEqual({ allowed: false, remaining: 0, retryAfterMs: 34001 });
  expect(chatSlowmodeMessage(34001)).toBe('You are in cooldown. Please wait 35 seconds before sending another message.');
});
test.each([null, 'invalid', [1], [1, 'two', 0]])('fails closed for an invalid response: %j', async value => {
  mockEval.mockResolvedValue(value);
  expect((await checkChatSlowmode({ id: 'a' })).allowed).toBe(false);
});
test('fails closed during a Redis outage', async () => {
  mockEval.mockRejectedValue(new Error('offline'));
  await expect(checkChatSlowmode({ id: 'a' })).resolves.toEqual({ allowed: false, remaining: 0, retryAfterMs: 5000 });
});
