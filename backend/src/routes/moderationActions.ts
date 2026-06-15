import express from 'express';
import multer from 'multer';
import { requireDiscordRole } from '../middleware/auth';
import env from '../config/environment';
import {
  kickUserHandler, muteUserHandler, unmuteUserHandler,
  createBanHandler, listBansHandler, getBanHandler, reverseBanHandler,
  streamBanEvidenceHandler, listEvidenceHandler, lookupUserHandler,
} from '../controllers/moderationActionsController';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB each, max 5 files per ban
});
const router = express.Router();

const mod = requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID);

// User lookup for the ban-form prefill / search bar
router.get('/users/lookup', mod, lookupUserHandler);

// Kick / Mute / Unmute
router.post('/kicks', mod, kickUserHandler);
router.post('/mutes', mod, muteUserHandler);
router.delete('/mutes/:userId', mod, unmuteUserHandler);

// Bans
router.post('/bans', mod, upload.array('evidenceFiles', 5), createBanHandler);
router.get('/bans', mod, listBansHandler);
router.get('/bans/:id', mod, getBanHandler);
router.post('/bans/:id/reverse', mod, reverseBanHandler);
router.get('/bans/:id/evidence/:fileId', mod, streamBanEvidenceHandler);

// Evidence gallery
router.get('/evidence', mod, listEvidenceHandler);

export default router;
module.exports = router;
