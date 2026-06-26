import env from '../config/environment';
import type { DevAuthDeps } from './devAuthService';

/**
 * Pure QA-role check (dev guild only). Authorized iff the caller holds the
 * configured QA role ID. No network, no env access — deterministic.
 */
export function verifyQaRole(
  devMemberRoles: string[],
  qaRoleId: string,
): { authorized: boolean; reason?: string } {
  if (!qaRoleId) {
    return { authorized: false, reason: 'QA gate is not configured (missing QA role ID).' };
  }
  const has = Array.isArray(devMemberRoles) && devMemberRoles.includes(qaRoleId);
  return has ? { authorized: true } : { authorized: false, reason: 'Missing the QA role in the dev Discord.' };
}

export interface QaAccessResult {
  discordUserId: string;
  authorized: boolean;
  reason?: string;
}

/**
 * Reads the caller's roles in the DEV guild via the injected deps boundary and
 * applies verifyQaRole. The dev bot is in the dev guild, so the OAuth
 * guilds.members.read path (discordOAuthDeps) works here.
 */
export async function checkQaAccess(
  discordUserId: string,
  deps: DevAuthDeps,
  accessToken = '',
): Promise<QaAccessResult> {
  const devGuildId = env.DEV_GUILD_ID;
  const qaRoleId = env.DEV_QA_ROLE_ID;
  if (!devGuildId || !qaRoleId) {
    return { discordUserId, authorized: false, reason: 'QA gate is not configured (missing guild or role ID).' };
  }
  let roles: string[];
  try {
    roles = await deps.fetchGuildMemberRoles(devGuildId, discordUserId, accessToken);
  } catch (err) {
    return {
      discordUserId,
      authorized: false,
      reason: `Failed to read dev-guild membership: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { discordUserId, ...verifyQaRole(roles, qaRoleId) };
}
