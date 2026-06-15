import express from 'express';
import { requireAuth, requireDiscordRole } from '../middleware/auth';
import { validate, schemas } from '../middleware/validation';
import env from '../config/environment';
import { submitReport, listReports, getReport, resolveReport } from '../controllers/reportsController';

const router = express.Router();

// Message reports — user-submitted reports about specific chat messages.
// NOTE: player-report and bug-report submissions (/report bug|player from overlay,
// the /report form on the website) go through /api/player-reports, not here.
router.post('/', requireAuth, validate(schemas.submitReport), submitReport);
router.get('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listReports);
router.get('/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getReport);
router.patch('/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), validate(schemas.resolveReport), resolveReport);

export default router;
module.exports = router;
