/**
 * Discord role definitions for the FCM appearance catalog.
 *
 * The catalog is the source of truth for both the UI and Discord.  Role names are
 * deliberately the same as the user-facing preset labels so a maintainer can create
 * the roles by hand in production and the sync service can find them without another
 * set of environment variables for every colour and effect.
 */
import { COLOR_PRESETS, EFFECT_PRESETS } from './presets';
import type { ResolvedCosmetics } from './cosmeticsService';

export type CosmeticRoleKind = 'color' | 'effect';

export interface CosmeticRoleDefinition {
  kind: CosmeticRoleKind;
  presetId: string;
  name: string;
  /** Discord role colour as a 24-bit integer. Effects intentionally have no colour. */
  color: number;
}

export interface CosmeticRoleLike {
  id: string;
  name: string;
  managed?: boolean;
}

function discordColor(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

export const COLOR_ROLE_DEFINITIONS: readonly CosmeticRoleDefinition[] = COLOR_PRESETS.map((preset) => ({
  kind: 'color' as const,
  presetId: preset.id,
  name: preset.label,
  color: discordColor(preset.hex),
}));

/** `none` has no role: clearing an effect removes the user's effect role. */
export const EFFECT_ROLE_DEFINITIONS: readonly CosmeticRoleDefinition[] = EFFECT_PRESETS
  .filter((preset) => preset.id !== 'none')
  .map((preset) => ({
    kind: 'effect' as const,
    presetId: preset.id,
    name: preset.label,
    color: 0,
  }));

export const COSMETIC_ROLE_DEFINITIONS: readonly CosmeticRoleDefinition[] = [
  ...COLOR_ROLE_DEFINITIONS,
  ...EFFECT_ROLE_DEFINITIONS,
];

const colorByHex = new Map(
  COLOR_PRESETS.map((preset) => [preset.hex.toUpperCase(), preset.label]),
);
const effectById = new Map(
  EFFECT_ROLE_DEFINITIONS.map((definition) => [definition.presetId, definition.name]),
);

/** Return the Discord role names that represent a user's effective FCM appearance. */
export function desiredCosmeticRoleNames(cosmetics: Pick<ResolvedCosmetics, 'nameColor' | 'effectId'>): string[] {
  const names: string[] = [];
  const colorName = cosmetics.nameColor ? colorByHex.get(cosmetics.nameColor.toUpperCase()) : undefined;
  if (colorName) names.push(colorName);
  const effectName = cosmetics.effectId ? effectById.get(cosmetics.effectId) : undefined;
  if (effectName) names.push(effectName);
  return names;
}

export interface CosmeticRoleSyncPlan {
  addRoleIds: string[];
  removeRoleIds: string[];
  /** Desired roles that are not present as manageable roles in the guild. */
  missingRoleNames: string[];
}

/**
 * Build an idempotent role diff.
 *
 * A family is only changed when its desired role exists.  If production is missing a
 * role someone just selected, retaining the old role is safer than briefly removing
 * the user's existing Discord colour/effect and leaving them with nothing.
 */
export function buildCosmeticRoleSyncPlan(
  roles: readonly CosmeticRoleLike[],
  memberRoleIds: readonly string[],
  desiredRoleNames: readonly string[],
): CosmeticRoleSyncPlan {
  const manageableByName = new Map<string, CosmeticRoleLike>();
  for (const role of roles) {
    if (role.managed === true) continue;
    const key = role.name.toLowerCase();
    if (!manageableByName.has(key)) manageableByName.set(key, role);
  }

  const memberIds = new Set(memberRoleIds);
  const desired = new Set(desiredRoleNames.map((name) => name.toLowerCase()));
  const addRoleIds: string[] = [];
  const removeRoleIds: string[] = [];
  const missingRoleNames: string[] = [];

  for (const kind of ['color', 'effect'] as const) {
    const family = COSMETIC_ROLE_DEFINITIONS.filter((definition) => definition.kind === kind);
    const desiredFamily = family.filter((definition) => desired.has(definition.name.toLowerCase()));
    const missingFamily = desiredFamily.filter(
      (definition) => !manageableByName.has(definition.name.toLowerCase()),
    );

    if (missingFamily.length > 0) {
      // Do not disturb the current family if the newly selected role was not
      // provisioned (or cannot be managed because it sits above the bot).
      missingRoleNames.push(...missingFamily.map((definition) => definition.name));
      continue;
    }

    for (const definition of family) {
      const role = manageableByName.get(definition.name.toLowerCase());
      if (!role) continue;
      const isDesired = desired.has(definition.name.toLowerCase());
      if (isDesired && !memberIds.has(role.id)) addRoleIds.push(role.id);
      if (!isDesired && memberIds.has(role.id)) removeRoleIds.push(role.id);
    }
  }

  return { addRoleIds, removeRoleIds, missingRoleNames };
}

export default {
  COLOR_ROLE_DEFINITIONS,
  EFFECT_ROLE_DEFINITIONS,
  COSMETIC_ROLE_DEFINITIONS,
  desiredCosmeticRoleNames,
  buildCosmeticRoleSyncPlan,
};

module.exports = {
  COLOR_ROLE_DEFINITIONS,
  EFFECT_ROLE_DEFINITIONS,
  COSMETIC_ROLE_DEFINITIONS,
  desiredCosmeticRoleNames,
  buildCosmeticRoleSyncPlan,
};
module.exports.default = module.exports;
