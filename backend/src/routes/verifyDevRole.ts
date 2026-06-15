/**
 * PROD-side narrow developer-role verification route.
 *
 *   GET /api/internal/verify-dev-role?discordId=<id>
 *
 * Auth: Authorization: Bearer <PROD_VERIFY_TOKEN> (constant-time, in the handler).
 * Returns: { data: { hasDevRole: boolean } } only.
 *
 * See controllers/verifyDevRoleController.ts and
 * docs/deployment/hosted-dev-environment.md § "Developer authorization".
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { clientIp } from '../utils/clientIp';
import { makeVerifyDevRoleHandler } from '../controllers/verifyDevRoleController';

/**
 * Strict rate limiter: 30 req / min per IP. The dev backend only calls this once
 * per contributor login; this cap is a generous backstop against abuse/probing.
 */
const verifyDevRoleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Verify-dev-role rate limit exceeded.',
  },
});

const router = Router();

router.use(verifyDevRoleLimiter);
router.get('/verify-dev-role', makeVerifyDevRoleHandler());

export default router;
module.exports = router;
