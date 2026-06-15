import express from 'express';
import { getDiscordEmojis } from '../controllers/discordEmojisController';

const router = express.Router();

router.get('/', getDiscordEmojis);

export default router;
module.exports = router;
