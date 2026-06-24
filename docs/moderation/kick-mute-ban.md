# Kick / Mute / Ban — multi-surface chat moderation

> **Status: research + design.** How kick, mute, and ban work across **all three chat surfaces**
> (admin dashboard, desktop overlay, and the new in-game chat.v1 `.ba2`) under the **mandatory
> Nexus/Discord auth gate** ([auth lockdown](../backend/hud-chat-auth-design.md),
> [chat.v1 gate](../overlay/zfe/native-chat-relay/fcm-integration.md#mandatory-auth-gate--limited-until-nexusdiscord-linked-locked)).
> The existing dashboard/overlay machinery is **already built**; the net-new work is wiring it into
> the chat.v1 relay and making eviction cross-surface. Existing behavior is cited by `file:line`;
> proposed behavior is marked **(proposed)**.

## TL;DR

FCM already has account-level **kick / mute / ban** with **immediate** enforcement, Discord
propagation, evidence, audit, role gating, and protected-target rules. The auth lockdown makes the
**ban target an account** (`users.id`) tied to Nexus and/or Discord — far stronger than the old
anonymous/name-derived identity. To extend it to chat.v1 the relay just needs a **cached status
re-check** (per-op + per-keepalive) plus **token revocation for permanent bans** (#296) — that cuts
send and read cross-instance without new infra; a dedicated eviction pub/sub signal is **deferred**.

---

## 1. What exists today (dashboard + overlay)

All three actions are account-level (keyed on `users.id`) and enforced **immediately** on live
sockets, then re-checked on reconnect and in REST auth.

| Action | Route | Sets | Duration | Live enforcement | Role |
|---|---|---|---|---|---|
| **Kick** | `POST /api/moderation/kicks` | `users.kickedUntil = now+5m` | 5-min cooldown (`KICK_COOLDOWN_MS`) | `notifyAndDisconnect` → `user:kicked` frame + force-close 4002 (`handlers.ts:1135`) | moderator+ |
| **Mute** | `POST /api/moderation/mutes` | `isMuted`, `muteExpiresAt`, `muteReason/Category`, `mutedById` | 60s … **30d** cap (`MAX_MUTE_MS`) | `markClientMuted(true)` → `user:muted` frame, send blocked at `ingestMessage.ts:159` (no disconnect) | moderator+ |
| **Unmute** | `DELETE /api/moderation/mutes/:id` | clears mute fields | — | `markClientMuted(false)` → `user:unmuted` | moderator+ |
| **Ban** | `POST /api/moderation/bans` (multipart) | `bans` row + `users.isBanned/bannedUntil/banReason/banCategory`, evidence | temp (`bannedUntil`) or **permanent** (`null`) | `notifyAndDisconnect` → `user:banned` + force-close; **permanent** also revokes `devices` + Discord guild-ban | moderator+ |
| **Reverse ban** | `POST /api/moderation/bans/:id/reverse` | `bans.reversedAt/By/Reason`, clears user flags | — | restores Discord roles (`savedDiscordRoles`) + lifts guild ban | moderator+ |
| **Delete message** | `DELETE /api/messages/:id` | `messages.is_deleted = true` | — | broadcasts `chat:delete` | moderator+ |

Key properties (all in `moderationActionsService.ts`):

- **Immediate, not next-connect.** Kick/ban → `notifyAndDisconnect` (250 ms grace to render the
  notice, then close 4002). Mute → `markClientMuted` flips `isMuted` on every live socket and the
  send is rejected server-side. All three are **also** checked on `handleConnection`
  (`handlers.ts:1271–1299`) and in REST `requireAuth` (`auth.ts:25–87`) — belt-and-suspenders.
- **Protected targets.** A user holding `moderator`/`admin`/`owner` cannot be kicked/muted/banned
  (`ensureNotProtected` → `ProtectedTargetError` → 409).
- **Evidence required for bans** (≥1 text/image; images in MinIO, magic-byte validated, served
  `nosniff`/`inline`). Evidence is access-scoped: owners/admins see all; other staff see only bans
  they issued (denial = 404, not 403, to avoid an existence oracle).
- **Audit + announce.** Every action writes `audit_logs`, posts a General-channel system message,
  and a `#vault-security` Discord mod-log embed. `bans` is the source of truth for history (not the
  denormalized `users` flags).
- **Discord propagation.** Mute → Discord timeout (≤28d cap); permanent ban → role-strip + guild
  ban; reverse → restore roles. HUD/in-game moderation has **no** Discord propagation yet.

The old **FCMHUD/1** in-game path used `HudIdentityBlock` (keyed on
`identityHash = HMAC(secret, fo76AccountName)`) checked at `HELLO` (ban → destroy socket) and `SEND`
(mute/ban → drop). That bridge is **deprecated** ([R7](../overlay/zfe/native-chat-relay/fcm-integration.md));
see §6 for what replaces it.

See [README](README.md), [automod](automod.md), [reports-and-evidence](reports-and-evidence.md).

---

## 2. The ban target under the auth lockdown

With the [mandatory Nexus/Discord gate](../overlay/zfe/native-chat-relay/fcm-integration.md#mandatory-auth-gate--limited-until-nexusdiscord-linked-locked),
**every chat participant is a real, bannable account.** This sharpens moderation:

- **Target = `users.id`** (the account), which links Discord and/or Nexus (`linked_identities`) and
  the device/install token. One ban flag on the account blocks **all** surfaces at once.
- **`identityHash` rekey** (per [auth design §3.3](../backend/hud-chat-auth-design.md)):
  `HMAC(HUD_IDENTITY_HASH_SECRET, userId)` — account-derived, not name-derived, so it's unforgeable
  and survives renames. `HudIdentityBlock` (if kept as a fast relay-side check) keys on this.
- **No anonymous chat.** A bare chat.v1 `register` is *limited* and can't send until linked — so a
  banned account can't even participate without a fresh provider account (§5).

---

## 3. Enforcing on chat.v1 sessions

The chat.v1 relay is a **separate front-end** (`/relay`) from the overlay's `/ws`, and the backend
runs multiple instances — so a dashboard action must reach the offender's in-game socket on any
instance. The simplest mechanism that does this needs **no dedicated cross-instance signal** (#296):

**1. Cached status re-check (the backbone).** The relay re-checks `isBanned` / `kickedUntil` /
`isMuted` from a **short-TTL cache** (Redis `relay:status:<userId>`, ~10–15s) on every `hello` and
`send`. A dashboard action propagates to every instance within the TTL. This blocks **sending**
immediately and **reconnect** outright, and **auto-expires** — a temp ban/kick/mute resumes with no
re-link. Rejections: `user_banned` / `user_muted` / kick-cooldown.

**2. Token revocation — permanent ban / account deletion only.** Additionally clear/rotate the relay
token so the saved DPAPI token is dead (`hello` → `auth_token_revoked`; ZFE won't auto-register around
it). **Do NOT revoke for temp ban/kick/mute** — those must auto-resume via the existing device-code
link, not force a re-link. (Mute is never a revocation — the user stays authed, just can't `send`.)

**3. Live read stream.** A long-lived `subscribe` socket is authed once, so revocation alone doesn't
stop it reading. The relay checks the cached flag **before each pushed `event` and on each ~10 s
keepalive ping**; if banned/kicked it closes the socket → read is cut within ~one keepalive interval.
Public channels are readable by anyone anyway (a banned user briefly reading `global` ≈ an anonymous
website visitor), so sub-second read-cutoff isn't worth extra infra at v1.

> **Why not a dedicated `moderation:evict` pub/sub signal?** It would give *sub-second* active
> disconnect, but the cached-flag re-check above already cuts send (per-op) and read (per-keepalive,
> ~10 s) cross-instance with far less machinery. The pub/sub signal is **deferred** (#296) — worth it
> only once **private channels (party/clan, #182)** need instant read-cutoff, or for polished kick UX.

**Action → chat.v1 mapping:**

| Action | chat.v1 effect | Reuses |
|---|---|---|
| Kick | close `subscribe` socket; reject `hello`/`send` until `kickedUntil` (then auto-clears) | `kickUser`, `kickedUntil` |
| Mute | `send` → `user_muted` until `muteExpiresAt` | `muteUser`, `ingestMessage` mute check |
| Ban (temp/perm) | close socket; `register`/`hello`/`send` → `user_banned` | `createBan`, `requireAuth` ban check |
| Unban / unmute | normal access resumes on next op / reconnect | `reverseBan`, `unmuteUser` |
| Delete message | relay should **omit** the message from `poll`/history (already filtered `isDeleted=false`); live in-game removal needs a ZFE `chat.delete` event (gap, see fcm-integration) | `messagesController.deleteMessage` |

---

## 4. Who can moderate, and from where

- **Role gating is unchanged:** kick/mute/ban/delete require **moderator+** (`requireDiscordRole`),
  and elevated roles resolve **only via a linked Discord identity** (#168) — a Nexus-only account is
  a basic user and can never moderate.
- **Primary surface = the dashboard.** That's where mods act (with evidence upload, ban forms, the
  report queue). Those actions propagate to in-game via the §3 eviction signal.
- **In-game `moderationAction` (chat.v1 op)** is honored **only** for an identity linked to a staff
  Discord account; an unlinked/basic identity gets `permission_denied`. It maps to the same
  `moderationActionsService` calls. Realistically a convenience for staff who are in-game; the
  authoritative surface stays the dashboard. (`banUser` from in-game needs a no-evidence service
  variant or a "pending-evidence" ban the mod completes on the dashboard.)
- **Reports** flow in from any surface: chat.v1 `report` op → `reportsController.createReport`
  → the same moderation queue.

---

## 5. Ban evasion in the gated world

The lockdown is the main anti-evasion lever — but it's not absolute. Honest picture:

- **Strong:** a ban hits the account; to evade, a user needs a **new Nexus or Discord account**
  (Nexus carries mod-download history/reputation; both cost effort). Permanent bans also **revoke
  the device** (`installToken`) and apply a **Discord guild ban**.
- **Residual:** someone with multiple provider accounts can re-link a fresh one. Mitigations that
  stack (mostly already present): device-key revocation, the `register`-limited gate (can't chat
  before linking), per-IP connection caps, the FO76-name claim + presence cross-check
  ([auth §6.5](../backend/hud-chat-auth-design.md)), and report-driven human review. The
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

Either way, the name-derived `HUD_IDENTITY_SECRET` is retired with the FCMHUD/1 transport
([auth §7.3](../backend/hud-chat-auth-design.md)).

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
2. **Enforce on chat.v1 via a cached status re-check** (per-op + per-keepalive, short Redis TTL) +
   **token revocation for permanent bans/deletion only** (#296). A dedicated `moderation:evict`
   pub/sub signal is **deferred** — the cached check already cuts send (per-op) and read (~10 s)
   cross-instance without it; revisit when private channels (party/clan) need instant read-cutoff.
3. **Keep the ban target = account `userId`**; rekey `identityHash` to `userId`; retire
   `HudIdentityBlock` as a separate gate.
4. **Gate in-game `moderationAction` on a staff Discord link**; dashboard stays the authoritative
   moderation surface.
5. **Always revoke the device + Discord-lockdown on permanent bans**; surface evasion signals to the
   dashboard rather than auto-blocking.
6. **Slow-mode** stays a deferred, per-channel feature.

## See also

- [README](README.md) · [automod](automod.md) · [reports-and-evidence](reports-and-evidence.md)
- [auth lockdown / pairing design](../backend/hud-chat-auth-design.md)
- [chat.v1 integration — auth gate + moderationAction mapping](../overlay/zfe/native-chat-relay/fcm-integration.md)
- chat.v1 moderation issue: #288 · auth gate issue: #295
