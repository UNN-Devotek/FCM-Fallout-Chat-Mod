import prisma from '../config/prisma';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Convert an authenticated actor identity into the internal users.id UUID used
 * by audit and ownership columns. API-key and unlinked Discord actors resolve
 * to null so callers can persist nullable audit fields safely.
 */
export async function resolveInternalActorId(actorId: unknown): Promise<string | null> {
  if (typeof actorId !== 'string' || !actorId) return null;
  if (UUID_RE.test(actorId)) return actorId;
  if (!DISCORD_SNOWFLAKE_RE.test(actorId)) return null;

  try {
    const linked = await prisma.user.findFirst({
      where: { discordId: actorId },
      select: { id: true },
    });
    return linked?.id ?? null;
  } catch {
    return null;
  }
}
