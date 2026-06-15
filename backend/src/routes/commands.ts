import express from 'express';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import { listCommands, createCommand, updateCommand, deleteCommand } from '../controllers/commandsController';

const router = express.Router();
const adminRoles = [env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID];

router.get('/',       listCommands); // public — command list is not sensitive
router.post('/',      requireDiscordRole(...adminRoles), createCommand);
router.patch('/:id',  requireDiscordRole(...adminRoles), updateCommand);
router.delete('/:id', requireDiscordRole(...adminRoles), deleteCommand);

export default router;
module.exports = router;
