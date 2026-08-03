import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import { compileUserRegex } from '../utils/safeRegex';
import { canon } from '../utils/textCanon';

// ── Baseline hardcoded denylist ──────────────────────────────────────────────
// These terms are ALWAYS blocked regardless of whether the DB word_filter table
// is empty. This ensures zero-tolerance for hate speech, slurs, and explicit
// content even on fresh deployments before any admin-configured rules exist.
// The list uses whole-word regex matching (case-insensitive, word boundaries).
// IMPORTANT: Keep terms here; do not remove. Prod DB rules are additive on top.
//
// Categories: racial/ethnic slurs, sexist/misogynistic terms, homophobic slurs,
// explicit sexual terms that have no legitimate use in party/user names.
// Unambiguous hate terms. These have no ordinary-conversation use, so they hard-
// block in chat AND in identifiers. Ordinary profanity (fuck/shit/damn/ass) is
// deliberately NOT here — the policy is "cussing is fine, targeting people is not".
const BASELINE_CHAT_DENYLIST_PHRASES = [
  // Racial / ethnic slurs
  'nigger', 'nigga', 'chink', 'spic', 'spick', 'kike', 'wetback', 'gook',
  'towelhead', 'raghead', 'coon', 'jigaboo', 'porch monkey', 'jungle bunny',
  'beaner', 'honky', 'zipperhead', 'squaw',
  'sandnigger', 'sand nigger', 'uncle tom',
  // Sexist / misogynistic slurs
  'cunt', 'twat', 'whore', 'slut', 'skank',
  // Homophobic / transphobic slurs
  'faggot', 'fag', 'dyke', 'tranny', 'shemale',
  // Severe abuse terms that should still hard-block outside optional presets
  'pedo', 'pedophile', 'rape', 'rapist',
] as const;

// Context-ambiguous terms: a slur when aimed at someone, but an ordinary word in
// the overwhelming majority of game chat — "graham cracker" (a real Fallout food
// item), "slanted", "redskin potatoes", "heave ho", "this quest is a bitch".
// Word-boundary matching cannot tell those apart from a targeted insult, and
// hard-blocking them was the main source of the "triggers on way too light of
// context" complaint, so they no longer block CHAT.
//
// They DO still block IDENTIFIERS. A username or party name has no conversational
// context to be innocent in — picking one of these deliberately is exactly what
// the identifier check exists to catch.
//
// Targeted harassment using these words is still actionable through reports and
// normal moderation; it is just no longer auto-blocked on the word alone.
const CONTEXT_AMBIGUOUS_PHRASES = [
  'cracker', 'oreo', 'slant', 'redskin', 'ho', 'sissy', 'bitch',
] as const;

const BASELINE_IDENTIFIER_DENYLIST_PHRASES = [
  ...BASELINE_CHAT_DENYLIST_PHRASES,
  // Ambiguous-in-chat terms are NOT ambiguous in a username — keep them blocked.
  ...CONTEXT_AMBIGUOUS_PHRASES,
  // Identifiers stay stricter than normal chat.
  'cock', 'dick', 'pussy', 'asshole', 'motherfucker', 'fucker', 'fuck',
  'shit', 'bastard',
] as const;

function compileBoundaryPhraseList(phrases: readonly string[]) {
  return phrases.map((phrase) => ({
    phrase,
    compiled: new RegExp(
      `\\b${canon(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'iu',
    ),
  }));
}

const BASELINE_DENYLIST: ReadonlyArray<{ phrase: string; compiled: RegExp }> =
  compileBoundaryPhraseList(BASELINE_CHAT_DENYLIST_PHRASES);

// Substring variant — used for party names and usernames (identifiers) where slurs
// may be embedded in concatenated strings without spaces (e.g. "nigger76", "slutqueen").
// Short terms (≤ 4 chars) keep word-boundary matching even here — bare substring
// matching for "ho", "coon", "rape", "cock" etc. produces false positives on innocent
// words ("school", "raccoon", "grapes", "peacock"). Terms of 5+ chars are unambiguous
// enough that substring-embedding is the right default.
const BASELINE_DENYLIST_NAMES: ReadonlyArray<{ phrase: string; compiled: RegExp }> =
  BASELINE_IDENTIFIER_DENYLIST_PHRASES.map((phrase) => {
    // Match against the canonical (diacritic-stripped) form: identifiers are
    // canon()-reduced before testing, so the pattern must be canonical too.
    const canonPhrase = canon(phrase);
    const escaped = canonPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = canonPhrase.length <= 4 ? `\\b${escaped}\\b` : escaped;
    return { phrase, compiled: new RegExp(pattern, 'iu') };
  });

// Cache the word filter for hot-path performance; refresh every 60 seconds.
// A single in-flight promise prevents cache stampede under burst cold-start load.
// Compiled RegExp objects are stored alongside rows to avoid re-compiling on every message.
interface CompiledFilter {
  phrase: string;
  is_regex: boolean;
  test_mode: boolean;
  compiled: RegExp | null;
}

let cachedFilter: CompiledFilter[] = [];
let filterLastLoaded = 0;
let wordFilterPromise: Promise<CompiledFilter[]> | null = null;
// Generation counter: incremented by resetCache() so that any in-flight promise
// that resolves after a reset does not overwrite the (now-empty) cache with stale data.
let cacheGeneration = 0;

// Maximum regex string length accepted to guard against ReDoS via crafted admin input.
const MAX_REGEX_LENGTH = 500;

// Spam threshold settings cache -- reads from moderation_settings DB table, falls back to env vars.
interface SpamSettings {
  spamMessageLimit: number;
  spamWindowMs: number;
}

let settingsCache: SpamSettings | null = null;
let settingsCacheTimestamp = 0;
const SETTINGS_CACHE_TTL_MS = 60000;

async function getSpamSettings(): Promise<SpamSettings> {
  if (settingsCache && Date.now() - settingsCacheTimestamp < SETTINGS_CACHE_TTL_MS) return settingsCache;
  try {
    const rows = await prisma.moderationSetting.findMany({
      where: { key: { in: ['spam_message_limit', 'spam_window_ms'] } },
    });
    const settings: Record<string, string> = {};
    for (const row of rows) settings[row.key] = row.value;
    settingsCache = {
      spamMessageLimit: parseInt(settings.spam_message_limit, 10) || parseInt(process.env.SPAM_MESSAGE_LIMIT || '6', 10),
      spamWindowMs: parseInt(settings.spam_window_ms, 10) || parseInt(process.env.SPAM_WINDOW_MS || '10000', 10),
    };
    settingsCacheTimestamp = Date.now();
    return settingsCache;
  } catch {
    return {
      spamMessageLimit: parseInt(process.env.SPAM_MESSAGE_LIMIT || '6', 10),
      spamWindowMs: parseInt(process.env.SPAM_WINDOW_MS || '10000', 10),
    };
  }
}

function invalidateSettingsCache(): void { settingsCache = null; settingsCacheTimestamp = 0; }

function compileFilter(rows: Array<{ phrase: string; isRegex: boolean; testMode: boolean }>): CompiledFilter[] {
  return rows.map((row) => {
    let compiled: RegExp | null = null;
    if (row.isRegex) {
      if (row.phrase.length > MAX_REGEX_LENGTH) {
        logger.warn({ phrase: row.phrase.slice(0, 80) }, 'Word filter regex exceeds max length -- skipped');
      } else {
        // compileUserRegex adds ReDoS guards (catastrophic-construct rejection)
        compiled = compileUserRegex(row.phrase, 'wordFilter');
      }
    } else {
      // Literal phrase: compile against the canonical (diacritic-stripped) form
      // with the 'u' flag, matching how filterContent/findProhibitedPhrase reduce
      // input via canon() before testing. Without this a phrase like "café" would
      // never match because the trailing \b can't form after a non-ASCII letter.
      const escaped = canon(row.phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      compiled = new RegExp(`\\b${escaped}\\b`, 'iu');
    }
    return { phrase: row.phrase, is_regex: row.isRegex, test_mode: row.testMode, compiled };
  });
}

async function getWordFilter(): Promise<CompiledFilter[]> {
  const now = Date.now();
  if (filterLastLoaded > 0 && now - filterLastLoaded < 60_000) return cachedFilter;

  // If a DB fetch is already in flight, wait for it instead of firing another query
  if (!wordFilterPromise) {
    const gen = cacheGeneration;
    wordFilterPromise = prisma.wordFilter.findMany({
      select: { phrase: true, isRegex: true, testMode: true },
    })
      .then((rows) => {
        // Only write back if resetCache() hasn't been called since this fetch started
        if (gen === cacheGeneration) {
          cachedFilter = compileFilter(rows);
          filterLastLoaded = Date.now();
        }
        return cachedFilter;
      })
      .finally(() => { wordFilterPromise = null; });
  }
  return wordFilterPromise;
}

/**
 * Check message content against word filter.
 * Returns { blocked: boolean, reason: string|null }
 * Filters with test_mode = true log the match but do NOT block the message.
 */
async function filterContent(content: string, userId?: string): Promise<{ blocked: boolean; reason: string | null }> {
  // Match against the CANONICAL form (NFD + strip combining marks) so combining
  // diacritics can't bypass the keyword / regex filters. We only MATCH on the
  // canonical form — the original `content` is what gets stored/logged below.
  const normalized = canon(content);
  // Always check baseline denylist first — independent of DB state.
  for (const entry of BASELINE_DENYLIST) {
    if (entry.compiled.test(normalized)) {
      return { blocked: true, reason: 'Matched prohibited phrase' };
    }
  }

  const filters = await getWordFilter();

  for (const filter of filters) {
    if (filter.compiled && filter.compiled.test(normalized)) {
      if (filter.test_mode) {
        // Test mode: log the match but allow the message through
        logger.info({ userId, phrase: filter.phrase, testMode: true }, 'Auto-mod test match (not blocking)');
        prisma.auditLog.create({
          data: {
            action: 'auto_mod_test_match',
            targetId: userId || null,
            targetType: 'user',
            reason: 'Test-mode filter match',
            metadata: { phrase: filter.phrase, content: content.slice(0, 200) },
          },
        }).catch((err: Error) => logger.warn({ err }, 'Failed to log test-mode match'));
        continue;
      }
      return { blocked: true, reason: 'Matched prohibited phrase' };
    }
  }

  return { blocked: false, reason: null };
}

/**
 * Sliding-window spam detection using Redis.
 * Returns { spamDetected: boolean }
 * Limit: 6 messages per 10 seconds per user.
 * Users with an active spam immunity window are skipped.
 */
async function detectSpam(userId: string): Promise<{ spamDetected: boolean }> {
  const redis = await getRedisClient();

  // Check spam immunity (set when a moderator reverses a spam penalty)
  const immunityKey = `spam:immunity:${userId}`;
  const immune = await redis.get(immunityKey);
  if (immune) {
    return { spamDetected: false };
  }

  const key = `spam:${userId}`;
  const now = Date.now();
  const spamSettings = await getSpamSettings();
  const window = spamSettings.spamWindowMs;
  const limit = spamSettings.spamMessageLimit;

  const multi = redis.multi();
  multi.zRemRangeByScore(key, '-inf', now - window);
  multi.zAdd(key, { score: now, value: String(now) });
  multi.zCard(key);
  multi.expire(key, 30);
  const results = await multi.exec() as any[];

  const count = results[2];
  return { spamDetected: count > limit };
}

/**
 * Grant spam immunity to a user for 60 minutes.
 * Called when a moderator reverses an auto-mod spam penalty (unmute).
 */
const SPAM_IMMUNITY_TTL_SECONDS = 60 * 60; // 60 minutes

async function setSpamImmunity(userId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(`spam:immunity:${userId}`, '1', { EX: SPAM_IMMUNITY_TTL_SECONDS });
  logger.info({ userId, ttlSeconds: SPAM_IMMUNITY_TTL_SECONDS }, 'Spam immunity granted');
}

/**
 * Shadow-mute a user -- sets is_muted with a 1-hour expiry and logs to audit.
 */
async function shadowMute(userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: userId },
    data: { isMuted: true, muteExpiresAt: expiresAt },
  });
  await prisma.auditLog.create({
    data: {
      action: 'auto_shadow_mute',
      targetId: userId,
      targetType: 'user',
      reason: 'Automated spam detection',
    },
  });
  logger.warn({ userId }, 'Auto shadow-mute applied');
}

function resetCache(): void {
  cacheGeneration++;     // invalidate any in-flight promise's write-back
  cachedFilter = [];
  filterLastLoaded = 0;
  wordFilterPromise = null;
}

/**
 * STRICT profanity check for short identifiers like party names and usernames.
 * Unlike filterContent (used for chat), this blocks on ANY word-filter match —
 * INCLUDING test_mode filters, which are merely logged (allowed) in chat.
 * Party names / usernames get zero tolerance: even words permitted in chat are
 * rejected. Always checks the hardcoded BASELINE_DENYLIST first so the check
 * is never empty even when the DB word_filter table has no rows.
 * Returns the matched phrase, or null if the text is clean.
 */
async function findProhibitedPhrase(content: string): Promise<string | null> {
  // Match against the CANONICAL form (NFD + strip combining marks) so a slur
  // padded with combining diacritics (e.g. "ńigger") can't slip past the
  // username / party-name check. Returns the ORIGINAL stored phrase on a hit.
  const normalized = canon(content);
  // Always check baseline denylist first — independent of DB state.
  // Uses substring matching (no \b) so slurs embedded in identifiers are caught.
  for (const entry of BASELINE_DENYLIST_NAMES) {
    if (entry.compiled.test(normalized)) return entry.phrase;
  }
  // Then check admin-configured DB rules.
  const filters = await getWordFilter();
  for (const filter of filters) {
    if (filter.compiled && filter.compiled.test(normalized)) return filter.phrase;
  }
  return null;
}

export { filterContent, detectSpam, shadowMute, setSpamImmunity, getWordFilter, resetCache, getSpamSettings, invalidateSettingsCache, findProhibitedPhrase };
module.exports = { filterContent, detectSpam, shadowMute, setSpamImmunity, getWordFilter, resetCache, getSpamSettings, invalidateSettingsCache, findProhibitedPhrase };
