jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { user: { findUnique: jest.fn() } } }));
jest.mock('../src/services/chatSlowmodeService', () => ({
  ...jest.requireActual('../src/services/chatSlowmodeService'),
  checkChatSlowmode: jest.fn(),
}));
const { checkChatSlowmode } = require('../src/services/chatSlowmodeService');
const prisma = require('../src/config/prisma').default;
beforeEach(() => { prisma.user.findUnique.mockResolvedValue({ discordId: 'discord' }); });
const { rejectChatSlowmode } = require('../src/websocket/chatSlowmode');
test('authenticated channel handlers stop blocked sends and provide shared retry timing', async () => {
  checkChatSlowmode.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 32000 });
  const ws = { send: jest.fn() }, actor = { id: 'account', discordId: 'discord' };
  expect(await rejectChatSlowmode(ws, actor)).toBe(true);
  expect(checkChatSlowmode).toHaveBeenCalledWith(actor);
  expect(ws.send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
    { type: 'rate:status', payload: { scope: 'chat', remaining: 0, retryAfterMs: 32000 } },
    { type: 'error', payload: { message: 'You are in cooldown. Please wait 32 seconds before sending another message.' } },
  ]);
});
test('allowed sends continue without a rejection frame', async () => {
  checkChatSlowmode.mockResolvedValue({ allowed: true, remaining: 1, retryAfterMs: 0 });
  const ws = { send: jest.fn() };
  expect(await rejectChatSlowmode(ws, { id: 'account' })).toBe(false);
  expect(ws.send).not.toHaveBeenCalled();
});

test('an open socket uses the current linked Discord identity after an account update', async () => {
  prisma.user.findUnique.mockResolvedValue({ discordId: 'new-discord' });
  checkChatSlowmode.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 35000 });
  expect(await rejectChatSlowmode({ send: jest.fn() }, { id: 'account', discordId: 'old-discord' })).toBe(true);
  expect(checkChatSlowmode).toHaveBeenLastCalledWith({ id: 'account', discordId: 'new-discord' });
});

test('a deleted or merged account cannot send using stale socket identity', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  checkChatSlowmode.mockClear();
  const ws = { send: jest.fn() };
  expect(await rejectChatSlowmode(ws, { id: 'deleted-account', discordId: 'discord' })).toBe(true);
  expect(checkChatSlowmode).not.toHaveBeenCalled();
  expect(JSON.parse(ws.send.mock.calls[0][0]).payload.message).toContain('account is unavailable');
});
