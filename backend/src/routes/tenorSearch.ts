import express from 'express';
import { tenorSearch } from '../controllers/tenorSearchController';

const router = express.Router();

router.get('/', tenorSearch);

export default router;
module.exports = router;
