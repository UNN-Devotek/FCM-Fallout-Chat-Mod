import prisma from '../config/prisma';
import logger from '../config/logger';

interface PersistMessageData {
  id: string;
  content: string;
  userId: string;
  channelId: string;
  parentChannelId?: string | null;
  source?: string;
  createdAt?: string | Date;
  /** Optional structured payload stored in messages.metadata (e.g. party_invite embed). */
  metadata?: unknown;
  /**
   * Optional monotonic relay cursor (relay source ONLY). When provided, it is
   * persisted to messages.relay_seq so poll/history (which filter on
   * relay_seq IS NOT NULL) return the message. Omitted (NULL) for all other sources.
   */
  relaySeq?: number;
}

/**
 * Persist a message record to PostgreSQL.
 * Called from the Bull queue worker (non-blocking on the WS hot path).
 */
async function persistMessage({ id, content, userId, channelId, parentChannelId, source, createdAt, metadata, relaySeq }: PersistMessageData): Promise<void> {
  try {
    // Use raw query for ON CONFLICT on composite PK (id, created_at)
    // Prisma doesn't support upsert on composite keys cleanly
    await prisma.$executeRaw`
      INSERT INTO messages (id, content, user_id, channel_id, parent_channel_id, source, metadata, relay_seq, created_at)
      VALUES (
        ${id}::uuid,
        ${content},
        ${userId}::uuid,
        ${channelId}::uuid,
        ${parentChannelId ?? null}::uuid,
        ${source || 'game'},
        ${metadata != null ? JSON.stringify(metadata) : null}::jsonb,
        ${relaySeq != null ? BigInt(relaySeq) : null}::bigint,
        ${createdAt ? new Date(createdAt as string) : new Date()}
      )
      ON CONFLICT (id, created_at) DO NOTHING`;
  } catch (err) {
    logger.error({ err, messageId: id }, 'Failed to persist message');
    throw err;
  }
}

export { persistMessage };
module.exports = { persistMessage };
