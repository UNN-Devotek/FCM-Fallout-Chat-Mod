/**
 * Cosmetics + supporter routes.
 *
 * Thin by design — all logic lives in cosmeticsService (see cosmeticsController).
 */
import express from 'express';
import { requireDashboardAuth, requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { cosmeticsWriteLimiter } from '../middleware/rateLimiter';
import {
  getCatalog,
  getUserCosmetics,
  patchUserCosmetics,
  adminResetCosmetics,
  getSupporterStatusHandler,
  getSupporterTiers,
} from '../controllers/cosmeticsController';

const router = express.Router();

// Public: pricing data for the marketing page. Registered before the authed routes
// so it is not captured by them.
router.get('/supporter/tiers', getSupporterTiers);

// Catalog is behind dashboard auth (it is only useful to someone editing their own
// cosmetics) but is not user-specific.
router.get('/cosmetics/catalog', requireDashboardAuth, getCatalog);

router.get('/supporter/status', requireDashboardAuth, getSupporterStatusHandler);

router.get('/users/:id/cosmetics', requireDashboardAuth, getUserCosmetics);
// Rate-limited: the PATCH runs names through the blacklist + automod, so without a
// limit it becomes an oracle for probing what the filters block (#232).
router.patch('/users/:id/cosmetics', requireDashboardAuth, cosmeticsWriteLimiter, patchUserCosmetics);

// Moderator action: wipe an abusive display name back to defaults.
router.post(
  '/admin/users/:id/cosmetics/reset',
  requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID),
  adminResetCosmetics,
);

export default router;
module.exports = router;
