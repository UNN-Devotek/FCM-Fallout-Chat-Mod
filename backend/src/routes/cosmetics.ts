/**
 * Cosmetics + supporter routes.
 *
 * Thin by design — all logic lives in cosmeticsService (see cosmeticsController).
 */
import express from 'express';
import { requireDashboardAuth, requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import createError from 'http-errors';
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

/**
 * Master kill switch. With `SUPPORTER_TIER_ENABLED` false (the default, including in
 * production) every route here 404s, exactly as if the feature had never been deployed.
 *
 * 404 rather than 503: a disabled feature should be indistinguishable from an
 * unimplemented one, so nothing probes for a launch date.
 *
 * Applied PER ROUTE, not via `router.use()`. This router is mounted at `/api` (it owns
 * several unrelated sub-paths), so a router-level guard would run for every request
 * under `/api` and 404 the entire API whenever the tier was off — which is exactly what
 * it did before the integration tests caught it.
 */
function requireTierEnabled(_req: express.Request, _res: express.Response, next: express.NextFunction): void {
  if (!env.SUPPORTER_TIER_ENABLED) return next(createError(404, 'Not Found'));
  next();
}

// Public: pricing data for the marketing page. Registered before the authed routes
// so it is not captured by them.
router.get('/supporter/tiers', requireTierEnabled, getSupporterTiers);

// Catalog is behind dashboard auth (it is only useful to someone editing their own
// cosmetics) but is not user-specific.
router.get('/cosmetics/catalog', requireTierEnabled, requireDashboardAuth, getCatalog);

router.get('/supporter/status', requireTierEnabled, requireDashboardAuth, getSupporterStatusHandler);

router.get('/users/:id/cosmetics', requireTierEnabled, requireDashboardAuth, getUserCosmetics);
// Rate-limited: the PATCH runs names through the blacklist + automod, so without a
// limit it becomes an oracle for probing what the filters block (#232).
router.patch('/users/:id/cosmetics', requireTierEnabled, requireDashboardAuth, cosmeticsWriteLimiter, patchUserCosmetics);

// Moderator action: wipe an abusive display name back to defaults.
router.post(
  '/admin/users/:id/cosmetics/reset',
  requireTierEnabled,
  requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID),
  adminResetCosmetics,
);

export default router;
module.exports = router;
