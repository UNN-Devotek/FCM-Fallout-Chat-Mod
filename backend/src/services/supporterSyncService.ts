/**
 * Keeps supporter entitlements in lockstep with Discord tier roles.
 *
 * Two paths, deliberately funnelled through the same
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
  syncFromDiscordRoles,
  tierFromDiscordRoles,
  lapseEntitlement,
} from './supporterService';

/** 15 minutes. The gateway listener covers the fast path; this is the backstop. */
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
/** Delay the first sweep so it does not pile onto boot. */
const FIRST_RUN_DELAY_MS = 60 * 1000;

let clientRef: Client | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let firstRunHandle: ReturnType<typeof setTimeout> | null = null;

const track = makeJobTracker('supporterReconcile');

/**
 * True when the tier is switched ON and at least one tier role is configured.
 *
 * SUPPORTER_TIER_ENABLED is the master kill switch: with it off (the default, including
 * in production) no listener attaches and no sweep runs, so the feature costs nothing
 * and grants nothing until it is deliberately enabled.
 */
function configured(): boolean {
  if (!env.SUPPORTER_TIER_ENABLED) return false;
  return Boolean(env.SUPPORTER_ROLE_ID || env.OVERSEER_CIRCLE_ROLE_ID);
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

    await syncFromDiscordRoles(newMember.id, after, 'discord_sub');
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
    await lapseEntitlement({ discordId: member.id, reason: 'left the guild' });
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
export async function runReconcile(deps?: {
  fetchMembers?: () => Promise<Map<string, readonly string[]>>;
  listEntitlements?: () => Promise<Array<{ discordId: string; status: string }>>;
}): Promise<{ granted: number; lapsed: number; checked: number }> {
  const fetchMembers = deps?.fetchMembers ?? defaultFetchMembers;
  const listEntitlements =
    deps?.listEntitlements ??
    (() =>
      prisma.supporterEntitlement.findMany({
        where: { status: 'active' },
        select: { discordId: true, status: true },
      }));

  const roleMembers = await fetchMembers();
  let granted = 0;
  let lapsed = 0;

  // Anyone currently holding a tier role: grant or refresh.
  for (const [discordId, roles] of roleMembers) {
    const tier = tierFromDiscordRoles(roles);
    if (tier === 'none') continue;
    await syncFromDiscordRoles(discordId, roles, 'discord_sub');
    granted++;
  }

  // Anyone marked active who no longer holds a role: lapse. This is the path that
  // catches cancellations and departures missed while the bot was down.
  const active = await listEntitlements();
  for (const row of active) {
    if (roleMembers.has(row.discordId)) {
      const tier = tierFromDiscordRoles(roleMembers.get(row.discordId) ?? []);
      if (tier !== 'none') continue;
    }
    await lapseEntitlement({ discordId: row.discordId, reason: 'reconcile: tier role not held' });
    lapsed++;
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
  const tierRoleIdSet = new Set([env.SUPPORTER_ROLE_ID, env.OVERSEER_CIRCLE_ROLE_ID].filter(Boolean));

  for (const [id, member] of members) {
    const roles = [...member.roles.cache.keys()];
    // Only carry members who hold a tier role — the map is then small regardless of
    // guild size, and the lapse pass below treats "absent" as "no longer entitled".
    if (roles.some((r) => tierRoleIdSet.has(r))) out.set(id, roles);
  }
  return out;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function register(client: Client): void {
  clientRef = client;

  if (!configured()) {
    logger.info(
      { tierEnabled: env.SUPPORTER_TIER_ENABLED },
      '[supporterSync] disabled (tier switched off, or no tier roles configured)',
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

export default { register, stop, runReconcile };
module.exports = { register, stop, runReconcile };
module.exports.default = module.exports;
