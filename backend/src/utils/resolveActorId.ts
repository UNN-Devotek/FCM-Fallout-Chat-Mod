import prisma from '../config/prisma';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

type ActorAttributionCode = 'ACTOR_IDENTITY_INVALID' | 'ACTOR_INTERNAL_USER_MISSING' | 'ACTOR_LOOKUP_UNAVAILABLE';

export class ActorAttributionError extends Error {
  readonly status = 503;
  constructor(readonly code: ActorAttributionCode) {
    super('Audit actor attribution could not be confirmed.');
    this.name = 'ActorAttributionError';
  }
}

/**
 * Convert an authenticated actor identity into the internal users.id UUID used
 * by audit and ownership columns. API-key and unlinked Discord actors resolve
 * to null only after confirmed classification. Call before the primary change:
 * an unavailable lookup must never become an anonymous successful mutation.
 */
export async function resolveInternalActorId(actorId: unknown): Promise<string | null> {
  if (actorId === 'api-key') return null;
  if (typeof actorId !== 'string' || (!UUID_RE.test(actorId) && !DISCORD_SNOWFLAKE_RE.test(actorId))) {
    throw new ActorAttributionError('ACTOR_IDENTITY_INVALID');
  }

  const internal = UUID_RE.test(actorId);
  let linked: { id: string } | null;
  try {
    linked = internal
      ? await prisma.user.findUnique({ where: { id: actorId }, select: { id: true } })
      : await prisma.user.findFirst({ where: { discordId: actorId }, select: { id: true } });
  } catch {
    throw new ActorAttributionError('ACTOR_LOOKUP_UNAVAILABLE');
  }
  if (internal && !linked) throw new ActorAttributionError('ACTOR_INTERNAL_USER_MISSING');
  return linked?.id ?? null;
}
