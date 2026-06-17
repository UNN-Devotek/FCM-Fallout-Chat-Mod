/**
 * In-memory latest release version cache.
 *
 * Initialized at server boot from the DB (initLatestVersion) and refreshed
 * after each successful POST /admin/releases (setLatestVersion).
 * getLatestVersion() is called on every WS connect to deliver the
 * app:update-available handshake message to newly connected sockets.
 */

import prisma from '../config/prisma';
import logger from '../config/logger';

let _latestVersion: string | null = null;

/** Returns the cached latest release version string, or null if none is known. */
export function getLatestVersion(): string | null {
  return _latestVersion;
}

/** Updates the in-memory cache (called after a successful release upsert). */
export function setLatestVersion(version: string): void {
  _latestVersion = version;
}

/**
 * Initializes the cache from the DB at server boot.
 * Uses the same query as versionController.ts: the most recently published release.
 * Non-fatal on DB error — the cache simply stays null and no handshake message is sent.
 */
export async function initLatestVersion(): Promise<void> {
  try {
    const latest = await prisma.release.findFirst({ orderBy: { publishedAt: 'desc' } });
    if (latest?.version) {
      _latestVersion = latest.version;
      logger.info({ version: latest.version }, '[latestReleaseVersion] cache initialized from DB');
    } else {
      logger.info('[latestReleaseVersion] no published release found — cache stays null');
    }
  } catch (err) {
    logger.warn({ err }, '[latestReleaseVersion] DB init failed (non-fatal) — cache stays null');
  }
}
