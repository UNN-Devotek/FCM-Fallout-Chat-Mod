/**
 * Mirrors the effective FCM colour/effect selection to Discord roles.
 *
 * Discord cannot render FCM effects or arbitrary per-user colours directly. A role
 * is therefore the bridge: colour roles provide Discord's name colour, while effect
 * roles record the selected FCM effect for a member. The web profile, overlay and
 * Discord slash command all converge here through cosmeticsService.
 */
import logger from '../../config/logger';
import env from '../../config/environment';
import type { ResolvedCosmetics } from './cosmeticsService';
import {
  buildCosmeticRoleSyncPlan,
  COSMETIC_ROLE_DEFINITIONS,
  desiredCosmeticRoleNames,
  type CosmeticRoleLike,
} from './roleDefinitions';

export interface DiscordCosmeticRoleSyncResult {
  ok: boolean;
  added: string[];
  removed: string[];
  missing: string[];
}

const NOOP: DiscordCosmeticRoleSyncResult = {
  ok: false,
  added: [],
  removed: [],
  missing: [],
};

/**
 * Apply the user's effective appearance to the configured FCM Discord guild.
 * Missing or mis-positioned production roles are reported but never make a saved
 * cosmetics request fail: the FCM appearance is already persisted and still renders
 * correctly in the website, overlay and chat protocol.
 */
export async function syncCosmeticDiscordRoles(
  discordId: string,
  cosmetics: Pick<ResolvedCosmetics, 'nameColor' | 'effectId'>,
): Promise<DiscordCosmeticRoleSyncResult> {
  if (!discordId || !env.SUPPORTER_TIER_ENABLED || !env.DISCORD_TOKEN || !env.DISCORD_SERVER_ID) {
    return NOOP;
  }

  try {
    // Lazy import avoids the discordService ↔ supporter/cosmetics module cycle at boot.
    const { getDiscordClient, getStatus } = await import('../discordService.js');
    const client = getDiscordClient();
    if (!client || getStatus() !== 'connected') {
      logger.debug({ discordId }, '[cosmetics] Discord role sync skipped — bot not connected');
      return NOOP;
    }

    const guild = await client.guilds.fetch(env.DISCORD_SERVER_ID);
    const botMember = await guild.members.fetchMe();
    const botTopPosition = botMember.roles.highest.position;
    const fetchedRoles = await guild.roles.fetch();
    const allRoles = [...fetchedRoles.values()];
    const definitionNames = new Set(COSMETIC_ROLE_DEFINITIONS.map((definition) => definition.name.toLowerCase()));
    const manageableRoles: CosmeticRoleLike[] = allRoles
      .filter((role) => definitionNames.has(role.name.toLowerCase()) && !role.managed && role.position < botTopPosition)
      .map((role) => ({ id: role.id, name: role.name, managed: role.managed }));

    const desiredRoleNames = desiredCosmeticRoleNames(cosmetics);
    const member = await guild.members.fetch(discordId);
    const memberRoleIds = [...member.roles.cache.keys()];
    const plan = buildCosmeticRoleSyncPlan(manageableRoles, memberRoleIds, desiredRoleNames);

    if (plan.missingRoleNames.length > 0) {
      logger.warn(
        { discordId, missingRoleNames: plan.missingRoleNames },
        '[cosmetics] Discord role sync incomplete — create the catalog roles and keep them below the bot',
      );
    }

    // Add first so a successful selection never leaves the member without a colour
    // while the old role is being removed. The plan ensures only one role per family
    // is desired, and Discord's normal role hierarchy determines the visible colour.
    if (plan.addRoleIds.length > 0) {
      await member.roles.add(plan.addRoleIds, 'FCM chat appearance sync');
    }
    if (plan.removeRoleIds.length > 0) {
      await member.roles.remove(plan.removeRoleIds, 'FCM chat appearance sync');
    }

    return {
      ok: plan.missingRoleNames.length === 0,
      added: plan.addRoleIds,
      removed: plan.removeRoleIds,
      missing: plan.missingRoleNames,
    };
  } catch (err) {
    // The DB write and FCM rendering must not be held hostage by a Discord outage,
    // role hierarchy issue, or a member who left between the two API calls.
    logger.warn({ err, discordId }, '[cosmetics] Discord role sync failed (non-fatal)');
    return NOOP;
  }
}

export default { syncCosmeticDiscordRoles };
module.exports = { syncCosmeticDiscordRoles };
module.exports.default = module.exports;
