/**
 * campImageService — mirror CAMP item images to MinIO and derive source labels.
 *
 * Images come from mrsblobby.github.io/76-CAMPDatabase/Live/Images/<formid>.webp
 * where formid is LOWERCASED (uppercase 404s).  The formid is derived as:
 *   (ARTO_FormID ?? CNAM_FormID).toLowerCase()
 *
 * Source detection mirrors the logic in the upstream script.js:
 *  1. ENTM_EDID / ENTM_FULL present → check ENTM prefix/key table → Atomic Shop / SCORE / F1
 *  2. BOOK_SOURCE_TAG → map each tag to its label (BullionVendorX, DailyOps, etc.)
 *  3. BOOK_FULL present → "Plan: <name>"
 *  4. Fallback → "Default / free"
 */

import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from '../config/storage';
import { isAllowedImageHost, ensureBucketOnce, fetchRemoteImage, putToMinio } from '../lib/imageStorage';
import logger from '../config/logger';

const IMAGES_BASE   = 'https://mrsblobby.github.io/76-CAMPDatabase/Live/Images/';
const CAMP_PREFIX   = 'camp-images/';
const MAX_BYTES     = 5 * 1024 * 1024; // 5 MB safety cap (images are ~2.7KB)

/** Valid formId for CAMP images: exactly 8 hex chars. */
const FORM_ID_RE = /^[0-9a-f]{8}$/i;

// ── Source-label tables (ported from upstream script.js IconAltText_BOOK) ──────

const BOOK_TAG_LABELS: Record<string, string> = {
  BullionVendor:              'Sold by Gold Bullion Vendor',
  BullionVendorMinerva:       'Sold by Gold Bullion Vendor (Minerva)',
  BullionVendorMortimer:      'Sold by Gold Bullion Vendor (Mortimer)',
  BullionVendorSamuel:        'Sold by Gold Bullion Vendor (Samuel)',
  BullionVendorWindy:         'Sold by Gold Bullion Vendor (Windy)',
  BullionVendorRegs:          'Sold by Gold Bullion Vendor (Regs)',
  StampsVendor:               'Sold by Giuseppe for Stamps',
  DailyOps:                   'Daily Ops Reward',
  CommonWorkshop:             'Common Workshop Claim/Defense Reward',
  RaidsReward:                'Gleaming Depths Raid Reward',
  TreasureHunters:            'Treasure Hunters Event Reward',
  MeatWeekRewards:            'Meat Week Seasonal Event Reward',
  FasnachtRewards:            'Fasnacht Seasonal Event Reward',
  InvadersRewards:            'Invaders from Beyond Seasonal Event Reward',
  HolidayScorched:            'Holiday Scorched Seasonal Event Reward',
  BigBloomRewards:            'Big Bloom Seasonal Event Reward',
  MischiefNightRewards:       'Mischief Night Seasonal Event Reward',
  SpookyScorched:             'Spooky Scorched Seasonal Event Reward',
  PublicEventRewards:         'Public Event Reward',
  EquinoxRewards:             'Mothman Equinox Seasonal Event Reward',
  GrahmVendor:                'Sold by Grahm',
  UnusedContent:              'Unused Content',
  ScorchedEarthRewards:       'Reward from Event: Scorched Earth',
  ColossalProblemRewards:     'Reward from Event: A Colossal Problem',
  BeastsOfBurdenRewards:      'Reward from Event: Beasts of Burden',
  CampfireTalesRewards:       'Reward from Event: Campfire Tales',
  DangerousPastimesRewards:   'Reward from Event: Dangerous Pastimes',
  MoonshineJamboreeRewards:   'Reward from Event: Moonshine Jamboree',
  MostWantedRewards:          'Reward from Event: Most Wanted',
  NWOTGenericRewards:         'Reward from Event: Most Wanted / Spin the Wheel / Tunnel of Love',
  NeurologicalWarfareRewards: 'Reward from Event: Neurological Warfare',
  RadiationRumbleRewards:     'Reward from Event: Radiation Rumble',
  SafeAndSoundRewards:        'Reward from Event: Safe and Sound',
  SeismicActivityRewards:     'Reward from Event: Seismic Activity',
  SpinTheWheelRewards:        'Reward from Event: Spin the Wheel',
  TestYourMetalRewards:       'Reward from Event: Test Your Metal',
  TunnelOfLoveRewards:        'Reward from Event: Tunnel of Love',
  GearinUpRewards:            'Reward from Event: Gearin\' Up',
  SinkholeSolutionsRewards:   'Reward from Event: Sinkhole Solutions',
  // NPC vendors for Caps
  NPCVendorIcon:              'Sold by non-robot NPC vendor for Caps',
  RobotVendorIcon:            'Sold by robot NPC vendor for Caps',
  // Named NPC vendors found in data
  BrotherhoodVendor:          'Sold by Brotherhood vendor for Caps',
  FreeStatesVendor:           'Sold by Free States vendor for Caps',
  RaiderVendor:               'Sold by Raider vendor for Caps',
  RespondersVendor:           'Sold by Responders vendor for Caps',
  MacVendor:                  'Sold by Mac for Caps',
  JuneSeaverVendor:           'Sold by June Seaver for Caps',
  PendletonVendor:            'Sold by Pendleton for Caps',
  WhitespringStationVendor:   'Sold by Whitespring Station vendor for Caps',
  // Learn / challenge
  LearnOnPickup:              'Loot to Unlock',
};

// ENTM (Atomic Shop / SCORE / F1) — keyed by UPPERCASE EDID prefix/exact
const ENTM_EXACT: Record<string, string> = {
  'F1_ENTM_CAMP_SCRAPBOX_STANDARD':      'Requires Fallout 1st Subscription',
  'F1_ENTM_CAMP_AMMOSTORAGEBOX_STANDARD':'Requires Fallout 1st Subscription',
  'F1_ENTM_CAMP_AIDBOX_STANDARD':        'Requires Fallout 1st Subscription',
};

const ENTM_PREFIX: Array<[string, string]> = [
  ['BABYLON_',    'Nuclear Winter Reward'],
  ['SHELTERS_',   'Atomic Shop Item'],
  ['DE2024_',     'Daily Challenges Event Reward'],
  ['ATX',         'Atomic Shop Item'],
  ['SCORE',       'S.C.O.R.E. Reward'],
  ['F1_',         'Requires Fallout 1st Subscription'],
];

// ── Source derivation ─────────────────────────────────────────────────────────

export interface CampSourceInfo {
  sourceType:  string;
  sourceLabel: string;
}

/**
 * Derive source type + label from a raw CAMP database record.
 * Mirrors the icon-selection logic in script.js.
 */
export function deriveCampSource(rec: Record<string, unknown>): CampSourceInfo {
  const entmEdid  = String(rec.ENTM_EDID  ?? '').trim();
  const entmFull  = String(rec.ENTM_FULL  ?? '').trim();
  const bookTags  = String(rec.BOOK_SOURCE_TAG ?? '').trim();
  const bookFull  = String(rec.BOOK_FULL  ?? '').trim();

  // 1. ENTM present → resolve via EDID
  if (entmEdid || entmFull) {
    const edidUp = entmEdid.toUpperCase();
    // Exact match
    if (ENTM_EXACT[edidUp]) {
      return { sourceType: 'fallout_1st', sourceLabel: ENTM_EXACT[edidUp] };
    }
    // Prefix match
    for (const [pfx, label] of ENTM_PREFIX) {
      if (edidUp.startsWith(pfx)) {
        const type = pfx.startsWith('SCORE') ? 'score' : pfx.startsWith('F1') ? 'fallout_1st' : 'atomic_shop';
        return { sourceType: type, sourceLabel: label };
      }
    }
    // Fallback: has entitlement → atomic shop
    return { sourceType: 'atomic_shop', sourceLabel: 'Atomic Shop Item' };
  }

  // 2. BOOK_SOURCE_TAG → derive from tags (multi-value: "TagA; TagB")
  if (bookTags) {
    const tags = bookTags
      .split(/[;,]+/)
      .map(t => t.trim().replace(/^['"\[]+|['"\]]+$/g, ''))
      .filter(Boolean);

    const labels: string[] = [];
    for (const tag of tags) {
      const label = BOOK_TAG_LABELS[tag] ?? BOOK_TAG_LABELS[tag.replace(/\d+$/, '')] ?? null;
      if (label && !labels.includes(label)) labels.push(label);
    }

    if (labels.length > 0) {
      // Determine a sourceType from the first recognized tag
      const firstTag = tags[0];
      const type = resolveTypeFromTag(firstTag);
      return { sourceType: type, sourceLabel: labels.join(' / ') };
    }
  }

  // 3. Has a plan → label the plan
  if (bookFull) {
    return { sourceType: 'plan', sourceLabel: `Plan: ${bookFull}` };
  }

  // 4. Fallback
  return { sourceType: 'default', sourceLabel: 'Default / free' };
}

function resolveTypeFromTag(tag: string): string {
  if (tag.startsWith('BullionVendor'))       return 'bullion';
  if (tag === 'StampsVendor')                return 'stamps';
  if (tag === 'DailyOps')                    return 'daily_ops';
  if (tag === 'RaidsReward')                 return 'raid';
  if (tag === 'CommonWorkshop')              return 'workshop';
  if (tag.endsWith('Rewards') || tag.endsWith('Scorched') || tag.endsWith('Bloom')) return 'seasonal_event';
  if (tag === 'TreasureHunters')             return 'seasonal_event';
  if (tag === 'GrahmVendor')                 return 'vendor';
  if (tag.endsWith('Vendor'))                return 'vendor';
  if (tag === 'UnusedContent')               return 'unused';
  if (tag === 'LearnOnPickup')               return 'loot';
  return 'event';
}

// ── Image formid derivation ───────────────────────────────────────────────────

/**
 * Compute the lowercase formid used for the Images/<formid>.webp URL.
 * Uses ARTO_FormID if present (non-null), else CNAM_FormID.
 */
export function campImageFormId(rec: Record<string, unknown>): string | null {
  const arto = rec.ARTO_FormID != null ? String(rec.ARTO_FormID).trim() : '';
  const cnam = rec.CNAM_FormID != null ? String(rec.CNAM_FormID).trim() : '';
  const raw  = arto || cnam;
  return raw ? raw.toLowerCase() : null;
}

// ── MinIO mirror ──────────────────────────────────────────────────────────────

/**
 * Check if a MinIO object already exists (HEAD request).
 */
async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror a CAMP item image into MinIO.
 * Key format: camp-images/<formid>.webp
 *
 * formId MUST match /^[0-9a-f]{8}$/i (path-injection guard). Returns null if not.
 *
 * Skips the download+upload if existingKey is already set (assume object present;
 * a concurrent job may have removed it — caller should pass existingKey = null to
 * force re-download).
 *
 * Returns the MinIO key on success, null on failure (non-fatal).
 */
export async function mirrorCampImage(formId: string, existingKey: string | null): Promise<string | null> {
  // formId validation — path-injection guard
  if (!FORM_ID_RE.test(formId)) {
    logger.warn({ formId }, '[campImage] rejected: formId fails validation');
    return null;
  }

  const key = `${CAMP_PREFIX}${formId}.webp`;

  // Skip if already stored (idempotent)
  if (existingKey === key) {
    // Verify it actually exists in MinIO; if not, re-download
    if (await objectExists(key)) return key;
  }

  const sourceUrl = `${IMAGES_BASE}${formId}.webp`;

  // SSRF allowlist check (mrsblobby.github.io is explicitly allowed)
  if (!isAllowedImageHost(sourceUrl)) {
    logger.warn({ sourceUrl, formId }, '[campImage] rejected: host not in SSRF allowlist');
    return null;
  }

  const result = await fetchRemoteImage(sourceUrl, MAX_BYTES);
  if (!result) {
    logger.debug({ formId, sourceUrl }, '[campImage] download failed or rejected, skipping');
    return null;
  }

  if (result.buf.length === 0) {
    logger.warn({ formId }, '[campImage] empty image body, skipping');
    return null;
  }

  const stored = await putToMinio(key, result.buf, result.contentType);
  if (stored) {
    logger.debug({ key, bytes: result.buf.length }, '[campImage] uploaded to MinIO');
  }
  return stored;
}
