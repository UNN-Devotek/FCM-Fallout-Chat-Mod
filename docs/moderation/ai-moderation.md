# AI Content Moderation (OpenAI Moderation API)

FCM classifies chat messages, usernames, and party names with the
[OpenAI Moderation API](https://developers.openai.com/api/docs/guides/moderation)
(`omni-moderation-latest`). While enabled and reachable it is the **primary
content check**, but chat enforcement is deliberately narrow: only high-confidence
targeted attacks are eligible. Ordinary profanity, sexual discussion, self-harm,
violence, and Fallout gameplay language are not chat violations by themselves.
The hand-maintained keyword denylists are demoted to an offline fallback while AI
is enforcing; shadow mode keeps them active so calibration cannot weaken existing
moderation.

Service: `backend/src/services/aiModerationService.ts`.
Wiring: `engineEvaluate()` in `backend/src/services/autoModEngine.ts`.

## Why

Keyword lists have a structural ceiling. They cannot distinguish *"I'm going to
kill you"* aimed at a player from *"I'm going to kill that Scorchbeast"*, they
need hand-editing in two places that must stay in sync (issue #198), and they
carry no severity — the only gradation available was which actions a rule had.
The classifier understands context and evasion, needs no list maintenance,
returns 13 categories each with a 0–1 confidence score, and is free to use.

## Evaluation order

`engineEvaluate()` runs:

| Step | Check | Runs when |
|---|---|---|
| 0 | Staff exemption (`isProtectedTarget`) | always, **first** |
| 1 | AI classification | `ai_moderation_enabled = true` |
| 2 | Legacy `word_filter` + baseline denylist | when step 1 is degraded or AI is shadowing |
| 3 | Redis spam sliding-window | always |
| 4 | `automod_rules` loop | always |

Within step 4:

- `AI_MODERATION` rules consume the step-1 verdict — **no second API call**.
  Only flagged, threshold-breaching categories in the targeted-attack policy
  can match. A below-threshold flag or a category outside that policy produces
  no violation and no alert.
- `KEYWORD_PRESET` rules are **skipped only while the AI verdict is healthy and
  mode is `enforce`**. These are the curated `PROFANITY` / `SEXUAL_CONTENT` /
  `SLURS` lists the classifier replaces. In degraded or `shadow` mode they remain
  active and require an explicit target by default.
- `KEYWORD` rules **always run**. Admin-authored keyword rules are a moderator's
  escape hatch for terms the classifier misses (a specific troll, targeted
  harassment of a named player), so they are deliberately not superseded.
- `MENTION_SPAM`, `LINK`, and `SPAM` always run. The moderation endpoint
  classifies *harmful content* only — it has no concept of message rate, mention
  floods, or scam links, so those triggers are not part of the keyword retirement.

## Chat policy: targeted attacks only

The chat threshold map is a hard policy boundary, not just a set of defaults.
Global settings and per-rule threshold overrides cannot re-enable categories that
are outside this list:

| Category | Default threshold | Target requirement |
|---|---:|---|
| `hate/threatening` | 0.90 | Category is inherently group-directed |
| `harassment/threatening` | 0.90 | Explicit person/mention target |
| `hate` | 0.95 | Category is inherently group-directed |
| `harassment` | 0.95 | Explicit person/mention target |

Harassment requires an explicit address: `you`, `your`, `u`, `ur`, an `@handle`,
or a Discord `<@snowflake>` mention. A player name without `@` is not inferred as
a target because chat messages do not carry a reliable roster. This is an
intentional precision tradeoff; moderators can add a specific `KEYWORD` rule for
a known named target when needed.

Categories such as `sexual`, `sexual/minors`, `violence`, `violence/graphic`,
`self-harm`, and `illicit` are ignored by the chat AI rule. This keeps messages
such as “that deathclaw hit hard”, “I killed 40 Scorched”, and ordinary cussing
out of the targeted-attack queue. A category that is flagged but below its
threshold is also ignored entirely — it is not an alert-only violation.

## Fail-open

Every failure path returns `null`, which the engine reads as **degraded** and
handles by falling back to the keyword layers. The built-in chat baseline and
`KEYWORD_PRESET` fallback are target-gated by default; explicit admin-authored
`word_filter` rows and `KEYWORD` rules remain broad overrides. `null` is never
treated as a clean verdict. Degradation causes:

- integration disabled, or `OPENAI_API_KEY` unset
- request timeout (800 ms chat / 3000 ms identifiers)
- non-200 response
- malformed or oversized body
- circuit breaker open

**Circuit breaker.** After 5 consecutive failures the service stops calling out
for 60 s. Without it, an OpenAI outage would add the full timeout to *every*
message. The first transition into a degraded state posts one mod-log embed
("AI moderation degraded"), debounced for 15 minutes, so staff know enforcement
has fallen back to keywords.

## Configuration

### Environment

`OPENAI_API_KEY` in `backend/src/config/environment.ts`. **Deliberately absent
from the production startup guard** — a missing key must degrade to the fallback,
not refuse to boot.

### Runtime settings (`moderation_settings` table)

Editable in the dashboard under **Auto-Moderation → SETTINGS**, or via
`PATCH /api/moderation/settings`. All are cached in-process for 60 s and busted
on write by `invalidateAiModerationCache()`.

| Key | Default | Meaning |
|---|---|---|
| `ai_moderation_enabled` | `false` | **Kill switch.** `false` reverts to keyword-only instantly, no deploy |
| `ai_moderation_mode` | `shadow` | `shadow` = log only, never acts. `enforce` = block at/above threshold |
| `ai_moderation_thresholds` | (defaults below) | JSON, category → score, for chat |
| `ai_moderation_identifier_thresholds` | (defaults below) | JSON, category → score, for usernames/party names |

Anything other than the exact string `enforce` leaves the mode in `shadow` — the
safe default. Threshold entries outside `(0, 1]` are dropped; malformed JSON
falls back to the built-in defaults.

**Shadow mode is strictly side-effect-free**: no BLOCK, no ALERT, no
TIMEOUT/MUTE. It records an `automod_violations` row with
`actionsTaken = [{ type: 'SHADOW' }]` so thresholds can be calibrated against
real traffic before enforcement is switched on.

### Default thresholds

A category listed in the Chat column blocks at or above its score when the target
condition is satisfied. A category marked **ignored** cannot create an AI chat
match, regardless of a runtime threshold override. Below-threshold and ignored
categories are not recorded as alert-only violations.

| Category | Chat | Identifiers |
|---|---|---|
| `sexual/minors` | ignored | 0.30 |
| `hate/threatening` | 0.90 | 0.40 |
| `harassment/threatening` | 0.90 | 0.50 |
| `hate` | 0.95 | 0.50 |
| `self-harm/instructions` | ignored | 0.50 |
| `harassment` | 0.95 + explicit target | 0.70 |
| `sexual` | ignored | 0.60 |
| `violence/graphic` | ignored | 0.80 |
| `violence`, `illicit`, `illicit/violent`, `self-harm`, `self-harm/intent` | ignored | ignored |

> **Why violence and illicit are not enforced.** FCM is chat for a game about
> violence. "Nuking your camp", "killed 40 Scorched", and chem crafting are
> ordinary Fallout vocabulary that these categories score highly. Enforcing them
> would block normal play talk. This is the single most important calibration
> decision in the integration — change it only with real traffic data.

Identifiers use a lower, wider set: usernames and party names are permanent and
public, so the bar is stricter than for a message that scrolls past. The Chat
column does not change identifier moderation.

## Identifiers are additive, not superseding

On chat, a healthy AI verdict in `enforce` mode supersedes the built-in keyword
layers; `shadow` mode keeps those layers active while recording AI calibration data.
`findProhibitedPhrase()`
(`autoModService.ts`) does **not** work that way — `BASELINE_IDENTIFIER_DENYLIST_PHRASES`
keeps running regardless, with the AI screen appended after it. Registration and
party-rename are low-volume so the list costs nothing, and a slur in a permanent
public username is far more damaging than one in chat. A rejection from the AI
layer returns the phrase `ai:<category>`.

The rollout removes only the exact legacy literal `word_filter` rows `fuck`, `shit`,
`bastard`, and `assh`; regex rules and other entries are left alone. The remaining table and
admin-authored `KEYWORD` rules are deliberate moderator overrides and still match without an
explicit target. If production contains other generic profanity in either layer, it must be
removed, put in test mode, or disabled separately; changing the AI policy does not rewrite those
rows.

## Severity

`automod_violations` gained two nullable columns (migration
`20260803120000_ai_moderation`):

- `ai_categories` (JSONB) — the full category → score map, so a moderator sees
  exactly why a rule fired
- `ai_max_score` (double) — peak score, indexed descending (partial index) for
  sorting the violation queue by severity

Both are `NULL` for every non-AI trigger type. The dashboard renders `ai_max_score`
as a **Score** column; hovering shows the full breakdown.

## Privacy

**What is sent:** the message or identifier text only, capped at 4000 characters.
**What is not sent:** username, user ID, channel, Discord ID, IP — nothing else
leaves the system.

- **Staff content is never transmitted.** The `isProtectedTarget()` exemption at
  step 0 short-circuits before classification runs.
- **Verdicts are cached in Redis** under `aimod:v1:<sha256>` for 1 hour. The key
  is a SHA-256 of the `canon()`-normalised text — the message itself is not
  stored in the cache key, and repeated text costs one Redis GET rather than a
  round-trip. This also means the existing combining-diacritic defense applies to
  the cache.
- OpenAI states that inputs to the moderation endpoint are not used to train
  their models. Verify current terms at
  <https://openai.com/policies/api-data-usage-policies> before enabling.
- **To stop all transmission immediately:** set `ai_moderation_enabled` to
  `false` in the dashboard. No deploy, no restart. Clearing `OPENAI_API_KEY` has
  the same effect from the next process start.

> **Prerequisite.** This is a third-party disclosure and the site currently has
> no privacy policy page. Publish one covering this before enabling on prod.

## Rollout

1. **Dev, shadow.** Deploy to the `fcm-dev` stack with `ai_moderation_enabled=true`
   and `ai_moderation_mode=shadow`. Let QA testers generate traffic.
2. **Calibrate.** Review `GET /api/moderation/automod-violations` sorted by
   `ai_max_score`. Tune thresholds against real FCM chat — especially anything
   that would have blocked ordinary raid/PvP/trading talk.
3. **Dev, enforce.** Flip `ai_moderation_mode=enforce` on dev and confirm.
4. **Prod.** Ship disabled. Enable in shadow, review, then enforce.

**Before enabling:** confirm the OpenAI org's usage tier. New accounts are
reported to cap the moderation endpoint near 10k requests/day; Tier 2 lifts that
to roughly 500 RPM with no daily cap. Check peak FCM message volume against
whichever tier the key sits in.

## Rate limits and cost

The moderation endpoint is free to use. Volume is reduced by the 1-hour Redis
verdict cache and by the step-0 staff exemption. Rate-limit responses (429) are
treated like any other non-200: degrade, fall back, open the breaker after five
in a row.

## Tests

| Suite | Covers |
|---|---|
| `backend/tests/aiModerationService.test.js` | response parsing, threshold boundaries, timeout/non-200/malformed → null, disabled → no fetch, cache hit, canonical cache key, circuit breaker, identifier screening |
| `backend/tests/autoModEngineAi.test.js` | targeted-category boundary, explicit-target harassment, ignored game/profanity categories, AI supersedes/falls back, staff never transmitted, shadow side-effect-freedom, violation fields, exemptions, spam unaffected |
| `backend/tests/autoModEnginePresetBoundary.test.js` | target-gated preset fallback, targeted sexual/slur cases, preset stand-down when AI is healthy and enforcing, and preservation during shadow mode |

## EULA

Entirely backend-side. Touches no game process, memory, or file, so it stays on
the EULA-safe track. It applies equally to messages arriving from the in-game HUD
mod, since `ingestMessage.ts` and `relayHandler.ts` already route through
`engineEvaluate()`.
