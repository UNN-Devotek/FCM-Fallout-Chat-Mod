import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { listAdminUsers, updateAdminUser, deleteAdminUser } from '../controllers/adminUsersController';

const router = express.Router();

router.get('/', requireDiscordRole(env.OWNER_ROLE_ID), listAdminUsers);
router.put('/:discordId', requireDiscordRole(env.OWNER_ROLE_ID), updateAdminUser);
router.delete('/:discordId', requireDiscordRole(env.OWNER_ROLE_ID), deleteAdminUser);

export default router;
module.exports = router;
