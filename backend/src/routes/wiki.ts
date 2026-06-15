import express from 'express';
import { searchWiki, getWikiEntry } from '../controllers/wikiController';
import { getWikiImage } from '../controllers/wikiImageController';
import { wikiSearchLimiter } from '../middleware/rateLimiter';

const router = express.Router();

// Public, unauthenticated — mounted BEFORE requireClientAuth in server.ts.
// search/entry never call Fandom (served from the local catalog); the image
// proxy streams bytes from MinIO or the whitelisted Fandom CDN through our origin.
router.get('/search', wikiSearchLimiter, searchWiki);
router.get('/entry/:title', getWikiEntry);
router.get('/img/:id', getWikiImage);

export default router;
module.exports = router;
