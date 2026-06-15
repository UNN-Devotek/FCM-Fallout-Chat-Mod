import express from 'express';
import { getVersion } from '../controllers/versionController';

const router = express.Router();

router.get('/', getVersion);

export default router;
module.exports = router;
