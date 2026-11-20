import { runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
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
  return runRequiredBundle('authority', 'activeQaVersion:d2fe863c8b39', async () => {
  const redis = await getRedisClient();
  await runRequiredMutation('authority', 'a39b4356139ab30fb8d214a4', { stage: 'primary-write-unconfirmed' }, () => redis.set(ACTIVE_QA_VERSION_KEY, version), undefined, undefined, undefined);
  logger.info({ version }, '[activeQaVersion] active QA build version set');

  });
}

/**
 * Seeds Redis from QA_ACTIVE_VERSION at boot, but only if no value is already
 * stored (so a live flip survives a redeploy). No-op when the env is empty.
 */
export async function initActiveQaVersion(): Promise<void> {
  return runRequiredBundle('authority', 'activeQaVersion:27312fa21f1d', async () => {
  try {
    if (!env.QA_ACTIVE_VERSION) return;
    const redis = await getRedisClient();
    const existing = await redis.get(ACTIVE_QA_VERSION_KEY);
    if (!existing) {
      await runRequiredMutation('authority', 'a3c97c78c047e590fcbd2665', { stage: 'primary-write-unconfirmed' }, () => redis.set(ACTIVE_QA_VERSION_KEY, env.QA_ACTIVE_VERSION), undefined, undefined, undefined);
      logger.info({ version: env.QA_ACTIVE_VERSION }, '[activeQaVersion] seeded from env');
    }
  } catch (err) {
    logger.warn({ err }, '[activeQaVersion] init failed (non-fatal)');
  }

  });
}

export { ACTIVE_QA_VERSION_KEY };
