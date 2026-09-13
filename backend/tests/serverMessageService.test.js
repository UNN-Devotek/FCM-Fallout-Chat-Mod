const prisma = { user: { findUnique: jest.fn() } };
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prisma }));
jest.mock('../src/services/autoModEngine', () => ({ engineEvaluate: jest.fn() }));
jest.mock('../src/services/cosmetics/cosmeticsService', () => ({ attachCosmetics: jest.fn() }));
jest.mock('../src/services/supporterSyncService', () => ({ refreshSupporterFromHudSend: jest.fn() }));
jest.mock('../src/services/relay/worldIdService', () => ({ getWorldId: jest.fn() }));
jest.mock('../src/services/relay/relaySeq', () => ({ nextRelaySeq: jest.fn() }));
jest.mock('../src/services/relay/serverChat', () => ({ checkServerRateLimit: jest.fn(), publishServerMessage: jest.fn() }));
const { engineEvaluate } = require('../src/services/autoModEngine');
const { attachCosmetics } = require('../src/services/cosmetics/cosmeticsService');
const { getWorldId } = require('../src/services/relay/worldIdService');
const { nextRelaySeq } = require('../src/services/relay/relaySeq');
const { checkServerRateLimit, publishServerMessage } = require('../src/services/relay/serverChat');
const { sendServerMessage } = require('../src/services/relay/serverMessageService');
const actor = { accountId: 'account-a', relayUserId: 'user_a', displayName: 'Alice' };
beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ isBanned: false, isMuted: false, kickedUntil: null, discordId: 'discord-a' });
  engineEvaluate.mockResolvedValue({ block: false }); getWorldId.mockResolvedValue('r:one');
  checkServerRateLimit.mockResolvedValue(true); nextRelaySeq.mockResolvedValue(42); publishServerMessage.mockResolvedValue(undefined);
  attachCosmetics.mockImplementation(async m => Object.assign(m, { nameColor: '#00ff00', tag: 'Tag', badges: ['supporter'], starColor: '#ffaa00' }));
});
test('native and desktop use one governed event with stable room ID and original account attribution', async () => {
  const result = await sendServerMessage(actor, 'r:one', 'hello');
  expect(result).toMatchObject({ messageId: 'server:r:one:42', senderUserId: 'user_a', linkedUserId: 'account-a', nameColor: '#00ff00', supporterStar: true });
  expect(checkServerRateLimit).toHaveBeenCalledWith('account-a');
  expect(engineEvaluate).toHaveBeenCalledWith('hello', undefined, { id: 'account-a', username: 'Alice' });
  expect(publishServerMessage).toHaveBeenCalledTimes(1);
  expect(publishServerMessage).toHaveBeenCalledWith('r:one', 42, result);
});
test.each([[{ isBanned: true }, 'user_banned'], [{ isMuted: true }, 'user_muted'], [{ kickedUntil: new Date(Date.now() + 60000) }, 'user_kicked'], [null, 'user_banned']])('moderation/account gate is fresh for each send', async (user, code) => {
  prisma.user.findUnique.mockResolvedValue(user);
  await expect(sendServerMessage(actor, 'r:one', 'hello')).rejects.toMatchObject({ code });
  expect(publishServerMessage).not.toHaveBeenCalled();
});
test('automod and account flood guard apply before publication', async () => {
  engineEvaluate.mockResolvedValue({ block: true });
  await expect(sendServerMessage(actor, 'r:one', 'hello')).rejects.toMatchObject({ code: 'message_blocked' });
  checkServerRateLimit.mockResolvedValue(false);
  await expect(sendServerMessage(actor, 'r:one', 'hello')).rejects.toMatchObject({ code: 'rate_limited' });
  expect(publishServerMessage).not.toHaveBeenCalled();
});
test('room hop or revoked bridge during asynchronous moderation cannot publish', async () => {
  engineEvaluate.mockImplementation(async () => { getWorldId.mockResolvedValue('r:two'); return { block: false }; });
  await expect(sendServerMessage(actor, 'r:one', 'hello')).rejects.toMatchObject({ code: 'invalid_channel' });
  getWorldId.mockResolvedValue('r:one'); engineEvaluate.mockResolvedValue({ block: false });
  await expect(sendServerMessage(actor, 'r:one', 'hello', async () => false)).rejects.toMatchObject({ code: 'invalid_channel' });
  expect(publishServerMessage).not.toHaveBeenCalled();
});
test('storage failure is not acknowledged as a successful send', async () => {
  publishServerMessage.mockRejectedValue(new Error('redis down'));
  await expect(sendServerMessage(actor, 'r:one', 'hello')).rejects.toThrow('redis down');
});
test.each(['', ' ', 'x'.repeat(501)])('invalid message bodies cannot reach moderation or publication', async body => {
  await expect(sendServerMessage(actor, 'r:one', body)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(engineEvaluate).not.toHaveBeenCalled(); expect(publishServerMessage).not.toHaveBeenCalled();
});
