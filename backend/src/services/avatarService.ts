import { uploadAvatar, ensureBucket } from '../config/storage';
import logger from '../config/logger';

let bucketReady = false;

/**
 * Stable, same-origin URL the overlay/dashboard uses to render a user's avatar.
 * Served by `GET /avatars/:discordId` (streams the MinIO object), so it resolves
 * against whatever host the client loaded from (falloutchatmod.com in prod,
 * localhost in dev) and never depends on MinIO being publicly reachable.
 *
 * Returns null when we have no discordId to key on.
 */
function buildAvatarUrl(discordId: string | null | undefined): string | null {
  if (!discordId) return null;
  return `/avatars/${discordId}`;
}

/**
 * Download the user's CURRENT Discord avatar and (over)write it into MinIO at a
 * fixed key (avatars/<discordId>.png). Called fire-and-forget on EVERY Discord
 * authentication / link, so the stored copy is always refreshed — no hash diff.
 *
 * Does NOT touch the DB: the avatar hash lives in users.discord_avatar and the
 * served URL is derived purely from discordId, so there is nothing to persist
 * here. Failures are swallowed (logged) so they never break the auth flow.
 */
async function captureAvatar(discordId: string, discordAvatar: string | null): Promise<string | null> {
  // No-avatar case: the user has no custom avatar hash → nothing to store.
  // The served route falls back to a default/404. Skip the fetch entirely.
  if (!discordAvatar) return null;

  try {
    if (!bucketReady) {
      await ensureBucket();
      bucketReady = true; // only set true after success; failure leaves it false so next call retries
    }

    const cdnUrl = `https://cdn.discordapp.com/avatars/${discordId}/${discordAvatar}.png?size=128`;
    const response = await fetch(cdnUrl);
    if (!response.ok) {
      logger.warn({ discordId, status: response.status }, 'Failed to fetch Discord avatar');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // uploadAvatar uses a fixed key (avatars/<discordId>.png) so this OVERWRITES
    // any prior stored copy — fresh on every auth, exactly as required.
    await uploadAvatar(discordId, buffer, 'image/png');

    logger.info({ discordId }, 'Avatar captured to MinIO (overwritten fresh)');
    return buildAvatarUrl(discordId);
  } catch (err) {
    logger.warn({ err, discordId }, 'Avatar capture failed (non-fatal)');
    return null;
  }
}

export { captureAvatar, buildAvatarUrl };
