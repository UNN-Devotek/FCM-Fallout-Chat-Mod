/**
 * hudIdentityService.ts — M7 two-way in-game chat identity resolution.
 *
 * Derives identityHash = HMAC-SHA256(HUD_IDENTITY_SECRET, accountName) hex,
 * then resolves or auto-provisions a User row on every HELLO handshake.
 *
 * Priority order for resolving a user from a HELLO:
 *  1. Existing user already linked to this identityHash → use it; reconcile
 *     fo76CharacterName if it changed.
 *  2a. Existing user whose fo76CharacterName matches characterName AND is not
 *     yet linked to any identityHash AND exactly ONE such user exists →
 *     auto-pair by attaching identityHash + fo76AccountName.
 *     (If two+ users claim the same character name, fall through to #2b.)
 *  2b. Existing user whose username OR discordUsername matches accountName (case-
 *     insensitive) AND is not yet linked to any identityHash AND exactly ONE such
 *     user exists → auto-pair by account name. Handles the common case where the
 *     Bethesda account name matches the Discord username but fo76CharacterName was
 *     never set on the Discord account (e.g. accountName "Devotek-" == username
 *     "Devotek-").
 *  3. Auto-provision a new lightweight user keyed on identityHash.
 *
 * Block operations: blockHash / unblockHash / getActiveBlock.
 * Called at HELLO (ban → destroy socket) and ingestMessage (mute → drop).
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import env from '../config/environment';
import logger from '../config/logger';

// ── Default-secret guard (SR-003) ─────────────────────────────────────────────

/**
 * The dev fallback value for HUD_IDENTITY_SECRET. MUST stay in sync with the
 * default in config/environment.ts. If the deployed secret still equals this,
 * identityHash derivation uses a publicly-known key and HUD identities become
 * forgeable — callers (initHudPushTcp) refuse to start the inbound chat path.
 */
export const DEV_DEFAULT_IDENTITY_SECRET = 'dev-hud-identity-secret-change-me';

/** True when HUD_IDENTITY_SECRET is unset / still the public dev default. */
export function usingDefaultIdentitySecret(): boolean {
  return !env.HUD_IDENTITY_SECRET || env.HUD_IDENTITY_SECRET === DEV_DEFAULT_IDENTITY_SECRET;
}

// ── Hash derivation ───────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256(HUD_IDENTITY_SECRET, accountName) → hex string.
 * Stable and server-side; the SWF never sees the raw hash.
 */
export function deriveIdentityHash(accountName: string): string {
  return crypto
    .createHmac('sha256', env.HUD_IDENTITY_SECRET)
    .update(accountName)
    .digest('hex');
}

// ── Identity resolution ───────────────────────────────────────────────────────

export interface HudIdentityResult {
  userId: string;
  identityHash: string;
}

/**
 * Resolve or provision a user from a HELLO handshake.
 * Always returns a userId; never throws on DB errors (logs + returns null).
 * Returns null only on unrecoverable errors — caller should destroy socket.
 */
export async function resolveHudIdentity(
  accountName: string,
  characterName: string,
): Promise<HudIdentityResult | null> {
  const identityHash = deriveIdentityHash(accountName);

  try {
    // ── Priority 1: already linked to this hash ───────────────────────────
    const existing = await prisma.user.findUnique({
      where: { identityHash },
      select: { id: true, fo76CharacterName: true },
    });

    if (existing) {
      // Reconcile character name if it changed (character rename in-game).
      if (existing.fo76CharacterName !== characterName) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { fo76CharacterName: characterName },
        });
        logger.info(
          { userId: existing.id, old: existing.fo76CharacterName, new: characterName },
          '[hudIdentity] reconciled fo76CharacterName',
        );
      }
      return { userId: existing.id, identityHash };
    }

    // ── Priority 2: auto-pair by character name ───────────────────────────
    // Only when exactly one unlinked user claims this character name.
    const nameMatches = await prisma.user.findMany({
      where: { fo76CharacterName: characterName, identityHash: null },
      select: { id: true },
    });

    if (nameMatches.length === 1) {
      const target = nameMatches[0];
      await prisma.user.update({
        where: { id: target.id },
        data: { identityHash, fo76AccountName: accountName, fo76CharacterName: characterName },
      });
      logger.info(
        { userId: target.id, characterName },
        '[hudIdentity] auto-paired existing user by characterName',
      );
      return { userId: target.id, identityHash };
    }

    if (nameMatches.length > 1) {
      logger.warn(
        { characterName, count: nameMatches.length },
        '[hudIdentity] ambiguous auto-pair (multiple users claim characterName) — trying accountName match',
      );
    }

    // ── Priority 2b: auto-pair by accountName matching username / discordUsername ──
    // Handles the case where fo76CharacterName was never set on a Discord-linked
    // account but the Bethesda account name matches the Discord username.
    if (nameMatches.length !== 1) {
      const accountNameMatches = await prisma.user.findMany({
        where: {
          identityHash: null,
          OR: [
            { username: { equals: accountName, mode: 'insensitive' } },
            { discordUsername: { equals: accountName, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });

      if (accountNameMatches.length === 1) {
        const target = accountNameMatches[0];
        await prisma.user.update({
          where: { id: target.id },
          data: { identityHash, fo76AccountName: accountName, fo76CharacterName: characterName },
        });
        logger.info(
          { userId: target.id, accountName, characterName },
          '[hudIdentity] auto-paired existing user by accountName (username/discordUsername match)',
        );
        return { userId: target.id, identityHash };
      }

      if (accountNameMatches.length > 1) {
        logger.warn(
          { accountName, count: accountNameMatches.length },
          '[hudIdentity] ambiguous auto-pair (multiple users match accountName) — provisioning new',
        );
      }
    }

    // ── Priority 3: auto-provision new lightweight user ───────────────────
    // username must be unique; use identityHash prefix as fallback if taken.
    const baseUsername = characterName.slice(0, 48).replace(/[^a-zA-Z0-9_\- ]/g, '');
    const candidateUsername = baseUsername.length >= 2 ? baseUsername : `hud-${identityHash.slice(0, 8)}`;

    // Ensure uniqueness without a UNIQUE-conflict race: append suffix if taken.
    let username = candidateUsername;
    const collision = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (collision) {
      username = `${candidateUsername.slice(0, 40)}-${identityHash.slice(0, 6)}`;
    }

    const newUser = await prisma.user.create({
      data: {
        id: uuidv4(),
        username,
        installToken: `hud-${uuidv4()}`,
        identityHash,
        fo76AccountName: accountName,
        fo76CharacterName: characterName,
      },
      select: { id: true },
    });

    logger.info(
      { userId: newUser.id, characterName, username },
      '[hudIdentity] auto-provisioned new HUD user',
    );
    return { userId: newUser.id, identityHash };
  } catch (err) {
    logger.error({ err, accountName: accountName.slice(0, 16) }, '[hudIdentity] resolveHudIdentity failed');
    return null;
  }
}

// ── Block operations ──────────────────────────────────────────────────────────

export interface HudIdentityBlockRecord {
  id: string;
  identityHash: string;
  type: 'mute' | 'ban';
  reason: string | null;
  createdBy: string | null;
  expiresAt: Date | null;
}

/**
 * Fetch the highest-severity active block for a given identityHash.
 * 'ban' > 'mute'. Returns null when no active block exists.
 */
export async function getActiveBlock(identityHash: string): Promise<HudIdentityBlockRecord | null> {
  const now = new Date();
  const blocks = await prisma.hudIdentityBlock.findMany({
    where: {
      identityHash,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
  });

  // Prefer 'ban' over 'mute'.
  const ban = blocks.find((b) => b.type === 'ban');
  if (ban) return ban as HudIdentityBlockRecord;
  const mute = blocks.find((b) => b.type === 'mute');
  return (mute ?? null) as HudIdentityBlockRecord | null;
}

/**
 * Create a mute or ban block for an identityHash.
 */
export async function blockHash(opts: {
  identityHash: string;
  type: 'mute' | 'ban';
  reason?: string;
  createdBy?: string;
  expiresAt?: Date | null;
}): Promise<void> {
  await prisma.hudIdentityBlock.create({
    data: {
      id: uuidv4(),
      identityHash: opts.identityHash,
      type: opts.type,
      reason: opts.reason ?? null,
      createdBy: opts.createdBy ?? null,
      expiresAt: opts.expiresAt ?? null,
    },
  });
}

/**
 * Remove all active blocks of the given type for an identityHash.
 * Pass type=undefined to remove all blocks regardless of type.
 */
export async function unblockHash(opts: {
  identityHash: string;
  type?: 'mute' | 'ban';
}): Promise<number> {
  const result = await prisma.hudIdentityBlock.deleteMany({
    where: {
      identityHash: opts.identityHash,
      ...(opts.type ? { type: opts.type } : {}),
    },
  });
  return result.count;
}
