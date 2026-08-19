/**
 * AutoMod Engine — evaluates a message against all enabled automod_rules and
 * (internally) the legacy word_filter table, so the WS chat:send handler has a
 * SINGLE entry point for ALL content-moderation checks.
 *
 * Consolidation strategy
 * ──────────────────────
 * The legacy autoModService (filterContent + detectSpam + shadowMute) is still
 * the source of truth for the word_filter table and the Redis spam sliding-window.
 * This engine WRAPS those calls and also evaluates the new automod_rules table.
 * The chat:send handler should call `engineEvaluate()` instead of calling
 * filterContent/detectSpam separately — doing so eliminates double-blocking.
 *
 * AI moderation is the PRIMARY content check
 * ──────────────────────────────────────────
 * When `ai_moderation_enabled` is on and the OpenAI Moderation API responds, the
 * hand-maintained keyword layers (the legacy word_filter AND KEYWORD_PRESET
 * rules) are SKIPPED only while the classifier is healthy and enforcing. They
 * remain active in shadow mode and when the AI verdict is unavailable (disabled,
 * timeout, non-200, circuit breaker open). This is fail-open: a degraded or
 * shadow classifier leaves enforcement with the target-gated built-ins plus
 * explicit admin rules.
 *
 * NOTE the classifier only understands *harmful content*. Spam floods, mention
 * spam, and links are outside its remit, so the Redis sliding-window and the
 * SPAM / MENTION_SPAM / LINK triggers always run regardless of AI health.
 *
 * Action types
 * ────────────
 *   BLOCK       — drop message; send WS error with customMessage
 *   ALERT       — post mod-log embed to Discord (#vault-security by default)
 *   TIMEOUT     — call muteUser() with Discord propagation
 *   MUTE_OVERLAY — call muteUser() WITHOUT Discord propagation (overlay-only mute)
 *
 * Trigger types
 * ─────────────
 *   AI_MODERATION — OpenAI Moderation API verdict vs. per-category thresholds
 *   KEYWORD       — keyword_filter[] (wildcards), regex_patterns[], allow_list[]
 *   KEYWORD_PRESET — curated PROFANITY / SEXUAL_CONTENT / SLURS lists (in-code)
 *   MENTION_SPAM  — count @name and <@id> mentions ≥ mention_total_limit
 *   SPAM          — reuses Redis sliding-window from autoModService (no duplicate)
 *   LINK          — regex over https?:// URLs; domain allow_list[]
 */

import prisma from '../config/prisma';
import logger from '../config/logger';
import { postModAlert } from './discordService';
import { filterContent, detectSpam } from './autoModService';
import { muteUser } from './moderationActionsService';
import { isProtectedTarget } from './userRoleService';
import { compileUserRegex, clampRegexInput } from '../utils/safeRegex';
import { canon } from '../utils/textCanon';
import {
  classifyContent,
  evaluateVerdict,
  getChatTargetedAttackThresholds,
  getAiModerationSettings,
  CHAT_TIMEOUT_MS,
  type AiVerdict,
} from './aiModerationService';
import { hasDirectTarget } from '../utils/targetedAttack';

// ── Curated preset word lists ─────────────────────────────────────────────────
// Kept deliberately short here; the full lists can be updated in code without
// a schema change. All checked case-insensitively.

const PRESET_LISTS: Record<string, string[]> = {
  PROFANITY: [
    'asshole', 'bastard', 'bullshit', 'crap', 'damnit', 'dickhead', 'dumbass',
    'fuckhead', 'jackass', 'motherfucker', 'piss', 'pussy', 'shithead', 'wanker',
  ],
  SEXUAL_CONTENT: [
    'blowjob', 'cock', 'cumshot', 'deepthroat', 'dildo', 'fingering', 'gangbang',
    'handjob', 'masturbat', 'nudes', 'onlyfans', 'penis', 'porn', 'rape', 'sex',
    'sexting', 'tits', 'vagina', 'vibrator', 'xxx',
  ],
  SLURS: [
    'beaner', 'bitch', 'chink', 'coon', 'cracker', 'cunt', 'dyke', 'fag',
    'faggot', 'gook', 'ho', 'honky', 'jigaboo', 'jungle bunny', 'kike', 'nigga',
    'nigger', 'oreo', 'porch monkey', 'raghead', 'redskin', 'sand nigger',
    'sandnigger', 'shemale', 'sissy', 'skank', 'slant', 'slut', 'spic', 'spick',
    'squaw', 'towelhead', 'tranny', 'twat', 'uncle tom', 'wetback', 'whore',
    'zipperhead',
  ],
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RuleAction {
  type: 'BLOCK' | 'ALERT' | 'TIMEOUT' | 'MUTE_OVERLAY';
  metadata?: {
    customMessage?: string;
    durationSeconds?: number;
    [key: string]: unknown;
  };
}

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  triggerType: string;
  matchedKeyword?: string;
  matchedSubstr?: string;
  actions: RuleAction[];
}

export interface EngineResult {
  block: boolean;
  customMessage?: string;
  matches: RuleMatch[];
}

interface EvaluationUser {
  id: string;
  username?: string | null;
  discordDisplayName?: string | null;
  discordUsername?: string | null;
  discordId?: string | null;
  roles?: string[]; // Discord role IDs (for exempt_roles check)
}

// ── Cache for automod_rules ───────────────────────────────────────────────────
interface CachedRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerMetadata: Record<string, unknown>;
  actions: RuleAction[];
  exemptChannelIds: string[];
  exemptRoles: string[];
}

let rulesCache: CachedRule[] = [];
let rulesCacheAt = 0;
const RULES_CACHE_TTL_MS = 30_000; // 30s — rules rarely change

async function getRules(): Promise<CachedRule[]> {
  if (rulesCache.length > 0 && Date.now() - rulesCacheAt < RULES_CACHE_TTL_MS) return rulesCache;
  try {
    const rows = await prisma.autoModRule.findMany({ where: { enabled: true } });
    rulesCache = rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      triggerType: r.triggerType,
      triggerMetadata: (r.triggerMetadata as Record<string, unknown>) ?? {},
      actions: (r.actions as unknown as RuleAction[]) ?? [],
      exemptChannelIds: r.exemptChannelIds ?? [],
      exemptRoles: r.exemptRoles ?? [],
    }));
    rulesCacheAt = Date.now();
  } catch (err) {
    logger.warn({ err }, 'autoModEngine: failed to load rules (using cached)');
  }
  return rulesCache;
}

/** Bust the rules cache — call after any rule create/update/delete. */
export function invalidateRulesCache(): void {
  rulesCache = [];
  rulesCacheAt = 0;
}

// ── Trigger evaluators ────────────────────────────────────────────────────────

interface TriggerMatch {
  matched: boolean;
  keyword?: string;
  substr?: string;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const MENTION_RE = /@\w[\w.-]{0,49}|<@!?\d{17,20}>/g;

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function matchesKeyword(
  content: string,
  keywords: string[],
  regexPatterns: string[],
  allowList: string[],
): TriggerMatch {
  const lower = content.toLowerCase();

  // Allow-list: if any allow-list entry appears, skip blocking
  for (const allow of allowList) {
    const re = wildcardToRegex(allow.toLowerCase());
    if (re.test(lower)) return { matched: false };
  }

  // Keyword list (wildcard support via *)
  for (const kw of keywords) {
    const re = wildcardToRegex(kw.toLowerCase());
    const m = re.exec(lower);
    if (m) return { matched: true, keyword: kw, substr: m[0] };
  }

  // Regex patterns
  const clamped = clampRegexInput(content);
  for (const pat of regexPatterns) {
    const re = compileUserRegex(pat, 'autoModEngine');
    if (!re) continue; // invalid or unsafe — skip
    const m = re.exec(clamped);
    if (m) return { matched: true, keyword: pat, substr: m[0] };
  }

  return { matched: false };
}

function evalKeyword(content: string, meta: Record<string, unknown>) {
  const keywords = (meta.keyword_filter as string[]) ?? [];
  const regexPatterns = (meta.regex_patterns as string[]) ?? [];
  const allowList = (meta.allow_list as string[]) ?? [];
  return matchesKeyword(content, keywords, regexPatterns, allowList);
}

function evalKeywordPreset(content: string, meta: Record<string, unknown>) {
  const presets = (meta.presets as string[]) ?? [];
  const allowList = (meta.allow_list as string[]) ?? [];

  // Presets are the offline fallback for the AI classifier. They have no
  // context of their own, so require explicit addressing by default to avoid
  // treating ordinary Fallout profanity or discussion as an attack. An admin
  // may explicitly opt a rule back into broad matching with false.
  if (meta.require_target !== false && !hasDirectTarget(content)) return { matched: false };

  const allKeywords: string[] = [];
  for (const preset of presets) {
    if (PRESET_LISTS[preset]) allKeywords.push(...PRESET_LISTS[preset]);
  }
  return matchesKeyword(content, allKeywords, [], allowList);
}

function evalMentionSpam(content: string, meta: Record<string, unknown>) {
  const limit = (meta.mention_total_limit as number) ?? 20;
  const mentions = content.match(MENTION_RE) ?? [];
  // Deduplicate mentions (same @user repeated counts as 1 each per Discord semantics)
  const unique = new Set(mentions.map((m) => m.toLowerCase()));
  if (unique.size >= limit) {
    return { matched: true, keyword: undefined, substr: `${unique.size} mentions` };
  }
  return { matched: false };
}

function evalLink(content: string, meta: Record<string, unknown>) {
  const allowDomains = ((meta.allow_list as string[]) ?? []).map((d) => d.toLowerCase());
  const urls = content.match(URL_RE) ?? [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (allowDomains.some((d) => host === d || host.endsWith('.' + d))) continue;
      return { matched: true, keyword: undefined, substr: url.slice(0, 256) };
    } catch {
      // unparseable URL — flag it
      return { matched: true, keyword: undefined, substr: url.slice(0, 256) };
    }
  }
  return { matched: false };
}

/**
 * Evaluate a pre-computed AI verdict against the enforce thresholds.
 *
 * Only a flagged verdict that breaches a targeted-attack threshold can match.
 * Below-threshold flags are ignored entirely so ordinary profanity does not
 * create a violation or alert.
 *
 * A rule may override the global thresholds via `triggerMetadata.thresholds`,
 * but the chat targeted-attack category boundary still applies.
 */
function evalAiModeration(
  content: string,
  verdict: AiVerdict,
  meta: Record<string, unknown>,
  globalThresholds: Record<string, number>,
): TriggerMatch {
  if (!verdict.flagged) return { matched: false };

  const override = meta.thresholds;
  const configuredThresholds =
    override && typeof override === 'object' && !Array.isArray(override)
      ? (override as Record<string, number>)
      : globalThresholds;
  const thresholds = getChatTargetedAttackThresholds(configuredThresholds);
  const directTarget = hasDirectTarget(content);
  const enforceableThresholds = directTarget
    ? thresholds
    : Object.fromEntries(
      Object.entries(thresholds).filter(([category]) =>
        category !== 'harassment' && category !== 'harassment/threatening'),
    );

  const enforcement = evaluateVerdict(verdict, enforceableThresholds);

  if (!enforcement.block || !enforcement.category) return { matched: false };

  // Hate categories are inherently group-directed. Harassment categories need
  // an explicit person/mention target so "this game is bullshit" stays clean.
  return {
    matched: true,
    keyword: enforcement.category,
    substr: `${enforcement.category} ${enforcement.score.toFixed(3)} >= ${enforcement.threshold}`,
  };
}

// ── Action executor ───────────────────────────────────────────────────────────

async function executeActions(
  rule: CachedRule,
  content: string,
  channelId: string | undefined,
  user: EvaluationUser,
  matchedKeyword: string | undefined,
  matchedSubstr: string | undefined,
): Promise<Array<{ type: string; success: boolean; detail?: string }>> {
  const results: Array<{ type: string; success: boolean; detail?: string }> = [];
  const channelName = channelId ? `<#${channelId}>` : 'Unknown';
  // FO76-real → discord_display_name → discord_username → user id fallback
  const isAutoModPlaceholder = (n: string | null | undefined) =>
    !n || n === 'Wanderer' || n.startsWith('pending-') || /^overlay\d+$/i.test(n) || n.startsWith('discord:');
  const displayName = !isAutoModPlaceholder(user.username)
    ? user.username!
    : (user.discordDisplayName || user.discordUsername || user.id);

  for (const action of rule.actions) {
    switch (action.type) {
      case 'BLOCK':
        // BLOCK is handled in the caller; just record it.
        results.push({ type: 'BLOCK', success: true });
        break;

      case 'ALERT': {
        try {
          const colorMap: Record<string, string> = {
            AI_MODERATION: '#9B59B6',
            KEYWORD: '#FF0000',
            KEYWORD_PRESET: '#FF0000',
            SPAM: '#FFA500',
            MENTION_SPAM: '#FFD700',
            LINK: '#FF0000',
          };
          await postModAlert({
            title: `🛡️ Auto-Mod Triggered — ${rule.name}`,
            color: colorMap[rule.triggerType] || '#FF0000',
            fields: [
              { name: 'User', value: displayName, inline: true },
              { name: 'Channel', value: channelName, inline: true },
              { name: 'Rule', value: rule.triggerType, inline: true },
              ...(matchedKeyword ? [{ name: 'Matched', value: matchedKeyword.slice(0, 256), inline: true }] : []),
              { name: 'Content', value: `> ${content.slice(0, 1500)}` },
            ],
            timestamp: true,
            footerText: `User ID: ${user.id} | Rule ID: ${rule.id}`,
          });
          results.push({ type: 'ALERT', success: true });
        } catch (err: any) {
          logger.warn({ err, ruleId: rule.id }, 'autoModEngine: ALERT action failed');
          results.push({ type: 'ALERT', success: false, detail: err?.message });
        }
        break;
      }

      case 'TIMEOUT': {
        try {
          const durationMs = ((action.metadata?.durationSeconds as number) ?? 3600) * 1000;
          await muteUser(user.id, 'system', durationMs, 'AutoMod', `Auto-mod: ${rule.name}`);
          results.push({ type: 'TIMEOUT', success: true });
        } catch (err: any) {
          logger.warn({ err, ruleId: rule.id, userId: user.id }, 'autoModEngine: TIMEOUT action failed');
          results.push({ type: 'TIMEOUT', success: false, detail: err?.message });
        }
        break;
      }

      case 'MUTE_OVERLAY': {
        // Overlay-only mute: calls muteUser with skipDiscord flag.
        // muteUser signature unchanged — skipDiscord is added optionally.
        try {
          const durationMs = ((action.metadata?.durationSeconds as number) ?? 3600) * 1000;
          await muteUser(user.id, 'system', durationMs, 'AutoMod', `Auto-mod (overlay): ${rule.name}`, true);
          results.push({ type: 'MUTE_OVERLAY', success: true });
        } catch (err: any) {
          logger.warn({ err, ruleId: rule.id, userId: user.id }, 'autoModEngine: MUTE_OVERLAY action failed');
          results.push({ type: 'MUTE_OVERLAY', success: false, detail: err?.message });
        }
        break;
      }
    }
  }

  return results;
}

// ── Main evaluate function ────────────────────────────────────────────────────

/**
 * Single entry point for ALL content moderation on a chat:send event.
 *
 * Runs in this order:
 *   0. Staff exemption — short-circuits BEFORE classification, so staff content
 *      is never transmitted to OpenAI
 *   1. AI classification (OpenAI Moderation API) — the primary content check
 *   2. Legacy word_filter — fallback or shadow mode; skipped only while AI enforces
 *   3. Legacy Redis spam sliding-window — always runs (AI does not detect spam)
 *   4. automod_rules (AI_MODERATION, KEYWORD, KEYWORD_PRESET, MENTION_SPAM, SPAM, LINK)
 *
 * Short-circuits on first BLOCK match to avoid double-muting.
 * Always writes an AutoModViolation row on any match.
 */
export async function engineEvaluate(
  content: string,
  channelId: string | undefined,
  user: EvaluationUser,
): Promise<EngineResult> {
  const result: EngineResult = { block: false, matches: [] };

  // Compute the CANONICAL form once (NFD + strip combining marks) so every
  // downstream MATCH (keyword list, regex patterns, link detection, mention
  // spam, the legacy word_filter) sees diacritic-free text and combining-mark
  // bypass is defeated. This is used ONLY for matching; the ORIGINAL `content`
  // is what gets persisted (violation rows, audit log) and shown in alerts, so
  // evidence always reflects exactly what the user sent. Keeping match-form and
  // evidence-form separate is the fix for the persist/broadcast divergence.
  const matchContent = canon(content);

  // ── 0. Staff exemption ────────────────────────────────────────────────────
  // Moderators, admins, and the owner are exempt from ALL auto-mod (word
  // filter, spam, and rules). isProtectedTarget checks the Redis role cache
  // then the admin_users table as source of truth.
  try {
    if (await isProtectedTarget(user.id)) {
      return result; // block:false — staff bypass every check
    }
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'autoModEngine: staff-exemption check failed (non-fatal)');
  }

  // ── 1. AI classification (primary content check) ──────────────────────────
  // One call, cached in locals for the rule loop below — the AI_MODERATION
  // trigger reuses this verdict rather than making a second request.
  //
  // A null verdict means DEGRADED (disabled, no key, timeout, non-200, breaker
  // open). It is never read as "clean" — it hands enforcement back to the
  // keyword layers below.
  const aiSettings = await getAiModerationSettings();
  let aiVerdict: AiVerdict | null = null;
  if (aiSettings.enabled) {
    try {
      aiVerdict = await classifyContent(content, { timeoutMs: CHAT_TIMEOUT_MS });
    } catch (err) {
      // classifyContent is written not to throw; this is belt-and-braces so a
      // bug there can never take down the send path.
      logger.warn({ err }, 'autoModEngine: AI classification threw (non-fatal, falling back)');
    }
  }

  // While the classifier is healthy and enforcing it SUPERSEDES the curated
  // preset lists. Shadow mode must leave the existing enforcement path intact:
  // AI records shadow matches, but it must not change what the legacy rules do.
  const useKeywordFallback = aiVerdict === null || aiSettings.mode !== 'enforce';

  // ── 2. Legacy word_filter (FALLBACK OR SHADOW) ─────────────────────────────
  // filterContent handles the word_filter table + test_mode logging. Pass the
  // ORIGINAL content — filterContent canon()s internally for matching but logs
  // the original, so its test-mode audit evidence stays faithful.
  if (useKeywordFallback) {
    try {
      const { blocked, reason } = await filterContent(content, user.id);
      if (blocked) {
        result.block = true;
        result.customMessage = 'Message blocked by content filter.';
        // Write a pseudo-violation for audit (no rule_id since it's from word_filter)
        // We log to audit_log via the existing filterContent flow — no additional row needed here.
        logger.info({ userId: user.id, reason }, 'autoModEngine: legacy word_filter block');
        return result;
      }
    } catch (err) {
      logger.warn({ err }, 'autoModEngine: filterContent error (non-fatal)');
    }
  }

  // ── 3. Legacy Redis spam detection ────────────────────────────────────────
  // ALWAYS runs. The moderation endpoint classifies harmful content only — it
  // has no concept of message rate, so this is not part of the keyword retirement.
  // detectSpam manages the Redis sliding-window; we call it here so chat:send
  // only needs to call engineEvaluate (not detectSpam separately).
  try {
    const { spamDetected } = await detectSpam(user.id);
    if (spamDetected) {
      result.block = true;
      result.customMessage = 'Spam detected. You have been temporarily muted.';
      logger.info({ userId: user.id }, 'autoModEngine: legacy spam detection block');
      return result;
    }
  } catch (err) {
    logger.warn({ err }, 'autoModEngine: detectSpam error (non-fatal)');
  }

  // ── 4. New automod_rules ──────────────────────────────────────────────────
  let rules: CachedRule[];
  try {
    rules = await getRules();
  } catch (err) {
    logger.warn({ err }, 'autoModEngine: failed to load rules (skipping)');
    return result;
  }

  for (const rule of rules) {
    // Channel exemption
    if (channelId && rule.exemptChannelIds.includes(channelId)) continue;

    // Role exemption
    if (user.roles && user.roles.some((r) => rule.exemptRoles.includes(r))) continue;

    let matchResult: TriggerMatch = { matched: false };

    switch (rule.triggerType) {
      case 'AI_MODERATION':
        // No verdict → degraded. Skip silently; the keyword fallback above and
        // the KEYWORD_PRESET rules below are carrying enforcement in that case.
        if (!aiVerdict) continue;
        matchResult = evalAiModeration(content, aiVerdict, rule.triggerMetadata, aiSettings.thresholds);
        break;
      case 'KEYWORD':
        // Admin-authored keyword rules always run — they are a moderator's
        // escape hatch for terms the classifier misses (a specific troll,
        // targeted harassment of a named player). Only the hand-maintained
        // PRESET lists are superseded by the AI.
        matchResult = evalKeyword(matchContent, rule.triggerMetadata);
        break;
      case 'KEYWORD_PRESET':
        // Superseded only while the classifier is healthy AND enforcing — this
        // is the curated PROFANITY / SEXUAL_CONTENT / SLURS list the AI replaces.
        // Shadow mode keeps these rules active so calibration cannot weaken
        // the protections already in production.
        if (!useKeywordFallback) continue;
        matchResult = evalKeywordPreset(matchContent, rule.triggerMetadata);
        break;
      case 'MENTION_SPAM':
        matchResult = evalMentionSpam(matchContent, rule.triggerMetadata);
        break;
      case 'SPAM':
        // SPAM rules re-use the Redis window already checked above (step 2).
        // If we're here the spam check passed. However, per-rule metadata may define
        // stricter dupe thresholds that detectSpam doesn't know about — we do a
        // lightweight dupe-content check here.
        // For now we skip to avoid double-firing; the step-2 detectSpam covers it.
        continue;
      case 'LINK':
        matchResult = evalLink(matchContent, rule.triggerMetadata);
        break;
      default:
        continue;
    }

    if (!matchResult.matched) continue;

    const isAiRule = rule.triggerType === 'AI_MODERATION';

    // Shadow mode is strictly side-effect-free: no BLOCK, no ALERT spam, no
    // TIMEOUT/MUTE. It exists so thresholds can be calibrated against real
    // traffic before enforcement is switched on, so it must never act.
    const shadow = isAiRule && aiSettings.mode !== 'enforce';

    // Execute actions. Pass the ORIGINAL content so the ALERT embed and any
    // downstream evidence show exactly what the user sent, not the canon form.
    const actionsTaken = shadow
      ? [{ type: 'SHADOW', success: true, detail: 'shadow mode — logged, not enforced' }]
      : await executeActions(
        rule, content, channelId, user,
        matchResult.keyword, matchResult.substr,
      );

    const match: RuleMatch = {
      ruleId: rule.id,
      ruleName: rule.name,
      triggerType: rule.triggerType,
      matchedKeyword: matchResult.keyword,
      matchedSubstr: matchResult.substr,
      actions: rule.actions,
    };
    result.matches.push(match);

    // Write violation record (fire-and-forget). AI matches carry the full
    // category→score map so a moderator reviewing the row sees exactly why it
    // fired, plus a sortable severity — the gradation keyword rules never had.
    prisma.autoModViolation.create({
      data: {
        ruleId: rule.id,
        userId: user.id,
        channelId: channelId ?? null,
        // Persist the ORIGINAL message so violation evidence is faithful — the
        // canon form is a matching artifact and must never be stored/broadcast.
        messageContent: content.slice(0, 4000),
        matchedKeyword: matchResult.keyword ?? null,
        matchedSubstr: matchResult.substr ?? null,
        actionsTaken: actionsTaken as any,
        aiCategories: isAiRule && aiVerdict ? (aiVerdict.scores as any) : undefined,
        aiMaxScore: isAiRule && aiVerdict ? aiVerdict.maxScore : undefined,
      },
    }).catch((err: unknown) => logger.warn({ err }, 'autoModEngine: failed to write violation row'));

    // Write audit log (fire-and-forget)
    prisma.auditLog.create({
      data: {
        action: 'automod_violation',
        targetId: user.id,
        targetType: 'user',
        reason: `Rule: ${rule.name} (${rule.triggerType})${shadow ? ' [shadow]' : ''}`,
        metadata: {
          ruleId: rule.id,
          matchedKeyword: matchResult.keyword,
          matchedSubstr: matchResult.substr,
          actionsTaken,
          ...(isAiRule && aiVerdict
            ? { aiMaxScore: aiVerdict.maxScore, aiTopCategory: aiVerdict.topCategory, aiShadow: shadow }
            : {}),
        },
      },
    }).catch((err: unknown) => logger.warn({ err }, 'autoModEngine: failed to write audit log'));

    // Check if this match should block. Shadow mode never blocks.
    const hasBlock = rule.actions.some((a) => a.type === 'BLOCK') && !shadow;
    if (hasBlock) {
      const blockAction = rule.actions.find((a) => a.type === 'BLOCK');
      result.block = true;
      result.customMessage = (blockAction?.metadata?.customMessage as string) ?? 'Message blocked by auto-mod.';
      // Short-circuit on first block
      return result;
    }
  }

  return result;
}
