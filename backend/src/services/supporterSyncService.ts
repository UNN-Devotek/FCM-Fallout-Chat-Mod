/**
 * Keeps supporter entitlements in lockstep with Discord tier roles and the
 * admin-role cosmetics bypass.
 *
 * Three paths, deliberately funnelled through the same
 * supporterService.syncFromDiscordRoles() so they cannot diverge:
 *
 *   1. GuildMemberUpdate — near-instant. Fires when Discord grants or removes a
 *      subscription role, so a purchase unlocks cosmetics within a second or two.
 *      Requires the GuildMembers PRIVILEGED intent (enable it in the Discord Developer
 *      Portal, separately for the dev and prod applications).
 *
 *   2. Periodic reconcile — the safety net. Gateway events are lossy across restarts
 *      and outages, so a sweep re-derives every entitlement from the live role list.
 *
 *   3. Explicit account refresh — login, link-status polling, overlay/dashboard
 *      reads, Discord `/cosmetics` interactions, and HUD sends use a bounded live
 *      member lookup so a role granted while the listeners were disabled is restored
 *      without waiting for another event.
 *
 * The reconcile sweep deliberately does NOT copy roleVerificationService's
 * one-second-sleep-per-user pacing. That is fine for the handful of rows in
 * admin_users, but supporters are customers and the population is expected to be
 * orders of magnitude larger — at 1s/user a few hundred supporters would take longer
 * than the interval. Instead it does a single bulk guild member fetch and diffs
 * in memory, which is one API call regardless of population.
 */
import type { Client, GuildMember, PartialGuildMember } from 'discord.js';
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { makeJobTracker } from '../jobs/jobTracker';
import {
  syncFromDiscordRolesWithResult,
  tierFromDiscordRoles,
  tierRoleIds,
  bustTierCache,
  lapseEntitlement,
} from './supporterService';
import type { DiscordRoleSyncResult, EntitlementSource } from './supporterService';
import { hasConfiguredCosmeticsRole } from '../utils/supporterTier';
import { refreshSupporterPresentation } from './supporterNicknameService';
import { bustCosmeticsCache } from './cosmetics/cosmeticsService';
import { getRedisClient } from '../config/redis';

/** 15 minutes. The gateway listener covers the fast path; this is the backstop. */
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
/** Reconcile immediately after Discord reports ready so re-enabled roles are restored at boot. */
const FIRST_RUN_DELAY_MS = 0;
/**
 * Live account refreshes need a faster role refresh than the periodic sweep, but a busy HUD
 * must not turn every chat message into a Discord API request. One refresh per
 * linked Discord account per minute is enough to make role changes visible
 * promptly while keeping the request rate bounded.
 */
export const HUD_ROLE_REFRESH_INTERVAL_MS = 60 * 1000;
const HUD_ROLE_REFRESH_LOCK_TTL_SECONDS = Math.ceil(HUD_ROLE_REFRESH_INTERVAL_MS / 1000);
const HUD_ROLE_REFRESH_LOCK_KEY_PREFIX = 'supporter:hud-role-refresh';
const MAX_HUD_ROLE_REFRESH_ENTRIES = 4096;

let clientRef: Client | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let firstRunHandle: ReturnType<typeof setTimeout> | null = null;

type HudRoleRefreshState = {
  lastAttemptAt: number;
  inFlight: Promise<void> | null;
};

const hudRoleRefreshState = new Map<string, HudRoleRefreshState>();
const linkedDiscordIdCache = new Map<string, { discordId: string | null; expiresAt: number }>();

const track = makeJobTracker('supporterReconcile');

/**
 * True when the tier is switched ON and at least one paid tier or admin cosmetics
 * role is configured.
 *
 * SUPPORTER_TIER_ENABLED is the master kill switch: with it off (the default, including
 * in production) no listener attaches and no sweep runs, so the feature costs nothing
 * and grants nothing until it is deliberately enabled.
 */
function configured(): boolean {
  if (!env.SUPPORTER_TIER_ENABLED) return false;
  return Boolean(env.SUPPORTER_ROLE_ID || env.OVERSEER_CIRCLE_ROLE_ID || env.ADMIN_ROLE_ID);
}

export type HudRoleRefreshRequest = {
  userId: string;
  /** Trusted value loaded from the FCM user row; omitted by the legacy TCP path. */
  discordId?: string | null;
};

export type HudRoleRefreshDependencies = {
  now?: () => number;
  isConfigured?: () => boolean;
  getUser?: (userId: string) => Promise<{ discordId: string | null } | null>;
  acquireSlot?: (discordId: string, now: number) => Promise<boolean>;
  fetchRoles?: (discordId: string) => Promise<readonly string[] | null>;
  syncRoles?: (
    discordId: string,
    discordRoles: readonly string[] | null | undefined,
    source?: EntitlementSource,
  ) => Promise<DiscordRoleSyncResult>;
  bustTier?: (discordId: string) => Promise<void>;
  bustCosmetics?: (userId: string) => Promise<void>;
  refreshPresentation?: (discordId: string, options?: { syncNickname?: boolean; syncRoles?: boolean }) => Promise<boolean>;
};

const hudRoleRefreshLockKey = (discordId: string): string =>
  `${HUD_ROLE_REFRESH_LOCK_KEY_PREFIX}:${env.NODE_ENV}:${discordId}`;

/** Acquire the deployment-wide role-check slot. The key intentionally expires
 * instead of being deleted so a Discord failure is still rate-limited. */
async function defaultAcquireHudRoleRefreshSlot(discordId: string, now: number): Promise<boolean> {
  const redis = await getRedisClient();
  const claimed = await redis.set(hudRoleRefreshLockKey(discordId), String(now), {
    NX: true,
    EX: HUD_ROLE_REFRESH_LOCK_TTL_SECONDS,
  });
  return claimed === 'OK';
}

async function defaultFetchHudMemberRoles(discordId: string): Promise<readonly string[] | null> {
  if (!clientRef || !env.DISCORD_SERVER_ID) return null;
  const guild = await clientRef.guilds.fetch(env.DISCORD_SERVER_ID);
  const member = await guild.members.fetch(discordId);
  return [...member.roles.cache.keys()];
}

function isMissingGuildMember(err: unknown): boolean {
  const candidate = err as { code?: number | string; status?: number; statusCode?: number } | null;
  return candidate?.code === 10007 || candidate?.code === '10007' || candidate?.status === 404 || candidate?.statusCode === 404;
}

function trimHudRoleRefreshState(now: number): void {
  if (hudRoleRefreshState.size <= MAX_HUD_ROLE_REFRESH_ENTRIES) return;
  for (const [discordId, state] of hudRoleRefreshState) {
    if (state.inFlight) continue;
    if (now - state.lastAttemptAt >= HUD_ROLE_REFRESH_INTERVAL_MS) hudRoleRefreshState.delete(discordId);
    if (hudRoleRefreshState.size <= MAX_HUD_ROLE_REFRESH_ENTRIES) break;
  }
}

function trimLinkedDiscordIdCache(now: number): void {
  if (linkedDiscordIdCache.size <= MAX_HUD_ROLE_REFRESH_ENTRIES) return;
  for (const [userId, state] of linkedDiscordIdCache) {
    if (state.expiresAt <= now) linkedDiscordIdCache.delete(userId);
    if (linkedDiscordIdCache.size <= MAX_HUD_ROLE_REFRESH_ENTRIES) break;
  }
}

async function resolveHudRequestDiscordId(
  request: HudRoleRefreshRequest,
  deps: HudRoleRefreshDependencies,
  now: () => number,
): Promise<string | null> {
  if (request.discordId !== undefined) {
    linkedDiscordIdCache.set(request.userId, {
      discordId: request.discordId,
      expiresAt: now() + HUD_ROLE_REFRESH_INTERVAL_MS,
    });
    return request.discordId;
  }

  const cached = linkedDiscordIdCache.get(request.userId);
  if (cached && cached.expiresAt > now()) return cached.discordId;

  const user = await (deps.getUser ?? (async (id: string) =>
    prisma.user.findUnique({ where: { id }, select: { discordId: true } })))(request.userId);
  const discordId = user?.discordId ?? null;
  linkedDiscordIdCache.set(request.userId, {
    discordId,
    expiresAt: now() + HUD_ROLE_REFRESH_INTERVAL_MS,
  });
  trimLinkedDiscordIdCache(now());
  return discordId;
}

async function applyHudRoleResult(
  request: HudRoleRefreshRequest,
  discordId: string,
  roles: readonly string[],
  deps: HudRoleRefreshDependencies,
): Promise<void> {
  const syncRoles = deps.syncRoles ?? ((id, roleIds, source) =>
    syncFromDiscordRolesWithResult(id, roleIds, source, { skipUnchanged: true }));
  const result = await syncRoles(discordId, roles, 'discord_sub');
  if (!result.changed) {
    // A role read is an authoritative consistency boundary even when the DB row was
    // already active. This matters after the feature flag has been re-enabled: a
    // stale Redis "none" value must not survive a successful Discord verification.
    await (deps.bustTier ?? bustTierCache)(discordId);
    await (deps.bustCosmetics ?? bustCosmeticsCache)(request.userId);
    return;
  }

  // Tier writes already invalidate the tier cache. Clear the resolved cosmetics
  // cache after a real tier transition, then push the refreshed identity to
  // connected web/overlay sessions. The HUD message itself is decorated after
  // this helper returns.
  await (deps.bustCosmetics ?? bustCosmeticsCache)(request.userId);
  await (deps.refreshPresentation ?? refreshSupporterPresentation)(discordId, {
    syncNickname: false,
    syncRoles: false,
  });
}

/**
 * Refresh a linked account's supporter roles from the live Discord member record.
 *
 * The client never supplies the role list. The Discord ID is either loaded from
 * the verified FCM account or supplied by a trusted relay caller. Discord outages,
 * rate limits, and other transient failures preserve the last known entitlement;
 * only a successful role read (or a definitive member-not-found response) can
 * change privileges. Redis coordinates the cooldown across backend replicas;
 * the in-process state is only a low-cost fast path and fallback. The periodic
 * reconcile remains the cross-restart safety net. Login, link-status, overlay,
 * dashboard, and Discord `/cosmetics` refreshes use this same bounded path, so a
 * role re-added while the sync listener was disabled is restored without waiting
 * for a gateway event.
 *
 * Dependencies are injectable so the bounded-refresh behavior can be tested
 * without a Discord gateway or database connection.
 */
export async function refreshSupporterFromDiscord(
  request: HudRoleRefreshRequest,
  deps: HudRoleRefreshDependencies = {},
): Promise<void> {
  const isConfigured = deps.isConfigured ?? configured;
  if (!isConfigured()) return;

  const now = deps.now ?? Date.now;
  let discordId: string | null;
  try {
    discordId = await resolveHudRequestDiscordId(request, deps, now);
  } catch (err) {
    logger.warn({ err, userId: request.userId }, '[supporterSync] live role refresh user lookup failed (non-fatal)');
    return;
  }

  if (!discordId) return;

  const existing = hudRoleRefreshState.get(discordId);
  if (existing?.inFlight) {
    await existing.inFlight;
    return;
  }
  if (existing && now() - existing.lastAttemptAt < HUD_ROLE_REFRESH_INTERVAL_MS) return;

  const state: HudRoleRefreshState = { lastAttemptAt: now(), inFlight: null };
  const refresh = (async () => {
    let acquired = true;
    try {
      acquired = await (deps.acquireSlot ?? defaultAcquireHudRoleRefreshSlot)(discordId, state.lastAttemptAt);
    } catch (err) {
      // Redis is already required by the relay, but supporter refresh is an
      // optional enhancement. Preserve availability and use this process's
      // cooldown if Redis briefly disappears; the normal reconcile remains the
      // cross-process safety net.
      logger.warn({ err, userId: request.userId, discordId }, '[supporterSync] live role refresh slot unavailable; using local cooldown (non-fatal)');
    }
    if (!acquired) return;

    let roles: readonly string[] | null;
    try {
      roles = await (deps.fetchRoles ?? defaultFetchHudMemberRoles)(discordId);
      if (!roles) return; // Discord client/guild is not ready; preserve known state.
    } catch (err) {
      // A definitive 404 means the member left the guild. Other failures are
      // transient and must not revoke a paid entitlement during an outage.
      if (isMissingGuildMember(err)) {
        try {
          await applyHudRoleResult(request, discordId, [], deps);
        } catch (syncErr) {
          logger.warn({ err: syncErr, userId: request.userId, discordId }, '[supporterSync] live member removal refresh failed (non-fatal)');
        }
        return;
      }
      logger.warn({ err, userId: request.userId, discordId }, '[supporterSync] live role fetch failed (non-fatal)');
      return;
    }

    try {
      await applyHudRoleResult(request, discordId, roles, deps);
    } catch (err) {
      logger.warn({ err, userId: request.userId, discordId }, '[supporterSync] live role reconciliation failed (non-fatal)');
    }
  })();

  state.inFlight = refresh;
  hudRoleRefreshState.set(discordId, state);
  trimHudRoleRefreshState(now());
  try {
    await refresh;
  } finally {
    // Keep the timestamp for the cooldown, but clear the promise so a later
    // message can perform the next periodic check even if a future dependency
    // throws outside the helper's non-fatal guards.
    if (hudRoleRefreshState.get(discordId) === state) state.inFlight = null;
  }
}

/** Refresh hook retained for the authenticated HUD relay path. */
export async function refreshSupporterFromHudSend(
  request: HudRoleRefreshRequest,
  deps: HudRoleRefreshDependencies = {},
): Promise<void> {
  return refreshSupporterFromDiscord(request, deps);
}

/** Test/shutdown helper for the in-process HUD refresh limiter. */
export function resetHudRoleRefreshState(): void {
  hudRoleRefreshState.clear();
  linkedDiscordIdCache.clear();
}

// ── Gateway listener ──────────────────────────────────────────────────────────

async function onGuildMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  try {
    if (!configured()) return;
    if (env.DISCORD_SERVER_ID && newMember.guild?.id !== env.DISCORD_SERVER_ID) return;

    const before = [...(oldMember.roles?.cache?.keys() ?? [])] as string[];
    const after = [...(newMember.roles?.cache?.keys() ?? [])] as string[];

    // Only act when the TIER actually changed. GuildMemberUpdate fires for nickname
    // edits, timeouts, avatar changes and every other role — without this guard a
    // busy guild would hammer the DB and bust the tier cache constantly.
    const tierBefore = tierFromDiscordRoles(before);
    const tierAfter = tierFromDiscordRoles(after);
    if (tierBefore === tierAfter) return;

    const result = await syncFromDiscordRolesWithResult(newMember.id, after, 'discord_sub');
    if (result.changed) await refreshSupporterPresentation(newMember.id);
    logger.info(
      { discordId: newMember.id, from: tierBefore, to: tierAfter },
      '[supporterSync] tier changed via GuildMemberUpdate',
    );
  } catch (err) {
    logger.warn({ err }, '[supporterSync] GuildMemberUpdate handler failed (non-fatal)');
  }
}

/**
 * A member leaving the guild loses their roles without a GuildMemberUpdate, so handle
 * removal explicitly. Privileges suspend; the entitlement row is RETAINED so rejoining
 * restores everything without re-purchasing (#230).
 */
async function onGuildMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
  try {
    if (!configured()) return;
    if (env.DISCORD_SERVER_ID && member.guild?.id !== env.DISCORD_SERVER_ID) return;
    const changed = await lapseEntitlement({ discordId: member.id, reason: 'left the guild' });
    // The member is already gone, so there is no guild nickname to update. The
    // cache bust + live FCM refresh still matters for their open sessions.
    if (changed) {
      // The member has already left, so Discord has no member object from which
      // cosmetic roles could be removed. FCM cache/live presentation still needs
      // refreshing, but role sync must wait for a future rejoin.
      await refreshSupporterPresentation(member.id, { syncNickname: false, syncRoles: false });
    }
  } catch (err) {
    logger.warn({ err }, '[supporterSync] GuildMemberRemove handler failed (non-fatal)');
  }
}

// ── Reconcile sweep ───────────────────────────────────────────────────────────

/**
 * Re-derive every entitlement from the guild's live role assignments.
 *
 * Exported (and dependency-injected) so it can be unit-tested without a gateway.
 */
export type SupporterReconcileDependencies = {
  fetchMembers?: () => Promise<Map<string, readonly string[]>>;
  listEntitlements?: () => Promise<Array<{ discordId: string; status: string }>>;
  resolveTier?: (roles: readonly string[] | null | undefined) => ReturnType<typeof tierFromDiscordRoles>;
  syncRoles?: (
    discordId: string,
    discordRoles: readonly string[] | null | undefined,
    source?: EntitlementSource,
  ) => Promise<DiscordRoleSyncResult>;
  refreshPresentation?: (discordId: string) => Promise<boolean>;
  lapse?: (opts: Parameters<typeof lapseEntitlement>[0]) => Promise<boolean>;
};

export async function runReconcile(
  deps: SupporterReconcileDependencies = {},
): Promise<{ granted: number; lapsed: number; checked: number }> {
  const fetchMembers = deps?.fetchMembers ?? defaultFetchMembers;
  const listEntitlements =
    deps?.listEntitlements ??
    (() =>
      prisma.supporterEntitlement.findMany({
        where: { status: 'active' },
        select: { discordId: true, status: true },
      }));
  const resolveTier = deps.resolveTier ?? tierFromDiscordRoles;
  const syncRoles = deps.syncRoles ?? ((discordId, roles, source) =>
    syncFromDiscordRolesWithResult(discordId, roles, source));
  const refreshPresentation = deps.refreshPresentation ?? ((discordId: string) =>
    refreshSupporterPresentation(discordId));
  const lapse = deps.lapse ?? lapseEntitlement;

  const roleMembers = await fetchMembers();
  let granted = 0;
  let lapsed = 0;

  // Anyone currently holding a paid tier or admin cosmetics role: grant or refresh.
  for (const [discordId, roles] of roleMembers) {
    const tier = resolveTier(roles);
    if (tier === 'none') continue;
    const result = await syncRoles(discordId, roles, 'discord_sub');
    if (result.changed) {
      await refreshPresentation(discordId);
      granted++;
    }
  }

  // Anyone marked active who no longer holds a role: lapse. This is the path that
  // catches cancellations and departures missed while the bot was down.
  const active = await listEntitlements();
  for (const row of active) {
    if (roleMembers.has(row.discordId)) {
      const tier = resolveTier(roleMembers.get(row.discordId) ?? []);
      if (tier !== 'none') continue;
    }
    const changed = await lapse({ discordId: row.discordId, reason: 'reconcile: tier role not held' });
    if (changed) {
      await refreshPresentation(row.discordId);
      lapsed++;
    }
  }

  logger.info({ granted, lapsed, checked: roleMembers.size }, '[supporterSync] reconcile complete');
  return { granted, lapsed, checked: roleMembers.size };
}

/**
 * One bulk guild fetch, then filter in memory. `guild.members.fetch()` pages through
 * the whole member list over the gateway in a single logical call, which is why this
 * scales where a per-user REST loop would not.
 */
async function defaultFetchMembers(): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  if (!clientRef || !env.DISCORD_SERVER_ID) return out;

  const guild = await clientRef.guilds.fetch(env.DISCORD_SERVER_ID);
  const members = await guild.members.fetch();
  const cosmeticsRoleIds = tierRoleIds();

  for (const [id, member] of members) {
    const roles = [...member.roles.cache.keys()];
    // Only carry members who hold a paid tier or admin cosmetics role — the map is
    // then small regardless of guild size, and the lapse pass below treats
    // "absent" as "no longer entitled".
    if (hasConfiguredCosmeticsRole(roles, cosmeticsRoleIds)) out.set(id, roles);
  }
  return out;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function register(client: Client): void {
  clientRef = client;

  if (!configured()) {
    logger.info(
      { tierEnabled: env.SUPPORTER_TIER_ENABLED },
      '[supporterSync] disabled (tier switched off, or no tier/admin cosmetics roles configured)',
    );
    return;
  }

  client.on('guildMemberUpdate', (o, n) => void onGuildMemberUpdate(o, n));
  client.on('guildMemberRemove', (m) => void onGuildMemberRemove(m));

  client.once('ready', () => {
    firstRunHandle = setTimeout(() => {
      void track(async () => { await runReconcile(); });
    }, FIRST_RUN_DELAY_MS);

    intervalHandle = setInterval(() => {
      void track(async () => { await runReconcile(); });
    }, RECONCILE_INTERVAL_MS);

    logger.info(
      { intervalMs: RECONCILE_INTERVAL_MS },
      '[supporterSync] registered (GuildMemberUpdate + periodic reconcile)',
    );
  });
}

/** Test/shutdown helper. */
export function stop(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  if (firstRunHandle) clearTimeout(firstRunHandle);
  intervalHandle = null;
  firstRunHandle = null;
}

export default {
  register,
  stop,
  runReconcile,
  refreshSupporterFromDiscord,
  refreshSupporterFromHudSend,
  resetHudRoleRefreshState,
};
module.exports = {
  register,
  stop,
  runReconcile,
  refreshSupporterFromDiscord,
  refreshSupporterFromHudSend,
  resetHudRoleRefreshState,
};
module.exports.default = module.exports;
