/**
 * Admin routes for the name blacklist.
 * Mounted at /api/admin/name-blacklist. Gated by Discord-OAuth admin role
 * via requireDiscordRole — admin or higher can read; only admin role can
 * modify (mirrors the adminUsers route pattern but on ADMIN_ROLE_ID).
 */
import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import {
  listBlacklist,
  createBlacklistEntry,
  updateBlacklistEntry,
  deleteBlacklistEntry,
} from '../controllers/nameBlacklistController';

const router = express.Router();
const requireAdmin = requireDiscordRole(env.ADMIN_ROLE_ID);

router.get('/', requireAdmin, listBlacklist);
router.post('/', requireAdmin, createBlacklistEntry);
router.patch('/:id', requireAdmin, updateBlacklistEntry);
router.delete('/:id', requireAdmin, deleteBlacklistEntry);

export default router;
module.exports = router;
