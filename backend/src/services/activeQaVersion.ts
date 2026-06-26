import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import env from '../config/environment';

/** Redis key holding the single currently-active QA build version. */
const ACTIVE_QA_VERSION_KEY = 'qa:active-version';

/** Returns the active QA version, or null if none is set / Redis is unreachable. */
export async function getActiveQaVersion(): Promise<string | null> {
  try {
    const redis = await getRedisClient();
    return await redis.get(ACTIVE_QA_VERSION_KEY);
  } catch (err) {
    logger.warn({ err }, '[activeQaVersion] redis get failed (non-fatal)');
    return null;
  }
}

/** Sets the active QA version (called by the admin flip endpoint). */
export async function setActiveQaVersion(version: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(ACTIVE_QA_VERSION_KEY, version);
  logger.info({ version }, '[activeQaVersion] active QA build version set');
}

/**
 * Seeds Redis from QA_ACTIVE_VERSION at boot, but only if no value is already
 * stored (so a live flip survives a redeploy). No-op when the env is empty.
 */
export async function initActiveQaVersion(): Promise<void> {
  try {
    if (!env.QA_ACTIVE_VERSION) return;
    const redis = await getRedisClient();
    const existing = await redis.get(ACTIVE_QA_VERSION_KEY);
    if (!existing) {
      await redis.set(ACTIVE_QA_VERSION_KEY, env.QA_ACTIVE_VERSION);
      logger.info({ version: env.QA_ACTIVE_VERSION }, '[activeQaVersion] seeded from env');
    }
  } catch (err) {
    logger.warn({ err }, '[activeQaVersion] init failed (non-fatal)');
  }
}

export { ACTIVE_QA_VERSION_KEY };
