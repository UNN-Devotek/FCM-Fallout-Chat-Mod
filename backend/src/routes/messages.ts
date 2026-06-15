import express from 'express';
import { requireAuth, requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { listMessages, createMessage, scrubMessages, deleteMessage, searchMessages, listPublicMessages } from '../controllers/messagesController';

const router = express.Router();

router.get('/public', listPublicMessages);
router.get('/search', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), searchMessages);
router.get('/', requireAuth, listMessages);
router.post('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), createMessage);
router.post('/scrub', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), scrubMessages);
router.delete('/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), deleteMessage);

export default router;
module.exports = router;
