import { createHash, createHmac, randomBytes } from 'node:crypto';
import { getRedisClient } from '../../config/redis';
import env from '../../config/environment';
import logger from '../../config/logger';

const CONTROL_PREFIX = 'FCMCTL/1/DIAG:';
const MAX_CONTROL_BYTES = 256;
const GLOBAL_KEY = 'relay:room-diagnostics:recent';
const USER_KEY = (userId: string): string => `relay:room-diagnostics:user:${userId}`;
const GLOBAL_LIMIT = 1_000;
const USER_LIMIT = 100;
const TTL_SECONDS = 24 * 60 * 60;
const FALLBACK_DIAGNOSTIC_SECRET = randomBytes(32).toString('hex');

const HUD_EVENTS = ['roster_send', 'roster_hold', 'roster_boundary', 'roster_stale', 'main_menu'] as const;
const HUD_PROVIDERS = ['zfe', 'xscal'] as const;
const ROSTER_SOURCES = [
  'none', 'PlayerListData', 'MapMenuData', 'TeamData', 'VoiceRosterData',
  'PublicTeamsData', 'NearbyPlayersData',
] as const;

type HudEvent = typeof HUD_EVENTS[number];
type HudProvider = typeof HUD_PROVIDERS[number];
type RosterSource = typeof ROSTER_SOURCES[number];

export interface HudRoomDiagnostic {
  event: HudEvent;
  provider: HudProvider;
  source: RosterSource;
  rosterCount: number;
  build: string;
}

export type RoomDiagnosticPayload = Record<string, unknown> & { event: string };

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
  return (values as readonly string[]).includes(value);
}

/** Strict, non-freeform HUD diagnostic parser. Values can only select fixed enums or bounded numbers. */
export function parseHudRoomDiagnostic(body: string): HudRoomDiagnostic | null {
  if (!body.startsWith(CONTROL_PREFIX) || Buffer.byteLength(body, 'utf8') > MAX_CONTROL_BYTES) return null;
  const fields = body.slice(CONTROL_PREFIX.length).split(';');
  if (fields.length !== 5) return null;
  const parsed = new Map<string, string>();
  for (const field of fields) {
    const separator = field.indexOf('=');
    if (separator <= 0 || parsed.has(field.slice(0, separator))) return null;
    parsed.set(field.slice(0, separator), field.slice(separator + 1));
  }
  if ([...parsed.keys()].sort().join(',') !== 'build,count,event,provider,source') return null;
  const event = parsed.get('event') ?? '';
  const provider = parsed.get('provider') ?? '';
  const source = parsed.get('source') ?? '';
  const countRaw = parsed.get('count') ?? '';
  const build = parsed.get('build') ?? '';
  if (!isOneOf(event, HUD_EVENTS) || !isOneOf(provider, HUD_PROVIDERS)
    || !isOneOf(source, ROSTER_SOURCES) || !/^(0|[1-9]|1[0-9]|2[0-4])$/.test(countRaw)
    || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(build)) return null;
  return { event, provider, source, rosterCount: Number(countRaw), build };
}

function diagnosticSecret(): string {
  // Some isolated suites replace the environment module with a minimal object.
  return env.HUD_IDENTITY_HASH_SECRET
    || process.env.HUD_IDENTITY_HASH_SECRET
    || FALLBACK_DIAGNOSTIC_SECRET;
}

/** Stable within an environment, but not reversible without the server secret. */
export function rosterNameRef(name: string): string {
  return createHmac('sha256', diagnosticSecret()).update(`room-diagnostic:name:${name}`).digest('hex').slice(0, 12);
}

/** UUIDs/nonces are already high entropy; hashing keeps raw operational identifiers out of evidence. */
export function opaqueRef(value: string): string {
  return createHash('sha256').update(`room-diagnostic:opaque:${value}`).digest('hex').slice(0, 12);
}

/** Best-effort evidence collection must never break room assignment when Redis diagnostics fail. */
export async function recordRoomDiagnostic(userId: string | null, payload: RoomDiagnosticPayload): Promise<void> {
  try {
    const redis = await getRedisClient();
    const entry = JSON.stringify({
      at: new Date().toISOString(),
      ...(userId ? { userRef: opaqueRef(userId) } : {}),
      ...payload,
    });
    await redis.lPush(GLOBAL_KEY, entry);
    await redis.lTrim(GLOBAL_KEY, 0, GLOBAL_LIMIT - 1);
    await redis.expire(GLOBAL_KEY, TTL_SECONDS);
    if (userId) {
      const key = USER_KEY(userId);
      await redis.lPush(key, entry);
      await redis.lTrim(key, 0, USER_LIMIT - 1);
      await redis.expire(key, TTL_SECONDS);
    }
  } catch (err) {
    logger.warn({ err }, '[roomDiagnostics] evidence write failed');
  }
}

export async function listRoomDiagnostics(userId: string | undefined, limit: number): Promise<unknown[]> {
  const redis = await getRedisClient();
  const raw = await redis.lRange(userId ? USER_KEY(userId) : GLOBAL_KEY, 0, limit - 1);
  return raw.map(value => {
    try { return JSON.parse(value) as unknown; }
    catch { return { parseError: true }; }
  });
}

export const ROOM_DIAGNOSTIC_CONTROL_PREFIX = CONTROL_PREFIX;
