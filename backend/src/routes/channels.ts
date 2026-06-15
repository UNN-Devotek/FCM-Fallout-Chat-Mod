import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import { validate, schemas } from '../middleware/validation';
import env from '../config/environment';
import { listChannels, createChannel, updateChannel, archiveChannel, deleteChannelPermanently } from '../controllers/channelsController';

const router = express.Router();

router.get('/', listChannels);
router.post('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), validate(schemas.createChannel), createChannel);
router.patch('/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), validate(schemas.updateChannel), updateChannel);
router.delete('/:id', requireDiscordRole(env.OWNER_ROLE_ID), archiveChannel);
router.delete('/:id/permanent', requireDiscordRole(env.OWNER_ROLE_ID), deleteChannelPermanently);

export default router;
module.exports = router;
