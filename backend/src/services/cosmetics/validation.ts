/**
 * Pure validation for cosmetic input — no Prisma, no Redis, no network.
 *
 * The impure checks (name blacklist, automod, cooldown against stored state) live in
 * cosmeticsService; everything decidable from the input alone lives here so it can be
 * unit-tested exhaustively and reused by the frontend picker's live feedback.
 */
import { SupporterTier, tierAtLeast } from '../../utils/supporterTier';
import { normalizeHex, meetsContrastFloor, worstCaseContrast, MIN_CONTRAST } from '../../utils/colorContrast';
import { findReservedConflict, ReservedColor } from './reservedColors';
import { findColorPreset, findEffectPreset } from './presets';

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 32;
export const TAG_MAX_LENGTH = 12;

/**
 * Characters stripped from any user-supplied display name or tag.
 *
 * `~` and `|` are field separators in the in-game HUD wire format; `<`, `>`, `&` and
 * `"` are escaped into HTML entities by the widget's htmlEscape() (FcmConfig.hx) and
 * would show as visible mojibake, and unescaped they would let a hostile name inject
 * a <font> tag and impersonate another user. `\` is stripped because it is the JSON
 * escape lead-in on the relay path.
 *
 * Control characters are removed separately — they poison the ZFE string pool.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[~|"\\<>&\u0000-\u001F\u007F]/g;

/** Zero-width and bidi-override characters: invisible, and usable to spoof a name. */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export type CosmeticRejection =
  | { field: 'displayName'; code: 'too_short' | 'too_long' | 'empty_after_sanitize' }
  | { field: 'customTag'; code: 'too_long' | 'empty_after_sanitize' }
  | { field: 'colorPresetId'; code: 'unknown_preset' }
  | { field: 'effectId'; code: 'unknown_preset' }
  | { field: 'customColorHex'; code: 'unparseable' | 'low_contrast' | 'reserved'; detail?: string; ratio?: number; reserved?: ReservedColor }
  | { field: 'colorPresetId' | 'effectId' | 'customTag'; code: 'tier_locked'; requiredTier: SupporterTier };

/**
 * Strip unsafe and invisible characters and collapse whitespace.
 * Returns the cleaned string, which may be empty — callers must check.
 */
export function sanitizeName(raw: string): string {
  return raw
    .replace(UNSAFE_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Validate a display name's shape. Blacklist/automod checks happen in the service. */
export function validateDisplayName(raw: string): { ok: true; value: string } | { ok: false; rejection: CosmeticRejection } {
  const cleaned = sanitizeName(raw);
  if (cleaned.length === 0) {
    return { ok: false, rejection: { field: 'displayName', code: 'empty_after_sanitize' } };
  }
  if (cleaned.length < NAME_MIN_LENGTH) {
    return { ok: false, rejection: { field: 'displayName', code: 'too_short' } };
  }
  if (cleaned.length > NAME_MAX_LENGTH) {
    return { ok: false, rejection: { field: 'displayName', code: 'too_long' } };
  }
  return { ok: true, value: cleaned };
}

/** Validate the Overseer-tier custom tag. */
export function validateTag(raw: string, tier: SupporterTier): { ok: true; value: string } | { ok: false; rejection: CosmeticRejection } {
  if (!tierAtLeast(tier, 'overseer')) {
    return { ok: false, rejection: { field: 'customTag', code: 'tier_locked', requiredTier: 'overseer' } };
  }
  const cleaned = sanitizeName(raw);
  if (cleaned.length === 0) {
    return { ok: false, rejection: { field: 'customTag', code: 'empty_after_sanitize' } };
  }
  if (cleaned.length > TAG_MAX_LENGTH) {
    return { ok: false, rejection: { field: 'customTag', code: 'too_long' } };
  }
  return { ok: true, value: cleaned };
}

/** Validate a catalog colour preset against the caller's tier. */
export function validateColorPreset(id: string, tier: SupporterTier): { ok: true; value: string } | { ok: false; rejection: CosmeticRejection } {
  const preset = findColorPreset(id);
  if (!preset) return { ok: false, rejection: { field: 'colorPresetId', code: 'unknown_preset' } };
  if (!tierAtLeast(tier, preset.tier)) {
    return { ok: false, rejection: { field: 'colorPresetId', code: 'tier_locked', requiredTier: preset.tier } };
  }
  return { ok: true, value: preset.id };
}

/** Validate an effect preset against the caller's tier. */
export function validateEffect(id: string, tier: SupporterTier): { ok: true; value: string } | { ok: false; rejection: CosmeticRejection } {
  const preset = findEffectPreset(id);
  if (!preset) return { ok: false, rejection: { field: 'effectId', code: 'unknown_preset' } };
  if (!tierAtLeast(tier, preset.tier)) {
    return { ok: false, rejection: { field: 'effectId', code: 'tier_locked', requiredTier: preset.tier } };
  }
  return { ok: true, value: preset.id };
}

/**
 * Validate a free-form colour from the HSL picker.
 *
 * The picker clamps client-side, but this is the authoritative check — the same colour
 * arriving from a hand-rolled API call or a Discord command must clear the identical
 * bar. Order matters: reject unparseable first, then contrast (legibility), then
 * reserved (impersonation), so the message the user gets names the real problem.
 */
export function validateCustomColor(raw: string): { ok: true; value: string } | { ok: false; rejection: CosmeticRejection } {
  const hex = normalizeHex(raw);
  if (!hex) {
    return { ok: false, rejection: { field: 'customColorHex', code: 'unparseable', detail: raw } };
  }
  if (!meetsContrastFloor(hex)) {
    return {
      ok: false,
      rejection: { field: 'customColorHex', code: 'low_contrast', ratio: worstCaseContrast(hex), detail: `${MIN_CONTRAST}` },
    };
  }
  const conflict = findReservedConflict(hex);
  if (conflict) {
    return { ok: false, rejection: { field: 'customColorHex', code: 'reserved', reserved: conflict } };
  }
  return { ok: true, value: hex };
}

export default {
  NAME_MIN_LENGTH,
  NAME_MAX_LENGTH,
  TAG_MAX_LENGTH,
  sanitizeName,
  validateDisplayName,
  validateTag,
  validateColorPreset,
  validateEffect,
  validateCustomColor,
};
module.exports = {
  NAME_MIN_LENGTH,
  NAME_MAX_LENGTH,
  TAG_MAX_LENGTH,
  sanitizeName,
  validateDisplayName,
  validateTag,
  validateColorPreset,
  validateEffect,
  validateCustomColor,
};
module.exports.default = module.exports;
