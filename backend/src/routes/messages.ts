import express from 'express';
import { requireAuth, requireDiscordRole, requireStaffRole } from '../middleware/auth';
import env from '../config/environment';
import { listMessages, createMessage, scrubMessages, deleteMessage, searchMessages, listPublicMessages } from '../controllers/messagesController';

const router = express.Router();

router.get('/public', listPublicMessages);
router.get('/search', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), searchMessages);
router.get('/', requireAuth, listMessages);
router.post('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), createMessage);
router.post('/scrub', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), scrubMessages);
// Staff delete from the dashboard (cookie) or the overlay (X-Auth-Token).
router.delete('/:id', requireStaffRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), deleteMessage);

export default router;
module.exports = router;
