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
}): string {
  if (!isPlaceholderUsername(user.username)) return String(user.username);
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
          discordDisplayName: true,
        },
      },
      userB: {
        select: {
          id: true,
          username: true,
          discordUsername: true,
          discordDisplayName: true,
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
  await assertConversationAvailable(requesterId, targetUserId);
  const [userAId, userBId] = sortParticipantIds(requesterId, targetUserId);

  return prisma.privateConversation.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: {},
    create: {
      userAId,
      userBId,
    },
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
            discordDisplayName: true,
          },
        },
        userB: {
          select: {
            id: true,
            username: true,
            discordUsername: true,
            discordDisplayName: true,
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
          discordDisplayName: true,
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

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.privateConversation.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: {},
      create: {
        userAId,
        userBId,
      },
    });

    const createdAt = new Date();
    const message = await tx.privateMessage.create({
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
    });

    await tx.privateConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: createdAt,
        ...(conversation.userAId === senderId
          ? { userALastReadAt: createdAt }
          : { userBLastReadAt: createdAt }),
      },
    });

    const sender = await tx.user.findUnique({
      where: { id: senderId },
      select: {
        username: true,
        discordUsername: true,
        discordDisplayName: true,
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
  });
}

export async function markPrivateConversationRead(userId: string, conversationId: string) {
  const conversation = await getParticipantConversation(userId, conversationId);
  const readAt = new Date();

  await prisma.privateConversation.update({
    where: { id: conversationId },
    data: conversation.userAId === userId
      ? { userALastReadAt: readAt }
      : { userBLastReadAt: readAt },
  });

  return {
    conversationId,
    readAt: readAt.toISOString(),
  };
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
