import express from 'express';
import multer from 'multer';
import {
  listParties,
  createParty,
  listInvites,
  acceptInvite,
  declineInvite,
  getParty,
  getPartyMembers,
  joinParty,
  leaveParty,
  deleteParty,
  updateParty,
  inviteToParty,
  inviteSearch,
  invitePublic,
  kickMember,
  promoteMember,
  demoteMember,
} from '../controllers/partiesController';
import { uploadPartyImageHandler } from '../controllers/partyImageController';
import {
  partiesListLimiter,
  partyCreateLimiter,
  partyJoinLimiter,
  partyInviteLimiter,
  partyImageUploadLimiter,
} from '../middleware/rateLimiter';

// multer in-memory storage: validated + stored to MinIO inside the controller.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB hard cap at the multer layer
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});
import { createError } from '../middleware/errorHandler';
import { PARTIES_ENABLED } from '../config/features';

const router = express.Router();

// Feature gate: when PARTIES_ENABLED is false (default), every party endpoint
// returns a clean JSON 404 so the feature is fully inert and the frontend hides
// the Party tab. Must be registered before any route handler.
router.use((_req, _res, next) =>
  PARTIES_ENABLED ? next() : next(createError(404, 'Not found')),
);

// Party image upload — must come before /:id to avoid "upload-image" being
// treated as a party ID.
router.post(
  '/upload-image',
  partyImageUploadLimiter,
  imageUpload.single('image'),
  uploadPartyImageHandler,
);

// Route order matters: /invites must come before /:id to avoid "invites" being
// treated as a party ID.
router.get('/invites', listInvites);
router.post('/invites/:id/accept', acceptInvite);
router.post('/invites/:id/decline', declineInvite);

router.get('/', partiesListLimiter, listParties);
router.post('/', partyCreateLimiter, createParty);

router.get('/:id', getParty);
router.get('/:id/members', getPartyMembers);
router.get('/:id/invite-search', partiesListLimiter, inviteSearch);
router.patch('/:id', updateParty);

router.post('/:id/join', partyJoinLimiter, joinParty);
router.post('/:id/leave', leaveParty);
router.delete('/:id', deleteParty);

router.post('/:id/invite', partyInviteLimiter, inviteToParty);
router.post('/:id/invite-public', partyInviteLimiter, invitePublic);
router.post('/:id/kick', kickMember);
router.post('/:id/promote', promoteMember);
router.post('/:id/demote', demoteMember);

export default router;
module.exports = router;
