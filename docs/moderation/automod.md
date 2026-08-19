# Auto-Moderation

All content moderation on `chat:send` goes through a single entry point: `engineEvaluate()` in `backend/src/services/autoModEngine.ts`. This consolidates the AI classifier, the legacy word filter, the Redis spam detector, and the database-driven rule engine into one call so the WS handler never double-blocks.

> **The AI classifier is the primary targeted-attack check.** When AI moderation is enabled, reachable, and enforcing, the hand-maintained keyword layers below (the legacy `word_filter` **and** `KEYWORD_PRESET` rules) are **skipped** — they run only as an offline fallback. In `shadow` mode they remain active while AI only records calibration data. Ordinary Fallout profanity and gameplay violence are outside the chat AI policy. Full detail: **[ai-moderation.md](ai-moderation.md)**.

## Evaluation Order

`engineEvaluate(content, channelId, user)` runs checks in this sequence, short-circuiting on the first `BLOCK` match:

0. **Staff exemption** — `isProtectedTarget(user.id)` is checked first. Moderators, admins, and the owner bypass ALL content moderation. This runs **before** classification, so staff content is never transmitted to OpenAI.

1. **AI classification** — calls `classifyContent()` from `aiModerationService.ts` (OpenAI Moderation API, `omni-moderation-latest`, 800 ms timeout). The verdict is computed once here and reused by the `AI_MODERATION` rule at step 4 — never a second API call. A `null` verdict means **degraded** and is never read as "clean".

2. **Legacy word filter** — **fallback or shadow mode.** Calls `filterContent(content, userId)` from `autoModService.ts`. Checks the hardcoded chat baseline denylist first (target-gated), then the `word_filter` DB table (an explicit admin override).

3. **Legacy spam detection** — calls `detectSpam(userId)` from `autoModService.ts`. Uses a Redis sorted-set sliding window. **Always runs** — the classifier has no concept of message rate.

4. **AutoMod rules** — evaluates all enabled rows from `automod_rules` in order. Short-circuits on the first BLOCK action.

Any match at step 4 writes an `automod_violations` row and an `audit_logs` row (both fire-and-forget).

### What the AI supersedes, and what it does not

| Layer | AI mode behavior |
|---|---|
| Legacy `word_filter` + baseline denylist (chat) | **skipped in enforce; active in shadow** |
| `KEYWORD_PRESET` rules (`PROFANITY`/`SEXUAL_CONTENT`/`SLURS`) | **skipped in enforce; active in shadow** |
| `KEYWORD` rules (admin-authored) | still run — a moderator's escape hatch for terms the classifier misses |
| `SPAM`, `MENTION_SPAM`, `LINK` | still run — outside the classifier's remit |
| Identifier denylist (`findProhibitedPhrase`) | still runs — the AI screen is **additive** there, not superseding |

## Unicode Canonicalization (bypass defense)

Every filter entry point **matches against a canonical form** of the text, not the raw input, so combining diacritics can't be used to slip a banned phrase past the filter. The canonicalizer lives in `backend/src/utils/textCanon.ts`:

```ts
canon(s) = s.normalize('NFD').replace(/\p{M}/gu, '')
```

It decomposes precomposed characters (NFD) and **strips all combining marks** (`\p{M}`), so `café` → `cafe`, `é` → `e`, and a slur padded with a combining acute (`n` + U+0301 + `igger`) collapses back to `nigger`.

> **Why not bare NFC?** Plain `.normalize('NFC')` is largely ineffective here. It leaves the visible accent in place, so ASCII denylist phrases miss diacritic-padded variants, and a word-boundary phrase like `café` compiled as `/\bcafé\b/i` never matches user input because `é` is not an ASCII word character — the trailing `\b` boundary can't form after it. `canon()` reduces the text to plain ASCII letters so `\b` boundaries and ASCII phrases match as intended.

Where this is applied:

| Entry point | File | What is canonicalized |
|---|---|---|
| `filterContent()` | `autoModService.ts` | input is `canon()`ed before the baseline-denylist + `word_filter` checks |
| `findProhibitedPhrase()` | `autoModService.ts` | input (usernames via `usersController`, party names/descriptions via `partiesController`) is `canon()`ed before matching |
| `engineEvaluate()` | `autoModEngine.ts` | `matchContent = canon(content)` feeds KEYWORD / KEYWORD_PRESET / MENTION_SPAM / LINK |
| `isBlacklisted()` / `findBlacklistMatch()` | `nameBlacklistService.ts` | candidate **and** stored patterns are `canon()`ed for exact/contains; regex tests run against the canon form |
| `stripMentions()` | `discordService.ts` | `@everyone` / `@here` detection runs on the canon form so a combining-mark-padded ping is neutralized before reaching Discord |

Baseline-denylist, `word_filter`, and name-blacklist regexes are compiled with the **`u` (Unicode) flag** so `\b` boundaries and `\p{…}` classes behave correctly against the canonical form (`compileUserRegex()` accepts an optional `flags` argument and falls back to `'i'` if a pattern is invalid only under `'u'`).

**Match form vs. stored form.** Canonicalization is used **only for matching**. The original, unmodified message/name is always what gets **stored, broadcast, and shown in violation evidence** — the `automod_violations.messageContent` row, the Discord ALERT embed `Content` field, and the test-mode audit log all reference the original `content`, never the canon form. This keeps moderator-facing evidence faithful to exactly what the user sent.

> **Scope.** `canon()` does **not** collapse homoglyphs (e.g. Cyrillic `е` vs Latin `e`) or strip zero-width characters; those are separate concerns. Stripping combining marks is the high-value, low-risk defense for the documented combining-diacritic bypass.

## Legacy Word Filter (`autoModService.ts`)

### Baseline Denylists

`autoModService.ts` now keeps two hardcoded baseline lists:

- `BASELINE_CHAT_DENYLIST_PHRASES` — blocks hate speech / slurs plus a small set of severe abuse terms (`pedo`, `pedophile`, `rape`, `rapist`) in chat when an explicit target is present. Identifiers use the same terms context-free.
- `BASELINE_IDENTIFIER_DENYLIST_PHRASES` — used by `findProhibitedPhrase()` for usernames / party names and stays stricter than chat by also rejecting explicit profanity terms there.

Ordinary profanity such as `fuck`, `shit`, or `bastard` is intentionally **not** in the chat baseline anymore, so common cussing is no longer hard-blocked before the rule engine runs.
Listed/base terms without an explicit target are allowed in chat so ordinary
cussing and discussion do not become violations. This change does not try to
solve every deliberate slur-evasion variant. The identifier path remains strict.

### `word_filter` Table

Admin-configurable phrases/regexes managed via the dashboard. Cached in memory for 60 seconds; a generation counter prevents stale cache writes from in-flight fetches (`autoModService.ts:54-58`).

Each entry has:
- `phrase` — the string or regex pattern
- `is_regex` — if true, compiled via `compileUserRegex()` (ReDoS guards applied; max length 500 chars)
- `test_mode` — if true, the match is logged to `audit_logs` as `auto_mod_test_match` but the message is NOT blocked

`filterContent()` blocks on any non-test-mode match in this table. The rollout removes only the
exact legacy literal rows `fuck`, `shit`, `bastard`, and `assh`; future rows are explicit
moderator overrides and therefore remain context-free. Audit production rows if the goal is
targeted attacks only. `findProhibitedPhrase()` is a stricter
variant for identifiers that blocks even on test-mode entries.

### Spam Detection (Redis Sliding Window)

`detectSpam(userId)` uses a Redis sorted set keyed `spam:<userId>`:

1. Remove members older than `spamWindowMs` (default 10 000 ms)
2. Add current timestamp as a new member
3. Count remaining members
4. Block if count exceeds `spamMessageLimit` (default 6)
5. Set TTL of 30 seconds on the key

Settings are read from `moderation_settings` rows (`spam_message_limit`, `spam_window_ms`) with a 60-second cache, falling back to env vars `SPAM_MESSAGE_LIMIT` / `SPAM_WINDOW_MS`.

**Spam immunity** — when a moderator reverses a spam penalty (unmute), `setSpamImmunity(userId)` sets `spam:immunity:<userId>` in Redis for 60 minutes. While this key exists, `detectSpam` returns false for that user.

## AutoMod Rules (`automod_rules` table)

Rules are stored in the DB and cached in memory for 30 seconds (`RULES_CACHE_TTL_MS`). Call `invalidateRulesCache()` after any rule create/update/delete (the controller does this).

### Rule Structure

```jsonc
{
  "triggerType": "KEYWORD",
  "triggerMetadata": {
    "keyword_filter": ["badword", "bad*"],   // wildcard * supported
    "regex_patterns": ["\\b\\d{4}-\\d{4}\\b"],
    "allow_list": ["allowedterm"],
    "mention_total_limit": 5,               // for MENTION_SPAM
    "presets": ["SLURS"],                  // default seeded KEYWORD_PRESET
    "require_target": true                  // default for chat preset fallback
  },
  "actions": [
    { "type": "BLOCK", "metadata": { "customMessage": "Not allowed." } },
    { "type": "ALERT" },
    { "type": "TIMEOUT", "metadata": { "durationSeconds": 3600 } },
    { "type": "MUTE_OVERLAY", "metadata": { "durationSeconds": 3600 } }
  ],
  "exemptChannelIds": ["uuid-of-channel"],
  "exemptRoles": ["discord-role-id"]
}
```

### Trigger Types

| Type | How it evaluates |
|---|---|
| `AI_MODERATION` | Compares the step-1 OpenAI verdict against the targeted-attack category boundary and thresholds. Only a flagged, threshold-breaching category matches; below-threshold and non-target categories are ignored, with no alert-only violation. Harassment also requires an explicit target. Thresholds come from `moderation_settings`, or from `triggerMetadata.thresholds` for a per-rule override; broad categories in either source remain ineligible. Skipped entirely when the verdict is degraded. See [ai-moderation.md](ai-moderation.md). |
| `KEYWORD` | Matches `keyword_filter[]` (wildcard `*` → `.*`) and `regex_patterns[]`; skips if any `allow_list` entry matches. **Always runs**, even while AI is healthy. This is an explicit moderator override and is intentionally context-free. |
| `KEYWORD_PRESET` | Same matching as KEYWORD against the in-code `PRESET_LISTS` (`PROFANITY`, `SEXUAL_CONTENT`, `SLURS`). The default seeded flagged-words rule uses `SLURS` only; generic profanity and sexual-content presets require deliberate admin opt-in. **Skipped while the AI verdict is healthy.** In fallback mode it requires an explicit target unless `require_target: false` is set deliberately. |
| `MENTION_SPAM` | Counts unique `@username` and `<@id>` mentions; triggers if count ≥ `mention_total_limit` |
| `SPAM` | Re-uses the Redis window from step 2 (no duplicate check); effectively a no-op rule at step 4 since step 2 already handled it |
| `LINK` | Finds `https?://` URLs; blocks unless the hostname matches an entry in `allow_list` |

All regex patterns are compiled via `compileUserRegex()` (`backend/src/utils/safeRegex.ts`) which applies ReDoS-protection guards (catastrophic-construct rejection). Invalid or unsafe patterns are skipped.

### Action Types

| Type | Effect |
|---|---|
| `BLOCK` | Sets `result.block = true`; sends WS error with `customMessage`; causes short-circuit |
| `ALERT` | Posts a Discord embed to the mod-log channel via `postModAlert()` |
| `TIMEOUT` | Calls `muteUser(userId, 'system', durationMs, 'AutoMod', ...)` with Discord propagation |
| `MUTE_OVERLAY` | Calls `muteUser(...)` with `skipDiscord=true` — overlay-only mute, no Discord timeout |

A rule can have multiple actions; they all execute unless BLOCK triggers a short-circuit return.

### Exemptions

Per-rule exemptions are applied before evaluation:
- `exemptChannelIds` — if the message's `channelId` is in this array, the rule is skipped
- `exemptRoles` — if the user holds any Discord role in this array, the rule is skipped

### Violation Record

Every triggered rule writes an `automod_violations` row:
```jsonc
{
  "ruleId": "...",
  "userId": "...",
  "channelId": "...",
  "messageContent": "... the ORIGINAL message (capped at 4000 chars) — never the canon match form",
  "matchedKeyword": "the keyword, regex, or AI category that matched",
  "matchedSubstr": "the actual matched substring, or the AI score comparison",
  "actionsTaken": [{ "type": "BLOCK", "success": true }],

  // AI_MODERATION rules only — NULL for every other trigger type
  "aiCategories": { "hate": 0.91, "violence": 0.02, "...": 0.0 },
  "aiMaxScore": 0.91
}
```

`aiMaxScore` is indexed descending (partial index, AI rows only) so the dashboard
can sort the violation queue by severity — the gradation keyword rules never had.
In shadow mode `actionsTaken` is `[{ "type": "SHADOW", "success": true }]` and no
action is executed.

An `audit_logs` row with `action = 'automod_violation'` is also written.

## Cache Invalidation

| Cache | Location | TTL | Invalidation |
|---|---|---|---|
| AI moderation settings | In-process memory | 60 seconds | `invalidateAiModerationCache()` after a settings PATCH |
| AI verdicts | Redis (`aimod:v1:<sha256>`) | 1 hour | none — content-addressed by canonical text hash |
| `automod_rules` | In-process memory | 30 seconds | `invalidateRulesCache()` after rule CRUD |
| `word_filter` | In-process memory | 60 seconds | `resetCache()` after filter CRUD |
| Spam settings | In-process memory | 60 seconds | `invalidateSettingsCache()` after settings change |
| Name blacklist | In-process memory | — (explicit reload) | `refreshBlacklist()` + Redis pub/sub `name-blacklist:updated` |
