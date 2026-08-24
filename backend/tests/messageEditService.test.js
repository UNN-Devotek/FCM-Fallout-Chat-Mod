'use strict';

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../src/services/autoModEngine', () => ({
  __esModule: true,
  engineEvaluate: jest.fn().mockResolvedValue({ block: false }),
}));

const modelStub = () => ({
  findFirst: jest.fn().mockResolvedValue(null),
  findMany: jest.fn().mockResolvedValue([]),
});

const prismaMock = {
  partyMember: modelStub(),
  privateConversation: modelStub(),
  privateMessage: modelStub(),
  $executeRaw: jest.fn().mockResolvedValue(1),
};

const { engineEvaluate } = require('../src/services/autoModEngine');
const {
  editOwnedMessage,
  MessageEditError,
} = require('../src/services/messageEditService');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const PARTY_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = '66666666-6666-4666-8666-666666666666';

const user = { id: USER_ID, username: 'Wanderer' };

describe('messageEditService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.partyMember.findFirst.mockResolvedValue({ userId: USER_ID });
    prismaMock.privateConversation.findFirst.mockResolvedValue({ userAId: USER_ID, userBId: OTHER_ID });
    prismaMock.privateMessage.findFirst.mockResolvedValue({ createdAt: new Date('2026-08-24T12:00:00.000Z') });
    engineEvaluate.mockResolvedValue({ block: false });
  });

  it('updates an owned channel message and reruns AutoMod', async () => {
    const result = await editOwnedMessage({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      content: '  corrected text  ',
      source: 'game',
      channelId: CHANNEL_ID,
      user,
    });

    expect(result).toMatchObject({
      messageId: MESSAGE_ID,
      content: 'corrected text',
      source: 'game',
      channelId: CHANNEL_ID,
    });
    expect(engineEvaluate).toHaveBeenCalledWith('corrected text', CHANNEL_ID, user);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a channel update when the persisted owner update matches no row', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0);

    await expect(editOwnedMessage({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      content: 'not yours',
      source: 'game',
      channelId: CHANNEL_ID,
      user,
    })).rejects.toMatchObject({
      name: 'MessageEditError',
      statusCode: 404,
    });
  });

  it('requires party membership before updating a party message', async () => {
    prismaMock.partyMember.findFirst.mockResolvedValue(null);

    await expect(editOwnedMessage({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      content: 'party correction',
      source: 'party',
      channelId: PARTY_ID,
      user,
    })).rejects.toMatchObject({
      name: 'MessageEditError',
      statusCode: 403,
    });
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it('updates an owned private message only inside the participant conversation', async () => {
    const result = await editOwnedMessage({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      content: 'private correction',
      source: 'pm',
      conversationId: CONVERSATION_ID,
      user,
    });

    expect(result).toMatchObject({
      messageId: MESSAGE_ID,
      content: 'private correction',
      source: 'pm',
      conversationId: CONVERSATION_ID,
      recipientId: OTHER_ID,
      createdAt: '2026-08-24T12:00:00.000Z',
    });
    expect(prismaMock.privateConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: CONVERSATION_ID }),
    }));
  });

  it('rejects empty, oversized, and AutoMod-blocked edits', async () => {
    await expect(editOwnedMessage({
      userId: USER_ID, messageId: MESSAGE_ID, content: ' ', source: 'game', channelId: CHANNEL_ID, user,
    })).rejects.toBeInstanceOf(MessageEditError);

    await expect(editOwnedMessage({
      userId: USER_ID, messageId: MESSAGE_ID, content: 'x'.repeat(501), source: 'game', channelId: CHANNEL_ID, user,
    })).rejects.toMatchObject({ statusCode: 400 });

    engineEvaluate.mockResolvedValue({ block: true, customMessage: 'blocked edit' });
    await expect(editOwnedMessage({
      userId: USER_ID, messageId: MESSAGE_ID, content: 'blocked', source: 'game', channelId: CHANNEL_ID, user,
    })).rejects.toMatchObject({ message: 'blocked edit', statusCode: 400 });
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });
});
