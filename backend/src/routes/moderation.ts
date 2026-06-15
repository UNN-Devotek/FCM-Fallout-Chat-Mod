import express from 'express';
import multer from 'multer';
import { requireDiscordRole } from '../middleware/auth';
import { validate, schemas } from '../middleware/validation';
import env from '../config/environment';
import {
  listWordFilters,
  addWordFilter,
  deleteWordFilter,
  listDiscordRelayMappings,
  createDiscordRelayMapping,
  deleteDiscordRelayMapping,
  getSettings,
  updateSettings,
  updateWordFilter,
  bulkImportWordFilters,
  getVoiceSettings,
  updateVoiceSettings,
  listDiscordEmbeds,
  createDiscordEmbed,
  updateDiscordEmbed,
  deleteDiscordEmbed,
  sendDiscordEmbed,
  listDiscordChannels,
  listDiscordRoles,
  listReactionRolePanels,
  deleteReactionRolePanel,
} from '../controllers/moderationController';
import {
  listAutoModRules,
  createAutoModRule,
  updateAutoModRule,
  deleteAutoModRule,
  toggleAutoModRule,
  listAutoModViolations,
} from '../controllers/autoModRulesController';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const router = express.Router();

router.get('/word-filter', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), listWordFilters);
router.post('/word-filter', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), validate(schemas.addWordFilter), addWordFilter);
router.delete('/word-filter/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), deleteWordFilter);
router.get('/discord-relay-mappings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), listDiscordRelayMappings);
router.post('/discord-relay-mappings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), createDiscordRelayMapping);
router.delete('/discord-relay-mappings/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), deleteDiscordRelayMapping);
router.get('/settings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getSettings);
router.patch('/settings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), updateSettings);
router.patch('/word-filters/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), updateWordFilter);
router.post('/word-filters/bulk', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), upload.single('file'), bulkImportWordFilters);
router.get('/voice-settings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), getVoiceSettings);
router.put('/voice-settings', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), updateVoiceSettings);
router.get('/discord-channels', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listDiscordChannels);
router.get('/discord-embeds', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listDiscordEmbeds);
router.post('/discord-embeds', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), createDiscordEmbed);
router.post('/discord-embeds/send', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), sendDiscordEmbed);
router.put('/discord-embeds/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), updateDiscordEmbed);
router.delete('/discord-embeds/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), deleteDiscordEmbed);
router.get('/discord-roles', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listDiscordRoles);
router.get('/reaction-role-panels', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listReactionRolePanels);
router.delete('/reaction-role-panels/:messageId', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), deleteReactionRolePanel);

// ── AutoMod Rules ─────────────────────────────────────────────────────────────
router.get('/automod-rules', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listAutoModRules);
router.post('/automod-rules', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), createAutoModRule);
router.put('/automod-rules/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), updateAutoModRule);
router.delete('/automod-rules/:id', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID), deleteAutoModRule);
router.patch('/automod-rules/:id/toggle', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), toggleAutoModRule);

// ── AutoMod Violations ────────────────────────────────────────────────────────
router.get('/automod-violations', requireDiscordRole(env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID), listAutoModViolations);

export default router;
module.exports = router;
