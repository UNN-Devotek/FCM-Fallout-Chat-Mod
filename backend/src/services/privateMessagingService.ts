import { bindRequiredTransactionClient, isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';
import prisma from '../config/prisma';
import { Prisma } from '@prisma/client';
import { getBlockedIds, getBlockerIds } from './blockService';

export const PRIVATE_MESSAGE_MAX_LENGTH = 255;
export const PRIVATE_CONVERSATION_LIST_MAX = 50;

export class PrivateMessageUnavailableError extends Error {
  statusCode = 403;

  constructor(message = 'Message unavailable.') {
    super(message);
    this.name = 'PrivateMessageUnavailableError';
  }
}

export class PrivateConversationAccessError extends Error {
  statusCode = 404;

  constructor(message = 'Conversation not found.') {
    super(message);
    this.name = 'PrivateConversationAccessError';
  }
}

function isPlaceholderUsername(username: string | null | undefined): boolean {
  if (!username) return true;
  return (
    username === 'Wanderer' ||
    username.startsWith('discord:') ||
    username.startsWith('pending-') ||
    /^overlay\d+$/i.test(username)
  );
}

function resolveDisplayName(user: {
  username?: string | null;
  discordUsername?: string | null;
  discordDisplayName?: string | null;
  steamDisplayName?: string | null;
}): string {
  if (!isPlaceholderUsername(user.username)) return String(user.username);
  if (user.steamDisplayName?.trim()) return user.steamDisplayName.trim();
  if (user.discordDisplayName && user.discordDisplayName.length > 0) return user.discordDisplayName;
  if (user.discordUsername && user.discordUsername.length > 0) return user.discordUsername;
  return user.username || 'Wanderer';
}

function sortParticipantIds(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

async function assertConversationAvailable(requesterId: string, otherUserId: string): Promise<void> {
  if (requesterId === otherUserId) {
    throw new PrivateMessageUnavailableError('You cannot message yourself.');
  }

  const [blockedIds, blockerIds, target] = await Promise.all([
    getBlockedIds(requesterId),
    getBlockerIds(requesterId),
    prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, isBanned: true },
    }),
  ]);

  if (!target || target.isBanned || blockedIds.has(otherUserId) || blockerIds.has(otherUserId)) {
    throw new PrivateMessageUnavailableError();
  }
}

async function getParticipantConversation(userId: string, conversationId: string) {
  const conversation = await prisma.privateConversation.findFirst({
    where: {
      id: conversationId,
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    include: {
      userA: {
        select: {
          id: true,
          username: true,
          discordUsername: true,
          discordDisplayName: true, steamDisplayName: true,
        },
      },
      userB: {
        select: {
          id: true,
          username: true,
          discordUsername: true,
          discordDisplayName: true, steamDisplayName: true,
        },
      },
    },
  });

  if (!conversation) {
    throw new PrivateConversationAccessError();
  }

  const otherUserId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
  await assertConversationAvailable(userId, otherUserId);

  return conversation;
}

function conversationSummaryForUser(
  requesterId: string,
  conversation: {
    id: string;
    userAId: string;
    userBId: string;
    userALastReadAt: Date | null;
    userBLastReadAt: Date | null;
    lastMessageAt: Date | null;
    createdAt: Date;
    userA: { id: string; username: string | null; discordUsername: string | null; discordDisplayName: string | null };
    userB: { id: string; username: string | null; discordUsername: string | null; discordDisplayName: string | null };
    messages: Array<{ content: string; createdAt: Date; senderId: string }>;
  },
  unreadCount: number,
) {
  const other = conversation.userAId === requesterId ? conversation.userB : conversation.userA;
  const lastMessage = conversation.messages[0] ?? null;
  return {
    conversationId: conversation.id,
    otherUserId: other.id,
    otherDisplayName: resolveDisplayName(other),
    lastMessagePreview: lastMessage?.content ?? '',
    lastMessageSenderId: lastMessage?.senderId ?? null,
    lastMessageAt: (conversation.lastMessageAt ?? lastMessage?.createdAt ?? conversation.createdAt).toISOString(),
    unreadCount,
  };
}

export async function getOrCreatePrivateConversation(requesterId: string, targetUserId: string) {
  return runRequiredBundle('domain', 'privateMessagingService:881ad7e497c3', async () => {
  await assertConversationAvailable(requesterId, targetUserId);
  const [userAId, userBId] = sortParticipantIds(requesterId, targetUserId);

  return runRequiredMutation('domain', '00c6d12edd0e2f5a21bc1f6f', { stage: 'primary-write-unconfirmed' }, () => prisma.privateConversation.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: {},
    create: {
      userAId,
      userBId,
    },
  }), isPrismaAtomicRefusal, undefined, undefined);

  });
}

async function getUnreadCounts(userId: string, conversationIds: string[]): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();

  // Keep this as one aggregate query. The old implementation issued one
  // COUNT per conversation, which made a busy inbox an avoidable N+1 query
  // burst. The per-user read timestamp still lives on the conversation, so
  // the database can apply the exact same unread semantics in one pass.
  const rows = await prisma.$queryRaw<Array<{ conversation_id: string; unread_count: number | bigint }>>`
    SELECT pm.conversation_id, COUNT(*)::int AS unread_count
    FROM private_messages pm
    JOIN private_conversations pc ON pc.id = pm.conversation_id
    WHERE pm.conversation_id IN (${Prisma.join(conversationIds.map((conversationId) => Prisma.sql`${conversationId}::uuid`))})
      AND pm.is_deleted = false
      AND pm.sender_id <> ${Prisma.sql`${userId}::uuid`}
      AND (
        (pc.user_a_id = ${Prisma.sql`${userId}::uuid`}
          AND (pc.user_a_last_read_at IS NULL OR pm.created_at > pc.user_a_last_read_at))
        OR
        (pc.user_b_id = ${Prisma.sql`${userId}::uuid`}
          AND (pc.user_b_last_read_at IS NULL OR pm.created_at > pc.user_b_last_read_at))
      )
    GROUP BY pm.conversation_id
  `;

  return new Map(rows.map((row) => [row.conversation_id, Number(row.unread_count)]));
}

export async function listPrivateConversations(userId: string, limit = PRIVATE_CONVERSATION_LIST_MAX) {
  const parsedLimit = Number.parseInt(String(limit), 10);
  const safeLimit = Math.min(
    Math.max(Number.isFinite(parsedLimit) ? parsedLimit : PRIVATE_CONVERSATION_LIST_MAX, 1),
    PRIVATE_CONVERSATION_LIST_MAX,
  );
  const [blockedIds, blockerIds, conversations] = await Promise.all([
    getBlockedIds(userId),
    getBlockerIds(userId),
    prisma.privateConversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: safeLimit,
      include: {
        userA: {
          select: {
            id: true,
            username: true,
            discordUsername: true,
            discordDisplayName: true, steamDisplayName: true,
          },
        },
        userB: {
          select: {
            id: true,
            username: true,
            discordUsername: true,
            discordDisplayName: true, steamDisplayName: true,
          },
        },
        messages: {
          where: { isDeleted: false },
          orderBy: [{ createdAt: 'desc' }],
          take: 1,
          select: {
            content: true,
            createdAt: true,
            senderId: true,
          },
        },
      },
    }),
  ]);

  const visible = conversations.filter((conversation) => {
    const otherUserId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
    return !blockedIds.has(otherUserId) && !blockerIds.has(otherUserId);
  });

  const unreadCounts = await getUnreadCounts(userId, visible.map((conversation) => conversation.id));
  return visible.map((conversation) => conversationSummaryForUser(
    userId,
    conversation,
    unreadCounts.get(conversation.id) ?? 0,
  ));
}

export async function getPrivateHistory(userId: string, conversationId: string, limit = 100, offset = 0) {
  const conversation = await getParticipantConversation(userId, conversationId);
  const otherUserId = conversation.userAId === userId ? conversation.userBId : conversation.userAId;
  const safeLimit = Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 200);
  const safeOffset = Math.min(Math.max(parseInt(String(offset), 10) || 0, 0), 10000);

  const rows = await prisma.privateMessage.findMany({
    where: {
      conversationId,
      isDeleted: false,
    },
    orderBy: [{ createdAt: 'desc' }],
    take: safeLimit,
    skip: safeOffset,
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      content: true,
      createdAt: true,
      editedAt: true,
      sender: {
        select: {
          username: true,
          discordUsername: true,
          discordDisplayName: true, steamDisplayName: true,
        },
      },
    },
  });

  return rows.reverse().map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    senderName: resolveDisplayName(row.sender),
    recipientId: row.senderId === userId ? otherUserId : userId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  }));
}

export async function sendPrivateMessage(senderId: string, recipientId: string, content: string) {
  return runRequiredBundle('domain', 'privateMessagingService:eda527afeef9', async () => {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (!trimmed) {
    const err = new Error('Invalid message content.');
    (err as any).statusCode = 400;
    throw err;
  }
  if (trimmed.length > PRIVATE_MESSAGE_MAX_LENGTH) {
    const err = new Error(`Message too long (max ${PRIVATE_MESSAGE_MAX_LENGTH} chars).`);
    (err as any).statusCode = 400;
    throw err;
  }

  await assertConversationAvailable(senderId, recipientId);
  const [userAId, userBId] = sortParticipantIds(senderId, recipientId);

  return runRequiredTransaction('domain', '786ead5d3869d389744c7fc1', { stage: 'transaction-completion-unconfirmed' }, () => prisma.$transaction(async (tx) => {
      bindRequiredTransactionClient(tx);
    const conversation = await runRequiredMutation('domain', 'd6e224b022209f1fbc3eab84', { stage: 'primary-write-unconfirmed' }, () => tx.privateConversation.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: {},
      create: {
        userAId,
        userBId,
      },
    }), isPrismaAtomicRefusal, tx, undefined);

    const createdAt = new Date();
    const message = await runRequiredMutation('domain', 'c97c61df018982f0ca63e914', { stage: 'primary-write-unconfirmed' }, () => tx.privateMessage.create({
      data: {
        conversationId: conversation.id,
        senderId,
        content: trimmed,
        createdAt,
      },
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        content: true,
        createdAt: true,
        editedAt: true,
      },
    }), isPrismaAtomicRefusal, tx, undefined);

    await runRequiredMutation('domain', '67eebb72c0f0a8288de2c5b3', { stage: 'primary-write-unconfirmed', rowId: conversation.id }, () => tx.privateConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: createdAt,
        ...(conversation.userAId === senderId
          ? { userALastReadAt: createdAt }
          : { userBLastReadAt: createdAt }),
      },
    }), isPrismaAtomicRefusal, tx, undefined);

    const sender = await tx.user.findUnique({
      where: { id: senderId },
      select: {
        username: true,
        discordUsername: true,
        discordDisplayName: true, steamDisplayName: true,
      },
    });

    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderName: resolveDisplayName(sender ?? {}),
      recipientId,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
    };
  }), { confirmedRollback: isPrismaAtomicRefusal });

  });
}

export async function markPrivateConversationRead(userId: string, conversationId: string) {
  return runRequiredBundle('domain', 'privateMessagingService:a2baacbfd404', async () => {
  const conversation = await getParticipantConversation(userId, conversationId);
  const readAt = new Date();

  await runRequiredMutation('domain', '1554a2f71a9df6a9515818e0', { stage: 'primary-write-unconfirmed', rowId: conversationId }, () => prisma.privateConversation.update({
    where: { id: conversationId },
    data: conversation.userAId === userId
      ? { userALastReadAt: readAt }
      : { userBLastReadAt: readAt },
  }), isPrismaAtomicRefusal, undefined, undefined);

  return {
    conversationId,
    readAt: readAt.toISOString(),
  };

  });
}

module.exports = {
  PRIVATE_MESSAGE_MAX_LENGTH,
  PRIVATE_CONVERSATION_LIST_MAX,
  PrivateMessageUnavailableError,
  PrivateConversationAccessError,
  getOrCreatePrivateConversation,
  listPrivateConversations,
  getPrivateHistory,
  sendPrivateMessage,
  markPrivateConversationRead,
};
