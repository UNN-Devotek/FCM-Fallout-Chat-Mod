# Kick / Mute / Ban — multi-surface chat moderation

> **Status: implemented.** Kick, mute, ban, unban, and message deletion work across **all three chat surfaces**
> (admin dashboard, desktop overlay, and the new in-game chat.v1 `.ba2`) under the **mandatory
> Discord/Nexus/Steam auth gate** ([authentication](../backend/auth.md),
> [chat.v1 gate](../overlay/zfe/native-chat-relay/fcm-integration.md#mandatory-auth-gate--limited-until-a-provider-linked-fcm-account)).
> The remaining deferred item is per-channel slow mode; it has no FCM primitive and remains unavailable.

## TL;DR

FCM has account-level **kick / mute / ban** with **immediate** enforcement, Discord propagation,
evidence, audit, role gating, and protected-target rules. The auth lockdown makes the **ban target
an account** (`users.id`) tied to Discord, Nexus, and/or Steam — far stronger than the old anonymous/name-
derived identity. chat.v1 re-checks that account per operation and per subscriber keepalive, and
kick/ban fan out over `relay:control` pub/sub so every in-game session is evicted immediately.

---

## 1. What exists today (dashboard + overlay)

All three actions are account-level (keyed on `users.id`) and enforced **immediately** on live
sockets, then re-checked on reconnect and in REST auth.

| Action | Route | Sets | Duration | Live enforcement | Role |
|---|---|---|---|---|---|
| **Kick** | `POST /api/moderation/kicks` | `users.kickedUntil = now+5m` | 5-min cooldown (`KICK_COOLDOWN_MS`) | `notifyAndDisconnect` → `user:kicked` frame + force-close 4002 (`handlers.ts:1135`) | moderator+ |
| **Mute** | `POST /api/moderation/mutes` | `isMuted`, `muteExpiresAt`, `muteReason/Category`, `mutedById` | 60s … **30d** cap (`MAX_MUTE_MS`; Discord slash input is capped at 28d) | `markClientMuted(true)` → `user:muted` frame, send blocked at `ingestMessage.ts:159` (no disconnect) | moderator+ |
| **Unmute** | `DELETE /api/moderation/mutes/:id` | clears mute fields | — | `markClientMuted(false)` → `user:unmuted` | moderator+ |
| **Ban** | `POST /api/moderation/bans` (multipart) | `bans` row + `users.isBanned/bannedUntil/banReason/banCategory`, evidence | temp (`bannedUntil`) or **permanent** (`null`) | `notifyAndDisconnect` → `user:banned` + force-close; **permanent** also revokes `devices`, deny-lists provider IDs (`banned_identities`) + Discord guild-ban | moderator+ |
| **Reverse ban** | `POST /api/moderation/bans/:id/reverse` | `bans.reversedAt/By/Reason`; clears user flags only if this ban was active and no other active ban remains | — | restores Discord roles (`savedDiscordRoles`) + lifts guild ban + lifts the deny-list (permanent) | moderator+ |
| **Delete message** | `DELETE /api/messages/:id` | `messages.is_deleted = true` | — | broadcasts `chat:delete` | moderator+ |

Key properties (all in `moderationActionsService.ts`):

- **Immediate, not next-connect.** Kick/ban → `notifyAndDisconnect` (250 ms grace to render the
  notice, then close 4002). Mute → `markClientMuted` flips `isMuted` on every live socket and the
  send is rejected server-side. All three are **also** checked on `handleConnection`
  (`handlers.ts:1271–1299`) and in REST `requireAuth` (`auth.ts:25–87`) — belt-and-suspenders.
- **Protected targets.** A user holding `moderator`/`admin`/`owner` cannot be kicked/muted/banned
  (`ensureNotProtected` → `ProtectedTargetError` → 409). Staff is detected from the role cache, the
  `admin_users` row, or a staff Discord role in the bot's in-memory member cache (no per-action
  Discord API call). The check fails closed: a lookup error refuses the action
  (`ProtectionCheckFailed`, 503). Error codes: [README](README.md#stable-error-codes).
- **One active ban at a time.** Banning a user who already has an active ban is refused
  (`AlreadyBanned`, 409) instead of adding a duplicate row and overwriting the saved Discord roles.
  Reversing a ban only lifts the user's state when that ban was active and no other active ban
  remains; reversing an already-reversed ban is `BanAlreadyReversed`.
- **Legacy routes share the service.** `POST/DELETE /api/users/:id/{mute,kick,ban}` (dashboard Users
  page, ChatOverlay) call the same service functions, so they get the same protection, records,
  live eviction and Discord propagation. The legacy ban is permanent with the reason as text
  evidence; the legacy unban reverses the user's active ban rows.
- **Evidence required for bans** (≥1 text/image; images in MinIO, magic-byte validated, served
  `nosniff`/`inline`). Evidence is access-scoped: owners/admins see all; other staff see only bans
  they issued (denial = 404, not 403, to avoid an existence oracle).
- **Private confirmation + staff audit.** Every action writes `audit_logs` and a `#vault-security`
  Discord mod-log embed; it does not post a public General-channel system message. Dashboard and
  overlay responses remain private to the acting moderator, and Discord uses ephemeral interaction
  replies. `bans` is the source of truth for history (not the denormalized `users` flags).
- **Discord propagation.** Mute → Discord timeout (≤28d cap); every ban → role-strip + voice
  disconnect; **permanent** ban → also a guild ban. Temporary bans (including the Discord slash-ban
  with a duration) never guild-ban, because a guild ban removes the member and the stripped roles
  could not be restored on expiry; the FCM account ban still blocks chat on every surface.
  Slash-kick removes the member from the guild. Reverse/expiry restores roles and lifts any guild
  ban. The 5-minute `sweepExpired` cron also restores roles for temp bans that the auth/link/WS
  paths cleared lazily (within 7 days of expiry). HUD/in-game moderation calls the same service, so
  it receives the same propagation and audit behavior.

The **FCMHUD/1** in-game path uses `HudIdentityBlock` (keyed on
`identityHash = HMAC(secret, fo76AccountName)`) checked at `HELLO` (ban → destroy socket) and `SEND`
(mute/ban → drop) — **active now** (we ship on FCMHUD/1, #302). It is superseded by account-level
checks **later** when chat.v1 lands ([R7](../overlay/zfe/native-chat-relay/fcm-integration.md)); see §6.

See [README](README.md), [automod](automod.md), [reports-and-evidence](reports-and-evidence.md).

---

## 2. The ban target under the auth lockdown

With the [mandatory Discord/Nexus/Steam gate](../overlay/zfe/native-chat-relay/fcm-integration.md#mandatory-auth-gate--limited-until-a-provider-linked-fcm-account),
**every chat participant is a real, bannable account.** This sharpens moderation:

- **Target = `users.id`** (the account), which links Discord, Nexus (`linked_identities`), and/or Steam and
  the device/install token. One ban flag on the account blocks **all** surfaces at once.
- **Provider-ID deny-list (`banned_identities`, #297).** A **permanent** ban also deny-lists the
  account's external **Discord (`discord` = `users.discord_id_link`), Steam (`steam` = valid
  `users.steam_id`), and Nexus/other linked IDs (`linked_identities.provider/provider_uid`)**, with
  `reason = "ban:<banId> <category>"`. Checked at the **auth/link gate**: dashboard/`/link` Discord
  sign-in (`/auth/discord/callback`), overlay Discord link (`/auth/discord/link/callback`), profile
  Discord link, Steam callback, Nexus OAuth callback and MCP role resolution. The device-code
  redemption requires one of those sessions. This makes the ban **durable** — it survives
  FCM-account deletion and blocks re-linking the **same** provider to a fresh FCM account. The
  strongest evasion lever (§5). Reversing the permanent ban (with no other unreversed permanent ban
  left) removes those rows. A failed deny-list write is logged and does not undo the account ban.
- **Historical `HudIdentityBlock` records** remain in the database for moderation
  history. Current relay moderation uses authenticated account IDs.
- **No anonymous chat.** A bare chat.v1 `register` is *limited* and can't send until linked — so a
  banned account can't even participate without a fresh provider account (§5).

---

## 3. Enforcing on chat.v1 sessions

The chat.v1 relay is a **separate front-end** (`/relay`) from the overlay's `/ws`, and the backend
runs multiple instances — so a dashboard action must reach the offender's in-game socket on any
instance. Relay sessions use a dedicated Redis control signal so the close reaches every instance:

**1. Immediate relay eviction.** A ban or kick updates account state, closes local linked
subscribers, and publishes an `evict` message on `relay:control` so subscribers on other instances
also receive `user_banned` or `user_kicked` before their socket closes. The subscriber keepalive
re-checks the account as a fallback if a control message is missed.

**2. Per-operation state checks.** `hello`, `getAuthState`, `send`, `poll`, `report`, and
`subscribe` re-check `isBanned` / `kickedUntil` on the linked account. This blocks sending and
reconnect immediately, while temporary bans and kicks auto-expire without a re-link. Mutes remain
send-only restrictions and return `user_muted`.

**3. Token revocation — permanent ban / account deletion only.** Additionally clear/rotate the relay
token so the saved DPAPI token is dead (`hello` → `auth_token_revoked`; ZFE won't auto-register around
it). **Do NOT revoke for temp ban/kick/mute** — those must auto-resume via the existing device-code
link, not force a re-link. (Mute is never a revocation — the user stays authed, just can't `send`.)

**Action → chat.v1 mapping:**

| Action | chat.v1 effect | Reuses |
|---|---|---|
| Kick | close `subscribe` socket; reject `hello`/`send` until `kickedUntil` (then auto-clears) | `kickUser`, `kickedUntil` |
| Mute | `send` → `user_muted` until `muteExpiresAt` | `muteUser`, `ingestMessage` mute check |
| Ban (temp/perm) | close socket; `register`/`hello`/`send` → `user_banned` | `createBan`, `requireAuth` ban check |
| Unban / unmute | normal access resumes on next op / reconnect | `reverseBan`, `unmuteUser` |
| Delete message | relay omits the message from later `poll`/history (already filtered `isDeleted=false`); the acting HUD removes its selected row immediately and connected dashboard/overlay clients receive `chat:delete` | shared message-deletion service |

---

## 4. Who can moderate, and from where

- **Role gating is unchanged:** kick/mute/ban/delete require **moderator+** (`requireDiscordRole`),
  and elevated roles resolve **only via a linked Discord identity** (#168) — a Nexus-only account is
  a basic user and can never moderate.
- **Primary surface = the dashboard.** That's where mods act (with evidence upload, ban forms, the
  report queue). Those actions propagate to in-game via the §3 eviction signal.
- **In-game `moderationAction` (chat.v1 op)** is honored **only** for an identity linked to a staff
  Discord account; an unlinked/basic identity gets `permission_denied`. It maps to the same
  `moderationActionsService` calls. The HUD lets staff type an exact visible player name (quote
  multi-word names) or use a visible message reference. It resolves that convenience input locally
  to immutable record IDs; duplicate visible names are rejected rather than selecting a player. The
  authoritative surface stays the dashboard.
- **Desktop overlay context menu.** Kick and Mute use the moderator WebSocket frames (`mod:kick`,
  `mod:mute`). **Ban** opens the website ban form (evidence upload) through `banFormUrl()`, which
  prefixes the relay HTTP base. The packaged overlay renders from a local file, so a bare
  `/moderation/bans/new` link would resolve to `file://` and open nothing.
- **Target names.** Accounts linked through Steam/HUD without Discord keep a synthetic
  `pending-*` username. Moderation embeds, Discord `/moderate` labels and replies, the ban form,
  ban lists and profiles resolve the chat-visible name instead: chat name, real FO76 username,
  Steam name, Discord name, then stored FO76 account/character name
  (`backend/src/utils/userDisplayName.ts`, mirrored in `admin-dashboard/src/utils/userDisplayName.ts`).
  The ban-form lookup (`GET /api/moderation/users/lookup`) searches all of those fields.
- **In-game `banUser` carries text evidence.** An in-game ban (from a staff-Discord-linked identity)
  applies immediately through the same ban service and stores the bounded reason as a text evidence
  item. The dashboard remains the authoritative place to add richer evidence or reverse the ban.
- **Reports** flow in from any surface: chat.v1 `report` and the HTTP report path persist into the
  same `reports` moderation queue; the relay also enforces its own per-account rate and duplicate
  guards before writing.

---

## 5. Ban evasion in the gated world

The lockdown is the main anti-evasion lever — but it's not absolute. Honest picture:

- **Strong:** a ban hits the account; permanent bans also **revoke the device** (`installToken`) and
  apply a **Discord guild ban**.
- **Strongest — provider-ID deny-list (#297):** a permanent ban deny-lists the account's Discord,
  Steam and Nexus IDs at the **auth/link gate**, so the **same** provider account can never authenticate to FCM
  again — even on a new FCM account, even after the original is deleted. To evade, the user needs a
  **brand-new** Nexus, Steam, or Discord account (the highest-cost path; Nexus carries mod-download
  history/reputation).
- **Residual:** a fresh provider account still works (fundamental — the deny-list keys on *known*
  IDs). Stacked mitigations: device-key revocation, the `register`-limited gate (can't chat before
  linking), per-IP connection caps, the FO76-name claim + presence cross-check,
  and report-driven review. The
  `worldId`-spoofing hardening (#293/#294) is a related, separate track.
- **Recommendation:** keep bans account-level (not identity-hash-only), always revoke the device on
  permanent bans, and surface "new account, same FO76 name / same device fingerprint" signals to
  the mod dashboard for review rather than auto-blocking (avoids false positives).

---

## 6. Deprecation: `HudIdentityBlock` → account bans

Because chat.v1 identity **is** the authed account, the old `HudIdentityBlock` (name-derived,
FCMHUD/1) is no longer the moderation key. Two options:

- **Recommended:** retire `HudIdentityBlock` as a separate gate; the relay checks `user.isBanned` /
  `user.isMuted` (account flags) on `hello`/`send`, same as `/ws`. Simpler, one source of truth.
- **Optional optimization:** keep a `HudIdentityBlock`-style table **rekeyed to `userId`** as a fast
  in-relay deny-list cache, refreshed from the account flags — only if profiling shows the per-op
  account lookup is hot.

The name-derived `HUD_IDENTITY_SECRET` was retired with the generic-socket transport.

---

## 7. Slow-mode — still a gap

chat.v1's `moderationAction` lists `setSlowMode`, but **FCM has no slow-mode primitive** (only the
global `ws_rate:<userId>` 5 msg/sec window). Until built, advertise `canSetSlowMode:false` and reject
`setSlowMode` with `permission_denied`/`invalid_action`. If built later, it's **per-channel** (e.g.
`channel_slow_mode` with a min-interval), applied in the rate-limit check — it would benefit the
overlay/dashboard too. Tracked alongside the ZFE-coordination follow-ups (fcm-integration #292 / the
chat.v1 moderation issue #288).

---

## 8. Recommendations summary

1. **Reuse the account-level machinery** (kick/mute/ban + evidence + audit + Discord propagation) —
   don't fork it for chat.v1.
2. **Enforce on chat.v1 via account-state re-checks** (per-op + subscriber keepalive), a
   cross-instance `relay:control` eviction signal, and **token revocation for permanent
   bans/deletion only** (#296).
3. **Keep the ban target = account `userId`**; rekey `identityHash` to `userId`; retire
   `HudIdentityBlock` as a separate gate.
4. **Gate in-game `moderationAction` on a staff Discord link**; dashboard stays the authoritative
   moderation surface.
5. **Always revoke the device + Discord-lockdown on permanent bans**; surface evasion signals to the
   dashboard rather than auto-blocking.
6. **Slow-mode** stays a deferred, per-channel feature.
7. **Deny-list external provider IDs on permanent bans** (`banned_identities`, checked at the
   auth/link gate; #297) — durable, account-independent, blocks re-linking the same Discord/Nexus/Steam identity.
   The strongest evasion lever.

## Implementation issues

| Issue | What |
|---|---|
| **#163** | Epic — multi-provider identity & account linking (Discord + Nexus + Steam) |
| **#282** | Epic — ZFE chat.v1 native chat relay |
| **#295** | Mandatory auth gate + in-game device-code link (limited-until-linked; link-code/revocation specs) |
| **#288** | chat.v1 `report` + `moderationAction` mapping + permissions (staff-Discord-gated) |
| **#296** | Enforce bans/kicks/mutes on chat.v1 live sockets — cached status re-check + token revoke (permanent); `moderation:evict` pub/sub deferred |
| **#297** | Provider-ID ban deny-list (`banned_identities`) — durable bans at the auth/link gate |

## See also

- [README](README.md) · [automod](automod.md) · [reports-and-evidence](reports-and-evidence.md)
- [authentication](../backend/auth.md)
- [chat.v1 integration — auth gate + moderationAction mapping](../overlay/zfe/native-chat-relay/fcm-integration.md)
