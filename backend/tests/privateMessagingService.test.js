'use strict';

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../src/services/blockService', () => ({
  __esModule: true,
  getBlockedIds: jest.fn(),
  getBlockerIds: jest.fn(),
}));

function modelStub() {
  return {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    upsert: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  };
}

const prismaMock = {
  user: modelStub(),
  privateConversation: modelStub(),
  privateMessage: modelStub(),
  message: modelStub(),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn(async (cb) => cb(prismaMock)),
};

const {
  getBlockedIds,
  getBlockerIds,
} = require('../src/services/blockService');

const {
  PrivateConversationAccessError,
  getPrivateHistory,
  getOrCreatePrivateConversation,
  listPrivateConversations,
  sendPrivateMessage,
} = require('../src/services/privateMessagingService');

describe('privateMessagingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getBlockedIds.mockResolvedValue(new Set());
    getBlockerIds.mockResolvedValue(new Set());
    prismaMock.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'user-a') {
        return {
          id: 'user-a',
          isBanned: false,
          username: 'Sender',
          discordUsername: null,
          discordDisplayName: null,
        };
      }
      if (where.id === 'user-b') {
        return {
          id: 'user-b',
          isBanned: false,
          username: 'Receiver',
          discordUsername: null,
          discordDisplayName: null,
        };
      }
      return null;
    });
    prismaMock.privateConversation.findFirst.mockResolvedValue(null);
    prismaMock.privateConversation.upsert.mockResolvedValue({
      id: 'conv-1',
      userAId: 'user-a',
      userBId: 'user-b',
    });
    prismaMock.privateConversation.update.mockResolvedValue({});
    prismaMock.privateMessage.create.mockResolvedValue({
      id: 'pm-1',
      conversationId: 'conv-1',
      senderId: 'user-a',
      content: 'meet at whitespring?',
      createdAt: new Date('2026-06-25T15:10:00.000Z'),
    });
    prismaMock.privateMessage.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  it('rejects blocked private messages with a generic error', async () => {
    getBlockerIds.mockResolvedValue(new Set(['user-b']));

    await expect(sendPrivateMessage('user-a', 'user-b', 'hello'))
      .rejects.toMatchObject({
        name: 'PrivateMessageUnavailableError',
        message: 'Message unavailable.',
      });

    expect(prismaMock.privateMessage.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('returns history only for conversation participants', async () => {
    prismaMock.privateConversation.findFirst.mockImplementation(async ({ where }) => {
      const isParticipant = where?.OR?.some((entry) =>
        entry.userAId === 'user-a' || entry.userBId === 'user-a',
      );
      if (!isParticipant) return null;
      return {
        id: 'conv-1',
        userAId: 'user-a',
        userBId: 'user-b',
        userALastReadAt: null,
        userBLastReadAt: null,
        lastMessageAt: new Date('2026-06-25T15:10:00.000Z'),
        createdAt: new Date('2026-06-25T15:00:00.000Z'),
        userA: { id: 'user-a', username: 'Sender', discordUsername: null, discordDisplayName: null },
        userB: { id: 'user-b', username: 'Receiver', discordUsername: null, discordDisplayName: null },
      };
    });
    prismaMock.privateMessage.findMany.mockResolvedValue([
      {
        id: 'pm-1',
        conversationId: 'conv-1',
        senderId: 'user-a',
        content: 'meet at whitespring?',
        createdAt: new Date('2026-06-25T15:10:00.000Z'),
        sender: { username: 'Sender', discordUsername: null, discordDisplayName: null },
      },
    ]);

    await expect(getPrivateHistory('user-z', 'conv-1'))
      .rejects.toBeInstanceOf(PrivateConversationAccessError);

    const history = await getPrivateHistory('user-a', 'conv-1');
    expect(history).toEqual([
      {
        id: 'pm-1',
        conversationId: 'conv-1',
        senderId: 'user-a',
        senderName: 'Sender',
        recipientId: 'user-b',
        content: 'meet at whitespring?',
        createdAt: '2026-06-25T15:10:00.000Z',
        editedAt: null,
      },
    ]);
  });

  it('includes lastMessageSenderId in private conversation summaries', async () => {
    prismaMock.privateConversation.findMany.mockResolvedValue([
      {
        id: 'conv-1',
        userAId: 'user-a',
        userBId: 'user-b',
        userALastReadAt: null,
        userBLastReadAt: null,
        lastMessageAt: new Date('2026-06-25T15:10:00.000Z'),
        createdAt: new Date('2026-06-25T15:00:00.000Z'),
        userA: { id: 'user-a', username: 'Sender', discordUsername: null, discordDisplayName: null },
        userB: { id: 'user-b', username: 'Receiver', discordUsername: null, discordDisplayName: null },
        messages: [
          {
            content: 'meet at whitespring?',
            createdAt: new Date('2026-06-25T15:10:00.000Z'),
            senderId: 'user-a',
          },
        ],
      },
      {
        id: 'conv-2',
        userAId: 'user-a',
        userBId: 'user-c',
        userALastReadAt: null,
        userBLastReadAt: null,
        lastMessageAt: null,
        createdAt: new Date('2026-06-25T15:20:00.000Z'),
        userA: { id: 'user-a', username: 'Sender', discordUsername: null, discordDisplayName: null },
        userB: { id: 'user-c', username: 'ReceiverTwo', discordUsername: null, discordDisplayName: null },
        messages: [],
      },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([
      { conversation_id: 'conv-1', unread_count: 1 },
    ]);

    const conversations = await listPrivateConversations('user-a');

    expect(prismaMock.privateConversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.privateMessage.count).not.toHaveBeenCalled();

    expect(conversations).toEqual([
      {
        conversationId: 'conv-1',
        otherUserId: 'user-b',
        otherDisplayName: 'Receiver',
        lastMessagePreview: 'meet at whitespring?',
        lastMessageSenderId: 'user-a',
        lastMessageAt: '2026-06-25T15:10:00.000Z',
        unreadCount: 1,
      },
      {
        conversationId: 'conv-2',
        otherUserId: 'user-c',
        otherDisplayName: 'ReceiverTwo',
        lastMessagePreview: '',
        lastMessageSenderId: null,
        lastMessageAt: '2026-06-25T15:20:00.000Z',
        unreadCount: 0,
      },
    ]);
  });

  it('caps inbox rows even when a caller requests an excessive limit', async () => {
    prismaMock.privateConversation.findMany.mockResolvedValue([]);

    await listPrivateConversations('user-a', 5000);

    expect(prismaMock.privateConversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('stores private messages separately from public channel messages', async () => {
    const result = await sendPrivateMessage('user-a', 'user-b', 'meet at whitespring?');

    expect(prismaMock.privateConversation.upsert).toHaveBeenCalled();
    expect(prismaMock.privateMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: 'conv-1',
        senderId: 'user-a',
        content: 'meet at whitespring?',
      }),
    }));
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      id: 'pm-1',
      conversationId: 'conv-1',
      senderId: 'user-a',
      senderName: 'Sender',
      recipientId: 'user-b',
      content: 'meet at whitespring?',
    });
  });

  // The pm:send WS handler's anti-spoof guard derives the conversation from the
  // (sender, recipient) pair via getOrCreatePrivateConversation and rejects any
  // client-supplied conversationId that doesn't match. That guard is only sound
  // if the derived conversation is deterministic and participant-scoped — these
  // tests lock that invariant in.
  describe('getOrCreatePrivateConversation (anti-spoof foundation)', () => {
    it('resolves the same conversation regardless of participant argument order', async () => {
      const ab = await getOrCreatePrivateConversation('user-a', 'user-b');
      const ba = await getOrCreatePrivateConversation('user-b', 'user-a');

      expect(ab.id).toBe('conv-1');
      expect(ba.id).toBe('conv-1');

      // Both orders must hit the SAME composite key (sorted pair) — a spoofed
      // conversationId from a non-participant can never collide with it.
      const [firstCall, secondCall] = prismaMock.privateConversation.upsert.mock.calls;
      expect(firstCall[0].where.userAId_userBId)
        .toEqual(secondCall[0].where.userAId_userBId);
    });

    it('keys the conversation on the lexicographically sorted participant pair', async () => {
      await getOrCreatePrivateConversation('user-b', 'user-a');

      const { where, create } = prismaMock.privateConversation.upsert.mock.calls[0][0];
      expect(where.userAId_userBId).toEqual({ userAId: 'user-a', userBId: 'user-b' });
      expect(create).toMatchObject({ userAId: 'user-a', userBId: 'user-b' });
    });
  });
});
