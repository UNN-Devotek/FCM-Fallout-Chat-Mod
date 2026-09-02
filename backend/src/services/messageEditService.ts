import prisma from '../config/prisma';
import { engineEvaluate } from './autoModEngine';
import { emojifyShortcodes } from '../utils/emoji';

export const EDITABLE_MESSAGE_MAX_LENGTH = 500;
export const EDITABLE_PRIVATE_MESSAGE_MAX_LENGTH = 255;

export class MessageEditError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 404) {
    super(message);
    this.name = 'MessageEditError';
    this.statusCode = statusCode;
  }
}

export type EditableMessageSource = 'party' | 'pm' | string;

export interface EditOwnedMessageInput {
  userId: string;
  messageId: string;
  content: string;
  source: EditableMessageSource;
  channelId?: string;
  conversationId?: string;
  user: Record<string, unknown>;
}

export interface EditedMessage {
  messageId: string;
  userId: string;
  content: string;
  source: EditableMessageSource;
  channelId?: string;
  conversationId?: string;
  recipientId?: string;
  createdAt?: string;
  editedAt: string;
}

function validateContent(content: string, maxLength: number): string {
  if (typeof content !== 'string') {
    throw new MessageEditError('Message content cannot be empty.', 400);
  }
  const normalized = emojifyShortcodes(content).trim();
  if (normalized.length === 0) {
    throw new MessageEditError('Message content cannot be empty.', 400);
  }
  if (normalized.length > maxLength) {
    throw new MessageEditError(`Message too long (max ${maxLength} chars).`, 400);
  }
  return normalized;
}

async function assertAllowedByAutoMod(content: string, target: string, user: Record<string, unknown>): Promise<void> {
  const result = await engineEvaluate(content, target, user as any);
  if (result.block) {
    throw new MessageEditError(result.customMessage || 'Message blocked by content filter.', 400);
  }
}

/**
 * Edit a message only when the authenticated user owns the persisted row.
 * Source-specific identifiers are deliberately required so a client cannot
 * turn a party/private message id into a channel-message update.
 */
export async function editOwnedMessage(input: EditOwnedMessageInput): Promise<EditedMessage> {
  const isParty = input.source === 'party';
  const isPrivate = input.source === 'pm';
  const maxLength = isPrivate ? EDITABLE_PRIVATE_MESSAGE_MAX_LENGTH : EDITABLE_MESSAGE_MAX_LENGTH;
  const content = validateContent(input.content, maxLength);
  const editedAt = new Date();

  if (isParty) {
    if (!input.channelId) throw new MessageEditError('Invalid partyId.', 400);

    const membership = await prisma.partyMember.findFirst({
      where: { partyId: input.channelId, userId: input.userId },
      select: { userId: true },
    });
    if (!membership) throw new MessageEditError('You are not a member of this party.', 403);

    await assertAllowedByAutoMod(content, input.channelId, input.user);
    const updated = await prisma.$executeRaw`
      UPDATE party_messages
      SET content = ${content}, edited_at = ${editedAt}
      WHERE id = ${input.messageId}::uuid
        AND party_id = ${input.channelId}::uuid
        AND user_id = ${input.userId}::uuid
        AND NOT is_deleted`;
    if (updated === 0) throw new MessageEditError('Message not found or not editable.');

    return {
      messageId: input.messageId,
      userId: input.userId,
      content,
      source: 'party',
      channelId: input.channelId,
      editedAt: editedAt.toISOString(),
    };
  }

  if (isPrivate) {
    if (!input.conversationId) throw new MessageEditError('Invalid conversationId.', 400);

    const conversation = await prisma.privateConversation.findFirst({
      where: {
        id: input.conversationId,
        OR: [{ userAId: input.userId }, { userBId: input.userId }],
      },
      select: { userAId: true, userBId: true },
    });
    if (!conversation) throw new MessageEditError('Conversation not found.', 404);

    const existing = await prisma.privateMessage.findFirst({
      where: {
        id: input.messageId,
        conversationId: input.conversationId,
        senderId: input.userId,
        isDeleted: false,
      },
      select: { createdAt: true },
    });
    if (!existing) throw new MessageEditError('Message not found or not editable.');

    const recipientId = conversation.userAId === input.userId ? conversation.userBId : conversation.userAId;
    await assertAllowedByAutoMod(content, `pm:${recipientId}`, input.user);
    const updated = await prisma.$executeRaw`
      UPDATE private_messages
      SET content = ${content}, edited_at = ${editedAt}
      WHERE id = ${input.messageId}::uuid
        AND conversation_id = ${input.conversationId}::uuid
        AND sender_id = ${input.userId}::uuid
        AND NOT is_deleted`;
    if (updated === 0) throw new MessageEditError('Message not found or not editable.');

    return {
      messageId: input.messageId,
      userId: input.userId,
      content,
      source: 'pm',
      conversationId: input.conversationId,
      recipientId,
      createdAt: existing.createdAt.toISOString(),
      editedAt: editedAt.toISOString(),
    };
  }

  if (!input.channelId) throw new MessageEditError('Invalid channelId.', 400);
  await assertAllowedByAutoMod(content, input.channelId, input.user);
  const updated = await prisma.$executeRaw`
    UPDATE messages
    SET content = ${content}, edited_at = ${editedAt}
    WHERE id = ${input.messageId}::uuid
      AND channel_id = ${input.channelId}::uuid
      AND user_id = ${input.userId}::uuid
      AND NOT is_deleted`;
  if (updated === 0) throw new MessageEditError('Message not found or not editable.');

  return {
    messageId: input.messageId,
    userId: input.userId,
    content,
    source: input.source,
    channelId: input.channelId,
    editedAt: editedAt.toISOString(),
  };
}
