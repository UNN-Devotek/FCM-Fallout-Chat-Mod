# Auto-Moderation

All content moderation on `chat:send` goes through a single entry point: `engineEvaluate()` in `backend/src/services/autoModEngine.ts`. This consolidates the legacy word filter, the Redis spam detector, and the database-driven rule engine into one call so the WS handler never double-blocks.

## Evaluation Order

`engineEvaluate(content, channelId, user)` runs checks in this sequence, short-circuiting on the first `BLOCK` match:

1. **Staff exemption** — `isProtectedTarget(user.id)` is checked first. Moderators, admins, and the owner bypass ALL content moderation. (`autoModEngine.ts:336-343`)

2. **Legacy word filter** — calls `filterContent(content, userId)` from `autoModService.ts`. Checks the hardcoded chat baseline denylist first, then the `word_filter` DB table.

3. **Legacy spam detection** — calls `detectSpam(userId)` from `autoModService.ts`. Uses a Redis sorted-set sliding window.

4. **AutoMod rules** — evaluates all enabled rows from `automod_rules` in order. Short-circuits on the first BLOCK action.

Any match at step 4 writes an `automod_violations` row and an `audit_logs` row (both fire-and-forget).

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

`autoModService.ts` keeps three hardcoded baseline lists:

- `BASELINE_CHAT_DENYLIST_PHRASES` — **unambiguous** hate speech / slurs plus a small set of severe abuse terms (`pedo`, `pedophile`, `rape`, `rapist`). Always blocks, in chat **and** in identifiers.
- `CONTEXT_AMBIGUOUS_PHRASES` — terms that are slurs when aimed at a person but ordinary words in almost all game chat: `cracker`, `oreo`, `slant`, `redskin`, `ho`, `sissy`, `bitch`. These **do not block chat**, but they **do** block identifiers.
- `BASELINE_IDENTIFIER_DENYLIST_PHRASES` — used by `findProhibitedPhrase()` for usernames / party names. Spreads in *both* lists above, then adds explicit profanity (`fuck`, `shit`, `cock`, …) that chat allows.

**The governing policy: cussing is fine, targeting people is not.**

Ordinary profanity (`fuck`, `shit`, `damn`, `ass`, `bastard`) is intentionally **not** in the chat baseline, so common cussing is never hard-blocked before the rule engine runs.

Context-ambiguous terms were moved out of the chat baseline because word-boundary matching cannot distinguish `graham cracker` (a real Fallout food item), `the wall is slanted`, `redskin potatoes`, `heave ho`, or `this quest is a bitch` from a targeted insult — and hard-blocking them was the dominant source of false positives. Targeted harassment using those words is still actionable through reports and normal moderation; it is simply no longer auto-blocked on the word alone.

> **Do not "simplify" `BASELINE_IDENTIFIER_DENYLIST_PHRASES` by dropping the `...CONTEXT_AMBIGUOUS_PHRASES` spread.** That spread is the only thing keeping those terms blocked in usernames and party names, where there is no innocent context. `tests/autoModService.test.js` has regression cases that fail if it is removed.

Listed slur and hate-speech terms still block normally. This does not try to solve every deliberate slur-evasion variant.

### `word_filter` Table

Admin-configurable phrases/regexes managed via the dashboard. Cached in memory for 60 seconds; a generation counter prevents stale cache writes from in-flight fetches (`autoModService.ts:54-58`).

Each entry has:
- `phrase` — the string or regex pattern
- `is_regex` — if true, compiled via `compileUserRegex()` (ReDoS guards applied; max length 500 chars)
- `test_mode` — if true, the match is logged to `audit_logs` as `auto_mod_test_match` but the message is NOT blocked

`filterContent()` blocks on any non-test-mode match. `findProhibitedPhrase()` is a stricter variant for identifiers that blocks even on test-mode entries.

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
    "presets": ["SEXUAL_CONTENT", "SLURS"]  // default seeded KEYWORD_PRESET
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
| `KEYWORD` | Matches `keyword_filter[]` (wildcard `*` → `.*`) and `regex_patterns[]`; skips if any `allow_list` entry matches |
| `KEYWORD_PRESET` | Same matching as KEYWORD against the in-code `PRESET_LISTS` (`PROFANITY`, `SEXUAL_CONTENT`, `SLURS`). The default seeded flagged-words rule now uses `SEXUAL_CONTENT + SLURS`, not `PROFANITY`. |
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
  "matchedKeyword": "the keyword or regex that matched",
  "matchedSubstr": "the actual matched substring",
  "actionsTaken": [{ "type": "BLOCK", "success": true }]
}
```

An `audit_logs` row with `action = 'automod_violation'` is also written.

## Cache Invalidation

| Cache | Location | TTL | Invalidation |
|---|---|---|---|
| `automod_rules` | In-process memory | 30 seconds | `invalidateRulesCache()` after rule CRUD |
| `word_filter` | In-process memory | 60 seconds | `resetCache()` after filter CRUD |
| Spam settings | In-process memory | 60 seconds | `invalidateSettingsCache()` after settings change |
| Name blacklist | In-process memory | — (explicit reload) | `refreshBlacklist()` + Redis pub/sub `name-blacklist:updated` |
