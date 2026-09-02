import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import prisma from '../config/prisma';
import { query as dbQuery } from '../config/database';
import { createError } from '../middleware/errorHandler';
import { resetCache, invalidateSettingsCache } from '../services/autoModService';
import { invalidateAiModerationCache } from '../services/aiModerationService';
import { invalidateVoiceCache } from '../services/voiceService';
import { postEmbed, listTextChannels, listAssignableRoles, invalidateModLogCache, type EmbedData } from '../services/discordService';
import reactionRoleService, { type ReactionRoleInput } from '../services/reactionRoleService';
import { resolveInternalActorId } from '../utils/resolveActorId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(id: string): boolean { return UUID_RE.test(id); }
function validatePosInt(id: string): boolean { return /^\d+$/.test(id) && parseInt(id, 10) > 0; }

/**
 * GET /api/moderation/word-filter
 */
async function listWordFilters(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filters = await prisma.wordFilter.findMany({
      select: { id: true, phrase: true, isRegex: true, testMode: true, createdAt: true },
      orderBy: { phrase: 'asc' },
    });
    res.json({ data: filters });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/moderation/word-filter
 */
async function addWordFilter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { phrase, isRegex, testMode } = req.body;
  try {
    const result = await dbQuery(
      'INSERT INTO word_filter (phrase, is_regex, test_mode) VALUES ($1, $2, $3) ON CONFLICT (phrase) DO NOTHING RETURNING *',
      [phrase.toLowerCase(), isRegex, testMode || false]
    );
    resetCache();
    res.status(201).json({ data: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/moderation/word-filter/:id
 */
async function deleteWordFilter(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validatePosInt(paramStr(req, 'id'))) return next(createError(400, 'Invalid word filter ID'));
  try {
    const id = parseInt(paramStr(req, 'id'), 10);
    const existing = await prisma.wordFilter.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Filter entry not found'));
    await prisma.wordFilter.delete({ where: { id } });
    resetCache();
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/moderation/discord-relay-mappings
 */
async function listDiscordRelayMappings(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await dbQuery(
      `SELECT drm.id, c.name AS channel_name, drm.in_game_channel_id, drm.discord_channel_id, drm.created_at
       FROM discord_relay_mappings drm
       JOIN channels c ON c.id = drm.in_game_channel_id
       ORDER BY c.name`,
      []
    );
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/moderation/discord-relay-mappings
 */
async function createDiscordRelayMapping(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { inGameChannelId, discordChannelId } = req.body;
  if (!inGameChannelId || !discordChannelId) {
    return next(createError(400, 'inGameChannelId and discordChannelId are required'));
  }
  if (!validateUuid(inGameChannelId)) return next(createError(400, 'inGameChannelId must be a UUID'));
  if (typeof discordChannelId !== 'string' || !/^\d{17,20}$/.test(discordChannelId)) {
    return next(createError(400, 'discordChannelId must be a valid Discord snowflake ID'));
  }
  try {
    const count = await prisma.discordRelayMapping.count();
    if (count >= 20) {
      return next(createError(400, 'Maximum 20 relay pairs allowed per deployment'));
    }

    const result = await dbQuery(
      `INSERT INTO discord_relay_mappings (in_game_channel_id, discord_channel_id)
       VALUES ($1, $2) ON CONFLICT (in_game_channel_id, discord_channel_id) DO NOTHING RETURNING *`,
      [inGameChannelId, discordChannelId]
    );
    res.status(201).json({ data: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/moderation/discord-relay-mappings/:id
 */
async function deleteDiscordRelayMapping(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validatePosInt(paramStr(req, 'id'))) return next(createError(400, 'Invalid relay mapping ID'));
  try {
    const id = parseInt(paramStr(req, 'id'), 10);
    const existing = await prisma.discordRelayMapping.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Mapping not found'));
    await prisma.discordRelayMapping.delete({ where: { id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

// Voice ("join-to-create") settings live in the moderation_settings k/v store.
const VOICE_KEYS = {
  enabled: 'voice.enabled',
  lobby: 'voice.lobby_channel_id',
  category: 'voice.category_id',
  template: 'voice.name_template',
} as const;
const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * GET /api/moderation/voice-settings
 * Returns { enabled, lobbyChannelId, categoryId, nameTemplate }.
 */
async function getVoiceSettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.moderationSetting.findMany({
      where: { key: { in: Object.values(VOICE_KEYS) } },
      select: { key: true, value: true },
    });
    const m = new Map(rows.map((r) => [r.key, r.value]));
    res.json({
      data: {
        enabled: m.get(VOICE_KEYS.enabled) === 'true',
        lobbyChannelId: m.get(VOICE_KEYS.lobby) || '',
        categoryId: m.get(VOICE_KEYS.category) || '',
        nameTemplate: m.get(VOICE_KEYS.template) || "{user}'s Channel",
      },
    });
  } catch (err) { next(err); }
}

/**
 * PUT /api/moderation/voice-settings
 * Body: { enabled, lobbyChannelId, categoryId, nameTemplate }. Upserts each key.
 */
async function updateVoiceSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { enabled, lobbyChannelId, categoryId, nameTemplate } = req.body ?? {};

  if (typeof enabled !== 'boolean') return next(createError(400, 'enabled must be a boolean'));
  const lobby = (lobbyChannelId ?? '').trim();
  const category = (categoryId ?? '').trim();
  const template = (nameTemplate ?? '').trim();

  if (enabled && !SNOWFLAKE_RE.test(lobby)) {
    return next(createError(422, 'lobbyChannelId must be a valid Discord snowflake when enabled'));
  }
  if (lobby && !SNOWFLAKE_RE.test(lobby)) return next(createError(422, 'lobbyChannelId must be a valid Discord snowflake'));
  if (category && !SNOWFLAKE_RE.test(category)) return next(createError(422, 'categoryId must be a valid Discord snowflake'));
  if (template.length > 100) return next(createError(422, 'nameTemplate must be 100 characters or fewer'));

  const entries: Array<[string, string]> = [
    [VOICE_KEYS.enabled, enabled ? 'true' : 'false'],
    [VOICE_KEYS.lobby, lobby],
    [VOICE_KEYS.category, category],
    [VOICE_KEYS.template, template || "{user}'s Channel"],
  ];

  try {
    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.moderationSetting.upsert({ where: { key }, update: { value }, create: { key, value } }),
      ),
    );
    invalidateVoiceCache();
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'update_voice_settings',
        targetType: 'moderation_setting',
        reason: `Voice ${enabled ? 'enabled' : 'disabled'} (lobby=${lobby || 'none'})`,
        metadata: { enabled, lobbyChannelId: lobby, categoryId: category, nameTemplate: template },
      },
    }).catch(() => {});
    res.json({ data: { enabled, lobbyChannelId: lobby, categoryId: category, nameTemplate: template || "{user}'s Channel" } });
  } catch (err) { next(err); }
}

/**
 * GET /api/moderation/settings
 */
async function getSettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await prisma.moderationSetting.findMany({
      select: { key: true, value: true, updatedAt: true },
    });
    res.json({ data: settings });
  } catch (err) { next(err); }
}

const SNOWFLAKE_RE_SETTINGS = /^\d{17,20}$/;

/** moderation_settings keys owned by the AI moderation integration. */
const AI_SETTING_KEYS = new Set([
  'ai_moderation_enabled',
  'ai_moderation_mode',
  'ai_moderation_thresholds',
  'ai_moderation_identifier_thresholds',
]);

/**
 * Validate a thresholds payload: a flat JSON object of OpenAI category name →
 * score in (0, 1]. Returns an error message, or null when the value is valid.
 * An empty object is legal and means "no category is enforceable".
 */
function validateThresholdsJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'Thresholds must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Thresholds must be a JSON object of category -> score';
  }
  for (const [category, score] of Object.entries(parsed as Record<string, unknown>)) {
    const n = typeof score === 'number' ? score : Number(score);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      return `Threshold for "${category}" must be a number greater than 0 and at most 1`;
    }
  }
  return null;
}

async function resolveActorId(req: Request): Promise<string | null> {
  return resolveInternalActorId(req.adminUser?.id);
}

/**
 * PATCH /api/moderation/settings
 * Supports numeric keys (spam_message_limit, spam_window_ms) and
 * the mod_log_channel_id key (Discord snowflake string).
 */
async function updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { key, value } = req.body;
  if (!key || value === undefined || value === null) return next(createError(400, 'key and value required'));

  // mod_log_channel_id: snowflake string — different validation path
  if (key === 'mod_log_channel_id') {
    const strVal = String(value).trim();
    if (!SNOWFLAKE_RE_SETTINGS.test(strVal)) {
      return next(createError(422, 'mod_log_channel_id must be a valid Discord snowflake (17-20 digits)'));
    }
    try {
      await prisma.moderationSetting.upsert({
        where: { key },
        update: { value: strVal },
        create: { key, value: strVal },
      });
      invalidateModLogCache();
      await prisma.auditLog.create({
        data: {
          actorId: await resolveActorId(req),
          action: 'update_setting',
          targetType: 'moderation_setting',
          reason: `Updated ${key} to ${strVal}`,
          metadata: { key, value: strVal },
        },
      });
      res.json({ data: { key, value: strVal } });
    } catch (err) { next(err); }
    return;
  }

  // AI moderation keys: booleans, an enum, and threshold JSON — none of which
  // survive the positive-integer path below.
  if (AI_SETTING_KEYS.has(key)) {
    const strVal = String(value).trim();

    if (key === 'ai_moderation_enabled' && strVal !== 'true' && strVal !== 'false') {
      return next(createError(422, "ai_moderation_enabled must be 'true' or 'false'"));
    }
    if (key === 'ai_moderation_mode' && strVal !== 'shadow' && strVal !== 'enforce') {
      return next(createError(422, "ai_moderation_mode must be 'shadow' or 'enforce'"));
    }
    if (key.endsWith('_thresholds')) {
      const invalid = validateThresholdsJson(strVal);
      if (invalid) return next(createError(422, invalid));
    }

    try {
      await prisma.moderationSetting.upsert({
        where: { key },
        update: { value: strVal },
        create: { key, value: strVal },
      });
      invalidateAiModerationCache();
      await prisma.auditLog.create({
        data: {
          actorId: await resolveActorId(req),
          action: 'update_setting',
          targetType: 'moderation_setting',
          reason: `Updated ${key} to ${strVal.slice(0, 200)}`,
          metadata: { key, value: strVal.slice(0, 1000) },
        },
      }).catch(() => {});
      res.json({ data: { key, value: strVal } });
    } catch (err) { next(err); }
    return;
  }

  // All other keys: must be positive integers
  const numVal = parseInt(value, 10);
  if (isNaN(numVal) || numVal <= 0) return next(createError(422, 'Value must be a positive integer'));
  if (key === 'spam_window_ms' && (numVal < 1000 || numVal > 300000))
    return next(createError(422, 'Window must be 1-300 seconds (1000-300000ms)'));

  try {
    await prisma.moderationSetting.update({
      where: { key },
      data: { value: String(numVal) },
    });
    invalidateSettingsCache();
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'update_setting',
        targetType: 'moderation_setting',
        reason: `Updated ${key} to ${numVal}`,
        metadata: { key, value: numVal },
      },
    });
    res.json({ data: { key, value: String(numVal) } });
  } catch (err) { next(err); }
}

/**
 * PATCH /api/moderation/word-filters/:id
 */
async function updateWordFilter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { phrase, testMode } = req.body;
  const id = parseInt(paramStr(req, 'id'), 10);
  if (isNaN(id)) return next(createError(400, 'Invalid filter ID'));

  // At least one field must be provided
  if ((phrase === undefined || phrase === null) && testMode === undefined) {
    return next(createError(422, 'No fields to update'));
  }

  try {
    const existing = await prisma.wordFilter.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Filter not found'));

    const data: any = {};
    const changes: any = {};

    if (phrase !== undefined && phrase !== null && phrase.trim()) {
      const dup = await prisma.wordFilter.findFirst({
        where: { phrase: phrase.trim(), id: { not: id } },
      });
      if (dup) return next(createError(422, 'Duplicate phrase'));
      data.phrase = phrase.trim();
      changes.oldPhrase = existing.phrase;
      changes.newPhrase = phrase.trim();
    }

    if (testMode !== undefined) {
      data.testMode = !!testMode;
      changes.testMode = !!testMode;
    }

    await prisma.wordFilter.update({ where: { id }, data });
    resetCache();

    const reason = changes.newPhrase
      ? `Changed "${changes.oldPhrase}" to "${changes.newPhrase}"`
      : `Updated filter id=${id}`;
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'edit_word_filter',
        targetType: 'word_filter',
        reason,
        metadata: { id, ...changes },
      },
    });

    const updated = await prisma.wordFilter.findUnique({
      where: { id },
      select: { id: true, phrase: true, isRegex: true, testMode: true },
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
}

/**
 * POST /api/moderation/word-filters/bulk
 */
async function bulkImportWordFilters(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(req as any).file) return next(createError(400, 'No file uploaded'));

  try {
    const content = (req as any).file.buffer.toString('utf-8');
    const phrases = content.split(/[\n,]/).map((p: string) => p.trim()).filter(Boolean);
    if (phrases.length === 0) return next(createError(422, 'File contains no valid phrases'));

    const existing = await prisma.wordFilter.findMany({ select: { phrase: true } });
    const existingSet = new Set(existing.map((r) => r.phrase.toLowerCase()));
    const newPhrases = [...new Set<string>(phrases)].filter((p) => !existingSet.has(p.toLowerCase()));

    if (newPhrases.length === 0) return next(createError(422, 'All phrases already exist'));

    const values = newPhrases.map((_, i) => `($${i + 1})`).join(', ');
    await dbQuery(`INSERT INTO word_filter (phrase) VALUES ${values}`, newPhrases);
    resetCache();

    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'bulk_import_word_filter',
        targetType: 'word_filter',
        reason: `Imported ${newPhrases.length} phrases`,
        metadata: { count: newPhrases.length },
      },
    });

    res.json({ data: { imported: newPhrases.length, skipped: phrases.length - newPhrases.length } });
  } catch (err) { next(err); }
}

// =============================================================================
// Discord embed builder
// =============================================================================
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

/** Validate + normalize a posted embed payload. Returns an error string or null. */
function validateEmbed(data: any): string | null {
  if (!data || typeof data !== 'object') return 'embed payload is required';
  const hasBody = data.title || data.description || (Array.isArray(data.fields) && data.fields.length > 0) || data.imageUrl;
  if (!hasBody) return 'embed must have at least a title, description, image, or one field';
  if (data.title && String(data.title).length > 256) return 'title must be 256 characters or fewer';
  if (data.description && String(data.description).length > 4096) return 'description must be 4096 characters or fewer';
  if (data.footerText && String(data.footerText).length > 2048) return 'footer must be 2048 characters or fewer';
  if (data.authorName && String(data.authorName).length > 256) return 'author name must be 256 characters or fewer';
  if (data.color && !HEX_RE.test(String(data.color))) return 'color must be a 6-digit hex value (e.g. #18FF62)';
  if (data.fields !== undefined) {
    if (!Array.isArray(data.fields)) return 'fields must be an array';
    if (data.fields.length > 25) return 'an embed may have at most 25 fields';
    for (const f of data.fields) {
      if (!f || !f.name || !f.value) return 'each field needs a name and value';
      if (String(f.name).length > 256) return 'field name must be 256 characters or fewer';
      if (String(f.value).length > 1024) return 'field value must be 1024 characters or fewer';
    }
  }
  return null;
}

/** GET /api/moderation/discord-embeds — list saved templates */
async function listDiscordEmbeds(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.discordEmbed.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json({ data: rows });
  } catch (err) { next(err); }
}

/** POST /api/moderation/discord-embeds — save a template { name, data } */
async function createDiscordEmbed(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { name, data } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return next(createError(400, 'name is required'));
  const err = validateEmbed(data);
  if (err) return next(createError(422, err));
  try {
    const row = await prisma.discordEmbed.create({ data: { name: name.trim().slice(0, 100), data } });
    res.status(201).json({ data: row });
  } catch (e) { next(e); }
}

/** PUT /api/moderation/discord-embeds/:id — update a template */
async function updateDiscordEmbed(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validatePosInt(paramStr(req, 'id'))) return next(createError(400, 'Invalid embed ID'));
  const { name, data } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return next(createError(400, 'name is required'));
  const err = validateEmbed(data);
  if (err) return next(createError(422, err));
  try {
    const id = parseInt(paramStr(req, 'id'), 10);
    const existing = await prisma.discordEmbed.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Embed not found'));
    const row = await prisma.discordEmbed.update({ where: { id }, data: { name: name.trim().slice(0, 100), data } });
    res.json({ data: row });
  } catch (e) { next(e); }
}

/** DELETE /api/moderation/discord-embeds/:id */
async function deleteDiscordEmbed(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validatePosInt(paramStr(req, 'id'))) return next(createError(400, 'Invalid embed ID'));
  try {
    const id = parseInt(paramStr(req, 'id'), 10);
    const existing = await prisma.discordEmbed.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Embed not found'));
    await prisma.discordEmbed.delete({ where: { id } });
    res.json({ data: { deleted: true } });
  } catch (e) { next(e); }
}

/**
 * POST /api/moderation/discord-embeds/send — post an embed to a channel.
 * Body: { channelId, embed, reactionRoles? }. The embed is sent as-is (not required
 * to be saved). When reactionRoles is a non-empty [{emoji, roleId}] list, the bot
 * adds those reactions and registers a reaction-role panel on the posted message.
 */
async function sendDiscordEmbed(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { channelId, embed, reactionRoles } = req.body ?? {};
  if (typeof channelId !== 'string' || !/^\d{17,20}$/.test(channelId)) {
    return next(createError(400, 'channelId must be a valid Discord snowflake ID'));
  }
  const err = validateEmbed(embed);
  if (err) return next(createError(422, err));

  let rrInput: ReactionRoleInput[] = [];
  if (reactionRoles !== undefined) {
    if (!Array.isArray(reactionRoles)) return next(createError(422, 'reactionRoles must be an array'));
    for (const m of reactionRoles) {
      if (!m) return next(createError(422, 'each reaction role must be an object'));
      // A row is valid when it has EITHER a non-empty unicode emoji string OR a
      // valid custom-emoji snowflake (customEmojiId).
      const hasUnicode = typeof m.emoji === 'string' && m.emoji.trim().length > 0;
      const hasCustom = typeof m.customEmojiId === 'string' && /^\d{17,20}$/.test(m.customEmojiId);
      if (!hasUnicode && !hasCustom) {
        return next(createError(422, 'each reaction role needs either a unicode emoji or a valid customEmojiId snowflake'));
      }
      if (typeof m.roleId !== 'string' || !/^\d{17,20}$/.test(m.roleId)) return next(createError(422, 'each reaction role needs a valid role ID'));
    }
    if (reactionRoles.length > 20) return next(createError(422, 'at most 20 reaction roles per message'));
    rrInput = reactionRoles;
  }

  try {
    const message = await postEmbed(channelId, embed as EmbedData);
    if (rrInput.length > 0 && message.guildId) {
      const mappings = reactionRoleService.buildMappings(message.client, message.guildId, rrInput);
      await reactionRoleService.createPanel(message, mappings);
    }
    await prisma.auditLog.create({
      data: {
        actorId: await resolveActorId(req),
        action: 'send_discord_embed',
        targetType: 'discord_channel',
        reason: `Sent embed to channel ${channelId}${rrInput.length ? ` (+${rrInput.length} reaction roles)` : ''}`,
        metadata: { channelId, title: embed?.title ?? null, reactionRoles: rrInput.length },
      },
    }).catch(() => {});
    res.json({ data: { sent: true, messageId: message.id, reactionRoles: rrInput.length } });
  } catch (e: any) {
    // Surface the real Discord failure to the admin instead of a generic 5xx
    // (production strips 5xx `detail` to "An unexpected error occurred", which
    // hides actionable causes like a missing channel permission). Map known
    // Discord/bot failures to 4xx with a helpful message that passes through.
    const raw = String(e?.message || 'Failed to send embed to Discord');
    const lower = raw.toLowerCase();
    if (lower.includes('missing permissions') || lower.includes('missing access')) {
      return next(createError(422,
        `Discord rejected the post: "${raw}". The bot needs View Channel + Send Messages + Embed Links on that specific channel. ` +
        `Check the channel's permission overwrites — a category or channel-level deny can override a server-wide allow, ` +
        `and the bot's role must sit above any role that denies it there.`));
    }
    if (lower.includes('not connected')) {
      return next(createError(422, 'The Discord bot is not connected right now — try again in a moment or check the bot token.'));
    }
    if (lower.includes('not a text channel') || lower.includes('unknown channel')) {
      return next(createError(422, `Discord rejected the target channel: "${raw}". Pick a standard text channel the bot can see.`));
    }
    if (lower.includes('invalid url') || lower.includes('valid url')) {
      return next(createError(422, `One of the embed's URL fields is invalid (include the full https:// scheme): "${raw}".`));
    }
    return next(createError(502, raw));
  }
}

/** GET /api/moderation/discord-channels — list the bot's text channels for the picker */
async function listDiscordChannels(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const channels = await listTextChannels();
    res.json({ data: channels });
  } catch (err) { next(err); }
}

/** GET /api/moderation/discord-roles — list roles the bot can assign (for reaction roles) */
async function listDiscordRoles(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const roles = await listAssignableRoles();
    res.json({ data: roles });
  } catch (err) { next(err); }
}

/** GET /api/moderation/reaction-role-panels — list configured reaction-role panels */
async function listReactionRolePanels(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const panels = await reactionRoleService.listPanels();
    res.json({ data: panels });
  } catch (err) { next(err); }
}

/** DELETE /api/moderation/reaction-role-panels/:messageId — stop a panel granting roles */
async function deleteReactionRolePanel(req: Request, res: Response, next: NextFunction): Promise<void> {
  const messageId = paramStr(req, 'messageId');
  if (!/^\d{17,20}$/.test(messageId)) return next(createError(400, 'Invalid message ID'));
  try {
    const ok = await reactionRoleService.deletePanel(messageId);
    if (!ok) return next(createError(404, 'Panel not found'));
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
}

export {
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
};
module.exports = {
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
};
