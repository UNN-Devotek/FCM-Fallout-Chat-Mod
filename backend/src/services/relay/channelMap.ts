/**
 * channelMap.ts — ZFE chat.v1 slug <-> FCM channel UUID mapping.
 *
 * Shipped slug set (AllowedChannels fragment):
 *   global, trade, server, events, raids, infests
 *
 * 'server' is dynamic (worldId-bound room) — not in the static map;
 * the relay handler resolves it via the caller's worldId state.
 */

// Static channel UUIDs — seeded in server.ts seeds.
export const UUID_GLOBAL = '00000000-0000-0000-0000-000000000005';
export const UUID_TRADE  = '00000000-0000-0000-0000-000000000002';
export const UUID_EVENTS = '00000000-0000-0000-0000-000000000003';
export const UUID_RAIDS  = '00000000-0000-0000-0000-000000000004';
export const UUID_INFESTS = '983995c1-f9ab-44c0-9b78-8b4cbf497273';

/**
 * Static slug -> UUID map. Does NOT include 'server' — that slug maps to a
 * dynamic worldId-bound room and must be resolved at request time.
 */
export const SLUG_TO_UUID: Record<string, string> = {
  global:  UUID_GLOBAL,
  trade:   UUID_TRADE,
  events:  UUID_EVENTS,
  raids:   UUID_RAIDS,
  infests: UUID_INFESTS,
};

/** Reverse: UUID -> slug for the static channels. */
export const UUID_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_UUID).map(([slug, uuid]) => [uuid, slug]),
);

/** Full set of allowed slugs including the dynamic 'server' slug. */
export const ALL_SLUGS: string[] = [...Object.keys(SLUG_TO_UUID), 'server'];

/**
 * Look up a channel UUID by slug.
 * Returns null for 'server' (caller must resolve via worldId) or unknown slugs.
 */
export function slugToChannelId(slug: string): string | null {
  return SLUG_TO_UUID[slug] ?? null;
}

/**
 * Look up a slug by channel UUID.
 * Returns null when the UUID is not in the static map.
 */
export function channelIdToSlug(uuid: string): string | null {
  return UUID_TO_SLUG[uuid] ?? null;
}

/**
 * Returns true for static (non-server) slugs that exist in the map.
 * 'server' is excluded because it requires dynamic resolution.
 */
export function isStaticSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(SLUG_TO_UUID, slug);
}
