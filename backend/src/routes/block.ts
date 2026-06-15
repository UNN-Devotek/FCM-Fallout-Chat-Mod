import express from 'express';
import {
  getBlockList,
  blockUser,
  unblockUser,
  searchUsersToBlock,
} from '../controllers/blockController';

const router = express.Router();

// Route order: /search must come before /:userId to avoid "search" being
// treated as a userId param.
router.get('/search', searchUsersToBlock);
router.get('/', getBlockList);
router.post('/', blockUser);
router.delete('/:userId', unblockUser);

export default router;
module.exports = router;
