import { Router } from 'express';
import { requireDiscordRole, requireDashboardAuth } from '../middleware/auth';
import { applicationsLimiter } from '../middleware/rateLimiter';
import { listApplications, createApplication, updateApplication, listMineApplications, getMineApplication } from '../controllers/applicationsController';

const router = Router();
router.get('/', requireDiscordRole('owner', 'admin', 'moderator'), listApplications);
// Own-scoped (dweller self-service). '/mine' precedes any '/:id' so it isn't
// shadowed (the staff PATCH '/:id' is the only param route here, but keep order safe).
router.get('/mine', requireDashboardAuth, listMineApplications);
router.get('/mine/:id', requireDashboardAuth, getMineApplication);
// Public submission, gated by a strict per-IP rate limiter (3/hour) so the
// staff_applications queue can't be flooded by a single attacker.
router.post('/', applicationsLimiter, createApplication);
router.patch('/:id', requireDiscordRole('owner', 'admin'), updateApplication);
export default router;
