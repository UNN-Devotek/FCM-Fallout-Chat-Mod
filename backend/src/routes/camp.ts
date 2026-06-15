import express from 'express';
import { searchCamp, getCampItemByName } from '../controllers/campController';
import { getCampImage } from '../controllers/campImageController';
import { campSearchLimiter } from '../middleware/rateLimiter';

const router = express.Router();

// Public, unauthenticated — mounted BEFORE requireClientAuth in server.ts.
// Mirrors the /api/wiki/* mount pattern.
router.get('/search',      campSearchLimiter, searchCamp);
router.get('/item/:name',  campSearchLimiter, getCampItemByName);
router.get('/img/:id',     getCampImage);

export default router;
module.exports = router;
