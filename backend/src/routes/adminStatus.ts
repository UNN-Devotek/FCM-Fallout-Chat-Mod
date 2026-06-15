import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import { getAdminStatus } from '../controllers/adminStatusController';
import env from '../config/environment';

const router = express.Router();

// Requires API key or owner Discord role
router.get('/', requireDiscordRole(env.OWNER_ROLE_ID), getAdminStatus);

export default router;
