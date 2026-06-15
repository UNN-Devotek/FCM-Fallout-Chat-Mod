import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { listAuditLogs, exportAuditLogs } from '../controllers/auditLogController';

const router = express.Router();

router.get('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listAuditLogs);
router.get('/export', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), exportAuditLogs);

export default router;
module.exports = router;
