# Auto-Moderation

All content moderation on `chat:send` goes through a single entry point: `engineEvaluate()` in `backend/src/services/autoModEngine.ts`. This consolidates the legacy word filter, the Redis spam detector, and the database-driven rule engine into one call so the WS handler never double-blocks.

## Evaluation Order

`engineEvaluate(content, channelId, user)` runs checks in this sequence, short-circuiting on the first `BLOCK` match:

1. **Staff exemption** — `isProtectedTarget(user.id)` is checked first. Moderators, admins, and the owner bypass ALL content moderation. (`autoModEngine.ts:336-343`)

2. **Legacy word filter** — calls `filterContent(content, userId)` from `autoModService.ts`. Checks the hardcoded baseline denylist first, then the `word_filter` DB table.

3. **Legacy spam detection** — calls `detectSpam(userId)` from `autoModService.ts`. Uses a Redis sorted-set sliding window.

4. **AutoMod rules** — evaluates all enabled rows from `automod_rules` in order. Short-circuits on the first BLOCK action.

Any match at step 4 writes an `automod_violations` row and an `audit_logs` row (both fire-and-forget).

## Legacy Word Filter (`autoModService.ts`)

### Baseline Denylist

A hardcoded array of ~40 slurs and explicit terms compiled at startup as word-boundary regexes (`\bphrase\b`, case-insensitive). This list is checked before any DB query and cannot be disabled by admins. It also has a substring-match variant (`BASELINE_DENYLIST_NAMES`) used for identifiers like party names and usernames where slurs may appear without spaces.

Source: `autoModService.ts:15-57`.

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
    "presets": ["PROFANITY", "SLURS"]       // for KEYWORD_PRESET
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
| `KEYWORD_PRESET` | Same matching as KEYWORD against the in-code `PRESET_LISTS` (`PROFANITY`, `SEXUAL_CONTENT`, `SLURS`) |
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
  "messageContent": "... (capped at 4000 chars)",
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
