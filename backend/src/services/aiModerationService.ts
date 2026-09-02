/**
 * aiModerationService — OpenAI Moderation API client.
 *
 * Primary content classifier for FCM. Replaces the hand-maintained keyword lists
 * as the *enforcing* check on chat, usernames/party names, and Discord-bridged
 * messages; the keyword lists remain as an offline fallback that only runs when
 * this service reports degraded (see `engineEvaluate` in autoModEngine.ts).
 *
 * Design notes
 * ────────────
 * - FAIL OPEN. Every failure path returns `null`, which callers read as
 *   "degraded" and handle by falling back to the keyword denylists. A null is
 *   never an implicit "clean" verdict.
 * - Staff content never reaches this service: `engineEvaluate` short-circuits on
 *   `isProtectedTarget()` before classification runs.
 * - Only the message text is transmitted — no username, user ID, or channel.
 * - `postModAlert` is imported lazily inside `noteDegraded()` so this module can
 *   be pulled into autoModService (the identifier path) without dragging
 *   discord.js into that module graph.
 *
 * Docs: docs/moderation/ai-moderation.md
 */

import { createHash } from 'crypto';
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { canon } from '../utils/textCanon';
import { cachedFetch } from '../lib/cachedFetch';

const OPENAI_MODERATIONS_URL = 'https://api.openai.com/v1/moderations';
const OPENAI_MODEL = 'omni-moderation-latest';

/** Send-path timeout. Chat pays this on every uncached message, so keep it tight. */
export const CHAT_TIMEOUT_MS = 800;
/** Identifier timeout. Registration/party-rename is one-off; latency is irrelevant. */
export const IDENTIFIER_TIMEOUT_MS = 3_000;

/** Verdict cache TTL. Repeated text is very common in game chat. */
const VERDICT_CACHE_TTL_SEC = 3_600;

/** Max characters sent upstream. The endpoint accepts far more; this bounds cost/latency. */
const MAX_INPUT_CHARS = 4_000;

/** Max response bytes accepted (mirrors the fandomApiClient guard). */
const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MB

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Without this, an OpenAI outage adds the full timeout to EVERY message.
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60_000;

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** Debounce for the "moderation is degraded" mod-log embed. */
const DEGRADED_ALERT_DEBOUNCE_MS = 15 * 60_000;
let lastDegradedAlertAt = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AiVerdict {
  /** OpenAI's own boolean — true when ANY category tripped its internal bar. */
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
  maxScore: number;
  topCategory: string | null;
}

export interface AiEnforcement {
  /** True when a configured threshold was met or exceeded. */
  block: boolean;
  category: string | null;
  score: number;
  threshold: number | null;
}

export type AiModerationMode = 'shadow' | 'enforce';

export interface AiModerationSettings {
  enabled: boolean;
  mode: AiModerationMode;
  thresholds: Record<string, number>;
  identifierThresholds: Record<string, number>;
}

// ── Default thresholds ────────────────────────────────────────────────────────
//
// Chat policy: only high-confidence person-directed attack categories are
// eligible for enforcement. Generic profanity, sexual content, self-harm,
// violence, and illicit/game vocabulary are deliberately outside this policy.
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  'hate/threatening': 0.9,
  'harassment/threatening': 0.9,
  hate: 0.95,
  harassment: 0.95,
};

/** Categories allowed to participate in the chat targeted-attack policy. */
const CHAT_TARGETED_ATTACK_CATEGORIES = new Set([
  'hate/threatening',
  'harassment/threatening',
  'hate',
  'harassment',
]);

/**
 * Apply the hard chat policy boundary to global or per-rule thresholds.
 * Identifier moderation intentionally uses its separate, wider threshold map.
 */
export function getChatTargetedAttackThresholds(
  thresholds: Record<string, number>,
): Record<string, number> {
  const filtered: Record<string, number> = {};
  for (const [category, threshold] of Object.entries(thresholds)) {
    if (
      CHAT_TARGETED_ATTACK_CATEGORIES.has(category)
      && typeof threshold === 'number'
      && Number.isFinite(threshold)
      && threshold > 0
      && threshold <= 1
    ) filtered[category] = threshold;
  }
  return filtered;
}

// Identifiers (usernames, party names) are permanent and public, so the bar is
// lower and the enforced set is wider than for chat.
export const DEFAULT_IDENTIFIER_THRESHOLDS: Record<string, number> = {
  'sexual/minors': 0.3,
  'hate/threatening': 0.4,
  'harassment/threatening': 0.5,
  hate: 0.5,
  harassment: 0.7,
  sexual: 0.6,
  'self-harm/instructions': 0.5,
  'violence/graphic': 0.8,
};

// ── Settings cache ────────────────────────────────────────────────────────────
// Mirrors the 60s spam-settings cache in autoModService.

const SETTINGS_CACHE_TTL_MS = 60_000;
const SETTING_KEYS = [
  'ai_moderation_enabled',
  'ai_moderation_mode',
  'ai_moderation_thresholds',
  'ai_moderation_identifier_thresholds',
];

let settingsCache: AiModerationSettings | null = null;
let settingsCacheAt = 0;

const DISABLED_SETTINGS: AiModerationSettings = {
  enabled: false,
  mode: 'shadow',
  thresholds: DEFAULT_THRESHOLDS,
  identifierThresholds: DEFAULT_IDENTIFIER_THRESHOLDS,
};

/** Parse a thresholds JSON blob, ignoring non-numeric / out-of-range entries. */
function parseThresholds(raw: string | undefined, fallback: Record<string, number>): Record<string, number> {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n) && n > 0 && n <= 1) out[key] = n;
    }
    // An explicitly empty map is a valid configuration (no category enforces).
    return out;
  } catch {
    logger.warn('[aiModeration] thresholds setting is not valid JSON — using defaults');
    return fallback;
  }
}

export async function getAiModerationSettings(): Promise<AiModerationSettings> {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_CACHE_TTL_MS) return settingsCache;

  // No key configured means the integration can never run. Skip the DB round-trip.
  if (!env.OPENAI_API_KEY) {
    settingsCache = DISABLED_SETTINGS;
    settingsCacheAt = Date.now();
    return settingsCache;
  }

  try {
    const rows = await prisma.moderationSetting.findMany({ where: { key: { in: SETTING_KEYS } } });
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value;

    settingsCache = {
      enabled: map.ai_moderation_enabled === 'true',
      // Anything other than an explicit 'enforce' stays in shadow — the safe default.
      mode: map.ai_moderation_mode === 'enforce' ? 'enforce' : 'shadow',
      thresholds: parseThresholds(map.ai_moderation_thresholds, DEFAULT_THRESHOLDS),
      identifierThresholds: parseThresholds(
        map.ai_moderation_identifier_thresholds,
        DEFAULT_IDENTIFIER_THRESHOLDS,
      ),
    };
    settingsCacheAt = Date.now();
    return settingsCache;
  } catch (err) {
    logger.warn({ err }, '[aiModeration] failed to read settings — treating as disabled');
    // Do NOT cache a DB failure; retry on the next message.
    return DISABLED_SETTINGS;
  }
}

/** Bust the settings cache — call after any moderation-settings PATCH. */
export function invalidateAiModerationCache(): void {
  settingsCache = null;
  settingsCacheAt = 0;
}

// ── Degradation reporting ─────────────────────────────────────────────────────

/**
 * Record a failure and, on the first transition into a degraded state, tell
 * staff in the mod-log that content moderation has fallen back to keywords.
 * This is the "log loudly" half of fail-open.
 */
function noteDegraded(reason: string, detail?: unknown): void {
  consecutiveFailures += 1;
  logger.warn({ reason, detail, consecutiveFailures }, '[aiModeration] classification failed — falling back to keyword filter');

  if (consecutiveFailures < BREAKER_FAILURE_THRESHOLD) return;

  const now = Date.now();
  const wasClosed = breakerOpenUntil <= now;
  breakerOpenUntil = now + BREAKER_OPEN_MS;
  if (!wasClosed) return; // breaker already open — don't re-alert on every miss

  if (now - lastDegradedAlertAt < DEGRADED_ALERT_DEBOUNCE_MS) return;
  lastDegradedAlertAt = now;

  logger.error({ reason, consecutiveFailures }, '[aiModeration] circuit breaker OPEN — AI moderation is degraded');

  // Lazy require: keeps discord.js out of this module's import graph.
  void (async () => {
    try {
      const { postModAlert } = require('./discordService');
      await postModAlert({
        title: 'AI moderation degraded',
        color: '#FFA500',
        fields: [
          { name: 'Status', value: 'Falling back to keyword filters', inline: true },
          { name: 'Reason', value: String(reason).slice(0, 256), inline: true },
          { name: 'Retry in', value: `${Math.round(BREAKER_OPEN_MS / 1000)}s`, inline: true },
        ],
        timestamp: true,
      });
    } catch (err) {
      logger.warn({ err }, '[aiModeration] failed to post degradation alert');
    }
  })();
}

function noteHealthy(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

// ── Classification ────────────────────────────────────────────────────────────

/** Shape check on the upstream body — a malformed response must degrade, not throw. */
function toVerdict(body: unknown): AiVerdict | null {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const first = results[0] as {
    flagged?: unknown;
    categories?: unknown;
    category_scores?: unknown;
  };
  if (typeof first?.flagged !== 'boolean') return null;

  const rawScores = (first.category_scores ?? {}) as Record<string, unknown>;
  const rawCategories = (first.categories ?? {}) as Record<string, unknown>;

  const scores: Record<string, number> = {};
  let maxScore = 0;
  let topCategory: string | null = null;
  for (const [key, value] of Object.entries(rawScores)) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    scores[key] = n;
    if (n > maxScore) {
      maxScore = n;
      topCategory = key;
    }
  }

  const categories: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(rawCategories)) categories[key] = value === true;

  return { flagged: first.flagged, categories, scores, maxScore, topCategory };
}

/** One upstream call. Returns null on any failure (never throws). */
async function requestClassification(text: string, timeoutMs: number): Promise<AiVerdict | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_MODERATIONS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input: text.slice(0, MAX_INPUT_CHARS) }),
    });

    if (!res.ok) {
      noteDegraded(`http_${res.status}`);
      return null;
    }

    const raw = await res.text();
    if (raw.length > MAX_JSON_BYTES) {
      noteDegraded('response_too_large', raw.length);
      return null;
    }

    const verdict = toVerdict(JSON.parse(raw));
    if (!verdict) {
      noteDegraded('malformed_body');
      return null;
    }

    noteHealthy();
    return verdict;
  } catch (err) {
    noteDegraded(controller.signal.aborted ? 'timeout' : 'network_error', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify text. Returns null when the verdict is unavailable — disabled, no API
 * key, circuit breaker open, timeout, non-200, or malformed body. Callers MUST
 * treat null as "degraded, use the fallback", never as "clean".
 */
export async function classifyContent(
  text: string,
  opts?: { timeoutMs?: number },
): Promise<AiVerdict | null> {
  if (!text || !text.trim()) return null;

  const settings = await getAiModerationSettings();
  if (!settings.enabled || !env.OPENAI_API_KEY) return null;

  if (Date.now() < breakerOpenUntil) {
    // Breaker open — skip the round-trip entirely so an outage costs us nothing.
    return null;
  }

  const timeoutMs = opts?.timeoutMs ?? CHAT_TIMEOUT_MS;

  // Cache on the CANONICAL form so the existing combining-diacritic defense
  // applies to the cache key too — "ńigger" and "nigger" share one entry.
  const key = `aimod:v1:${createHash('sha256').update(canon(text)).digest('hex')}`;
  return cachedFetch<AiVerdict>(key, VERDICT_CACHE_TTL_SEC, () => requestClassification(text, timeoutMs));
}

// ── Threshold evaluation ──────────────────────────────────────────────────────

/**
 * Decide whether a verdict breaches an enforce threshold. Categories absent from
 * `thresholds` can never block. When several categories breach, the highest-
 * scoring one is reported.
 */
export function evaluateVerdict(
  verdict: AiVerdict,
  thresholds: Record<string, number>,
): AiEnforcement {
  let best: AiEnforcement = { block: false, category: null, score: 0, threshold: null };

  for (const [category, threshold] of Object.entries(thresholds)) {
    const score = verdict.scores[category];
    if (typeof score !== 'number' || score < threshold) continue;
    if (!best.block || score > best.score) {
      best = { block: true, category, score, threshold };
    }
  }

  if (!best.block) {
    // No threshold breached. Report the top category so callers can inspect the
    // strongest signal even when no category is enforceable.
    best = { block: false, category: verdict.topCategory, score: verdict.maxScore, threshold: null };
  }
  return best;
}

/**
 * Identifier screen for usernames and party names. Uses the wider, stricter
 * identifier thresholds and the longer timeout. Returns the breaching category,
 * or null when clean, degraded, or disabled.
 *
 * Unlike the chat path this is purely additive: the caller's hardcoded
 * BASELINE_IDENTIFIER denylist still runs regardless of this result.
 */
export async function screenIdentifier(text: string): Promise<{ category: string; score: number } | null> {
  const settings = await getAiModerationSettings();
  if (!settings.enabled) return null;

  const verdict = await classifyContent(text, { timeoutMs: IDENTIFIER_TIMEOUT_MS });
  if (!verdict) return null;

  // Shadow mode must not reject identifiers either — log and allow.
  const enforcement = evaluateVerdict(verdict, settings.identifierThresholds);
  if (!enforcement.block || !enforcement.category) return null;

  if (settings.mode !== 'enforce') {
    logger.info(
      { category: enforcement.category, score: enforcement.score },
      '[aiModeration] identifier would be rejected (shadow mode — allowing)',
    );
    return null;
  }

  return { category: enforcement.category, score: enforcement.score };
}

/** Test hook — resets breaker + caches between cases. */
export function __resetAiModerationStateForTests(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  lastDegradedAlertAt = 0;
  settingsCache = null;
  settingsCacheAt = 0;
}
