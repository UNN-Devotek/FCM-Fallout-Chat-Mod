import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import { registerLimiter } from '../middleware/rateLimiter';
import env from '../config/environment';
import { enrollDevice, listDevices, revokeDevice } from '../controllers/devicesController';

const router = express.Router();

// Public enrolment — gated internally (signed re-enrol OR client-key TOFU).
// Reuse the registration limiter so enrol can't be used to bypass the
// register per-IP cap (3/min).
router.post('/enroll', registerLimiter, enrollDevice);

// Admin device management
router.get('/admin/list', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), listDevices);
router.delete('/admin/:installToken', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), revokeDevice);

export default router;
module.exports = router;
