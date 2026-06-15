import express from 'express';
import {
  getHealth,
  setWsClientCount,
  setDiscordStatus,
  incrementMessageCount,
  setFullscreenStatus,
  removeFullscreenClient,
} from '../controllers/healthController';

const router = express.Router();

router.get('/', getHealth);

// Attach setter functions to the router so server.ts can access them
(router as any).setWsClientCount = setWsClientCount;
(router as any).setDiscordStatus = setDiscordStatus;
(router as any).incrementMessageCount = incrementMessageCount;
(router as any).setFullscreenStatus = setFullscreenStatus;
(router as any).removeFullscreenClient = removeFullscreenClient;

export default router;
module.exports = router;
module.exports.setWsClientCount = setWsClientCount;
module.exports.setDiscordStatus = setDiscordStatus;
module.exports.incrementMessageCount = incrementMessageCount;
module.exports.setFullscreenStatus = setFullscreenStatus;
module.exports.removeFullscreenClient = removeFullscreenClient;
