import express from 'express';
import { publishRelease, getReleases, deleteRelease } from '../controllers/releasesController';

const router = express.Router();

router.post('/', publishRelease);
router.get('/', getReleases);
router.delete('/:version', deleteRelease);

export default router;
module.exports = router;
