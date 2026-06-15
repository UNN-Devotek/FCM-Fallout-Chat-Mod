import express from 'express';
import { requireAuth, requireDiscordRole } from '../middleware/auth';
import { validate, schemas } from '../middleware/validation';
import { authLimiter, registerLimiter, registerIpFloodLimiter } from '../middleware/rateLimiter';
import env from '../config/environment';
import {
  listUsers,
  register,
  deleteSession,
  getUser,
  getUserProfile,
  getUserMessages,
  muteUser,
  unmuteUser,
  kickUser,
  banUser,
  unbanUser,
  wipeUser,
  deleteUser,
  mentionSearch,
  getUserAliases,
} from '../controllers/usersController';

const router = express.Router();

router.get('/mention-search', mentionSearch); // public — rate limited by global apiLimiter
router.get('/', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listUsers);
router.post('/', registerIpFloodLimiter, registerLimiter, authLimiter, validate(schemas.registerUser), register);
router.delete('/session', requireAuth, deleteSession);
// Public profile — unauthenticated, returns only public-safe fields (no ban_reason,
// steam_id, install_token). Must be declared before /:id so Express matches the
// literal "profile" segment rather than treating it as a UUID.
router.get('/:id/profile', getUserProfile);
router.get('/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getUser);
router.get('/:id/aliases', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getUserAliases);
router.get('/:id/messages', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getUserMessages);
router.post('/:id/mute', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), validate(schemas.muteUser), muteUser);
router.delete('/:id/mute', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), unmuteUser);
router.post('/:id/kick', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), kickUser);
router.post('/:id/ban', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), validate(schemas.banUser), banUser);
router.delete('/:id/ban', requireDiscordRole(env.OWNER_ROLE_ID), unbanUser);
router.post('/:id/wipe', requireDiscordRole(env.OWNER_ROLE_ID), wipeUser);
router.delete('/:id', requireDiscordRole(env.OWNER_ROLE_ID), deleteUser);

export default router;
module.exports = router;
