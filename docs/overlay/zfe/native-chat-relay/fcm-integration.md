# Making the FCM Relay ZFE-Native-Chat Compatible

> **Status: planning artifact — implementation not started.** This doc specifies *how* FCM's
> backend will expose a relay endpoint that speaks the
> [ZFE Native Chat Relay Protocol (`chat.v1`)](protocol-spec.md).
>
> **Who builds what.** ZFE provides the native chat **engine** (the relay transport, DPAPI token
> storage, reconnect, hotkey/input, and the `chat.v1.*` command API). **FCM owns both ends we ship:**
> the backend **relay** *and* the in-game chat **UI — our own SWF.** That UI **already exists** (the
> FCMBridge / FCMChatWidget HUD widget); the work is to **adapt it to call `chat.v1`** instead of the
> legacy wire. So the look of in-game chat is entirely ours to control.
>
> **Decision (locked): adopt `chat.v1`; deprecate the bespoke `FCMHUD/1` *protocol*.** What is retired
> is the FCMHUD/1 **transport/wire** — the `color~channel~user~content` lines, the `hudPush` TCP/WS
> sockets, the M7 inbound parser. That was a **dev-only experiment, never shipped to production**, so
> removal is clean (no users to migrate, no rollback risk). Our in-game chat **SWF is kept** and
> rewired to `chat.v1`; ZFE now handles the networking the SWF used to do by hand. See
> [How this differs](#how-this-differs-from-the-existing-fcmhud1-bridge) for the consequences
> (per-user cosmetics + dynamic channels need ZFE spec extensions, or move overlay-only).

## TL;DR

ZFE's upcoming native chat client speaks a **standardized, relay-agnostic JSON-over-WebSocket
contract** (`register` / `hello` / `send` / `poll` / `subscribe` / `report` / `moderationAction`).
FCM already *is* a governed chat relay — it just speaks a **different** wire protocol on `/ws`
(typed `{type, payload}` envelopes) and `/ws/hud` (the bespoke `FCMHUD/1` lines).

The integration is a **thin adapter front-end**: a new WebSocket route (proposed `/relay`) that
translates `chat.v1` ops onto FCM's *existing* services — `ingestMessage` / `finalizeMessage`,
the moderation action services, channel resolution, the Redis pub/sub fan-out, and the
`ws_rate:<userId>` limiter. The only net-new infrastructure is a **durable monotonic cursor** for
`poll`/`subscribe` dedup and a **persistent relay token** identity.

FCM's custom channels (Events / Raids / Infests) are **not** a blocker: ZFE's `AllowedChannels`
config carries arbitrary relay channel IDs, so FCM ships its own slug list and maps each slug to a
leaf-channel UUID. See [Channel mapping](#channel-mapping).

```
ZFE native chat SWF
  └─ __ZFE.call("chat.v1.*")           [client-side, ZFE-owned]
        │  wss://falloutchatmod.com/relay   (chat.v1 JSON frames)
        ▼
  backend: NEW /relay adapter  ──────────────┐  (proposed)
        │  translate op → FCM service        │
        ├─ register/hello → relay-token identity (Redis + User column)
        ├─ send           → ingestMessage() / finalizeMessage()
        ├─ poll           → message history by relaySeq cursor
        ├─ subscribe      → Redis pub/sub push + per-subscriber cursor
        ├─ report         → reportsController.createReport
        └─ moderationAction → moderationActionsService.* / messagesController.deleteMessage
                              │
                              ▼
                    same Postgres / Redis / Discord relay as /ws and /ws/hud
```

---

## How this differs from the existing FCMHUD/1 bridge

| | **FCMHUD/1** (deprecated — dev-only, never shipped to prod) | **`chat.v1` relay** (the path forward) |
|---|---|---|
| Who defines the wire format | **FCM** (bespoke) | **ZFE** (standard contract) |
| In-game UI (the SWF) | **our** SWF (`FCMBridge.swf`) **+** bespoke in-SWF socket/line parsing | **our** SWF (same UI, already built), rewired to ZFE's `chat.v1` API — **ZFE does the networking** |
| Transport | ZFE generic socket (TCP+TLS / `/ws/hud`) | ZFE native chat over `wss://…/relay` |
| Wire shape | `color~channel~user~content` lines + `HELLO/SEND/CHAN` verbs | JSON frames keyed by `op` |
| Identity | M7 `identityHash = HMAC-SHA256(secret, accountName)` ([hudIdentityService.ts](../../../../backend/src/services/hudIdentityService.ts)) | Relay-issued `userId` + opaque `token` |
| Backend route | `/ws/hud` ([hudPushWs.ts](../../../../backend/src/services/hudPushWs.ts)) / TCP :4001 | proposed `/relay` |
| Read model | server-push lines, no cursor | monotonic `cursor` (poll + subscribe dedup) |
| Moderation in-protocol | none (report/mute happen elsewhere) | `report` + `moderationAction` ops |

**Decision (locked): deprecate the FCMHUD/1 *protocol*, adopt `chat.v1` — keep our SWF.** FCMHUD/1's
transport was a **dev-only experiment, never shipped to production** — there are no in-game-chat
users today, so there is nothing to migrate and no rollback risk. What FCM stops maintaining is the
**bespoke wire protocol + the in-SWF networking + the backend push transports**; ZFE absorbs all of
that. What FCM **keeps** is the **in-game chat UI it already built** (our SWF), simplified to call
`chat.v1` and render. With `AllowedChannels` carrying FCM's custom channels (Events/Raids/Infests),
`chat.v1` covers the core in-game chat scope.

Two FCMHUD/1-only capabilities do **not** carry over through the `chat.v1` event schema and become
explicit follow-ups rather than reasons to keep the old transport alive (note: these are *data*
limits, not *rendering* limits — our SWF can draw anything; it just isn't handed the data):

- **In-game cosmetics** (name colors / clan tags — #191/#192/#227) — `chat.v1` has no cosmetic event
  field. Resolve by requesting a ZFE event-schema extension, or accept cosmetics as overlay/dashboard
  only (#228 is overlay-side and is unaffected).
- **Runtime-created channels** — `AllowedChannels` is static install config; admin/clan channels
  created after install need a ZFE dynamic-channel-list mechanism, or a config reship.

Both are tracked as ZFE-coordination follow-ups, not blockers on the deprecation. See
[Relationship to FCM roadmap issues](#relationship-to-fcm-roadmap-issues).

---

## Where the adapter plugs in

FCM already multiplexes WebSocket upgrades by path in
[`backend/src/websocket/upgradeRouter.ts`](../../../../backend/src/websocket/upgradeRouter.ts)
(`attachChatUpgradeRouter`): `/ws` → chat handler, `/ws/hud` → HUD push, all other paths rejected.
The adapter adds a **third route**:

- **`/relay`** → `chat.v1` adapter. Add a branch in `attachChatUpgradeRouter` mirroring how
  `/ws/hud` is claimed (see the routing note in [../realtime-socket.md](../realtime-socket.md#hudpushwsts-path-b)).
- The Express SPA catch-all already skips `/ws` and `/ws/*` ([`server.ts`](../../../../backend/src/server.ts)); extend the same guard to `/relay` so a plain GET isn't served the dashboard HTML.

The adapter is a **stateless RPC dispatcher** for request/response ops, plus a **long-lived
subscriber registry** for `subscribe` (model it on the `hudPush.ts` client registry). Each inbound
text frame is parsed as JSON and dispatched on its `op` field; every op except `register`/`hello`
re-validates the `token` per frame (ZFE may use short-lived connections for `register`/`hello`/
`send`/`poll` and one long-lived connection for `subscribe`).

> **Connection-model contrast.** FCM's `/ws` keeps one socket per client and multiplexes typed
> envelopes; the `chat.v1` contract is "one request frame → one response frame" for RPC ops and a
> separate long-lived `subscribe` stream. The adapter must support **both shapes on one route**.

---

## Operation → FCM service mapping

| `chat.v1` op | FCM target | Notes |
|---|---|---|
| `register` | new relay-token mint (see [Identity](#identity--auth-bridge)) | Server owns `userId` + `token`; create a lightweight `User` row |
| `hello` | relay-token lookup → `User` | Validate token, check ban/revoke, update `displayName`; return `userId`/`role` |
| `send` | [`finalizeMessage()` / `ingestMessage()`](../../../../backend/src/services/ingestMessage.ts) | Reuse mute check, `ws_rate` limit, automod, 500-char cap, persistence, Discord relay |
| `poll` | message history query by `relaySeq` cursor | `cursor=0` returns a bounded history window (FCM uses 30 for HUD backfill) |
| `subscribe` | Redis pub/sub (`chat:broadcast`) → push `event` frames | Per-subscriber cursor; push only events newer than the client's cursor |
| `report` | [`reportsController.createReport`](../../../../backend/src/controllers/reportsController.ts) | `{success:true,status:"reported"}` |
| `moderationAction` | [`moderationActionsService`](../../../../backend/src/services/moderationActionsService.ts) / [`messagesController.deleteMessage`](../../../../backend/src/controllers/messagesController.ts) | Gated on linked staff identity — see [Permissions](#permissions-mapping) |

### `send` flow reuse

The adapter must **not** reimplement message governance. It calls into the same pipeline `/ws` and
`/ws/hud` use:

```
/relay send
  → adapter resolves token → userId, displayName, source = "relay"
  → ingestMessage()  [mute check, ws_rate:<userId> 5/sec, automod, 500-char validation]
  → finalizeMessage()  [assign relaySeq cursor, broadcast(chat:message), enqueue persist, Discord relay]
  → reply { success:true, messageId }
```

Use a new `source` value (`"relay"`) so message provenance is distinguishable from `game` / `web`
/ `hud` / `discord` / `bot` (matches the existing `Message.source` convention).

---

## Identity & auth bridge

The `chat.v1` model is **token-only**: `register` mints a server-owned `userId` + opaque `token`;
ZFE stores the token in a DPAPI-protected file and re-presents it via `hello`. There is **no**
account-name handshake (unlike M7's `HELLO~account~character`), so the relay identity is weaker
than the FCMHUD/1 `identityHash` and must be treated accordingly for moderation.

### Token lifetime — the key difference from FCM sessions

FCM session tokens (`session:<token>` in Redis) are **24h** and the overlay silently re-registers
via its install token. ZFE relay tokens must **persist across game sessions** (the saved-token →
`hello` flow is the whole point). So:

- **Mint** (`register`): generate `userId` (server UUID, surfaced to ZFE as `user_<hex>`) and a
  high-entropy `token`. Persist on the `User` row (proposed `relayToken` unique column, mirroring
  the existing `installToken`), and optionally cache `relay:<token> → userId` in Redis for fast
  validation. **Never** accept a client-supplied id.
- **Authenticate** (`hello` / every op token): look up `relayToken` → `User`. Update `displayName`
  if provided (display only — never changes `userId`/`role`/ban/mute/history, per contract).
- **Revoke**: clear/rotate the `relayToken` column (or set a revoked flag). `hello` then returns
  `auth_token_revoked`.

### Optional: linking to a stronger identity

`register` deliberately creates a fresh, display-name-only identity — do **not** auto-merge on
`displayName` (the contract explicitly warns against trusting it). For ban resistance and to grant
staff powers, support **opt-in account linking** later (invite code / Discord OAuth handoff) that
attaches the relay `userId` to an existing FCM `User` (Discord-authed, or the M7 `identityHash`).
This is the contract's recommended "account linking / invite codes / operator review" path.

The spec's compatibility notes spell out the **limited-until-linked** pattern: keep a fresh relay
user in a limited state and return stronger `roles`/permission booleans from `register`/`hello`
**after** linking. Two FCM-specific choices:

- **Default — allow public sends pre-link.** A `register`-minted user should be able to post to
  public channels immediately, matching how anonymous overlay install-token users already work (no
  Discord required to chat). Linking only *elevates* (staff powers, stronger ban resistance).
- **If we decide sending must be gated** (e.g. require linking before any send), reject `send` with
  **`permission_denied`** — ZFE does **not** advertise a separate `canSend` permission, so this is
  the prescribed way to express "registered but not yet allowed to talk."

### Auth error-code mapping

| FCM state | `chat.v1` error code |
|---|---|
| `relayToken` not found / stale | `auth_token_invalid` |
| `relayToken` revoked flag set | `auth_token_revoked` |
| `user.isBanned` active (incl. `bannedUntil` in future) | `user_banned` |
| `ws_rate:<userId>` exceeded | `rate_limited` |
| `user.isMuted` at `send` | `user_muted` (the spec's recommended muted-send rejection) |
| privileged op from an unlinked (non-staff) identity | `permission_denied` |
| `setSlowMode` (no FCM primitive) | `permission_denied` / `invalid_action` |
| `send` to unknown/omitted slug or container channel | `invalid_channel` (relay-defined) |
| body > 500 chars | `message_too_long` (relay-defined) |

Only the four codes in the [protocol spec](protocol-spec.md#success-and-error-envelopes)
(`auth_token_invalid`, `auth_token_revoked`, `user_banned`, `rate_limited`) drive ZFE's own
auto-register / back-off behavior. The spec's **compatibility notes** add `user_muted`,
`permission_denied`, and `invalid_action` as the recommended operational rejections — FCM should use
those exact codes (the earlier draft's ad-hoc `muted` is replaced by `user_muted`). `invalid_channel`
and `message_too_long` remain relay-defined; ZFE surfaces them to the SWF but takes no special
action.

---

## Channel mapping

**The channel vocabulary is configurable — this resolves the earlier "custom channels" concern.**
ZFE's `[TextChat] AllowedChannels` lets a relay ship its **own** channel IDs; the SWF sends those
exact strings, and ZFE drops any default channel we omit. So FCM is **not** limited to
`global/trade/server/…` — it ships a slug list including `events`, `raids`, `infests` and maps each
to a leaf channel UUID server-side. (Earlier drafts of this plan treated Events/Raids/Infests as an
unreachable gap; the `AllowedChannels` revision of the spec removes that constraint.)

> **Ship slugs, not UUIDs.** Channel IDs are constrained to ASCII `[A-Za-z0-9_.:-]`, < 64 bytes.
> FCM channels are UUIDs (technically valid, but ugly and internal-leaking), and ZFE has **no
> separate channel-label field** — the channel **ID is what the native UI displays**. So ship
> human-friendly **slugs** and keep a `slug ↔ channelId` map in the adapter; outbound events tag
> `channel` with the slug (reverse-map UUID → slug).

Proposed `AllowedChannels` fragment value: **`global,trade,server,events,raids,infests`**
(`DefaultChannel=global`).

| ZFE channel ID (shipped) | FCM target | Status | Notes |
|---|---|---|---|
| `global` | General `…0005` (`HUD_DEFAULT_CHANNEL_ID`) | map | Broad default |
| `trade` | Trading `…0002` | map | Reuses ZFE's default name |
| `events` | Events `…0003` | **map (custom)** | Custom ID via `AllowedChannels` |
| `raids` | Raids `…0004` | **map (custom)** | Custom ID |
| `infests` | Infests `983995c1-…` | **map (custom)** | Custom ID |
| `server` | FCM session scope (`scope:'session'`, `sessionId`) | map (room) | Same-world server chat — a **room**, not a static channel (see below) |
| `party` | FCM `Party`/`PartyMember` (`scope:'party'`) | defer | Group room; needs identity linking + party membership first |
| `whisper` | — (requires `targetUserId`) | omit | No 1:1 DM in FCM yet — omit from `AllowedChannels` until built |
| `clan` | FCM clan chat (**Clans epic #182**) | defer | Maps to the user's clan channel once Clans ships (relay resolves `clan` → their clan, members-only server-side) — see [roadmap note](#relationship-to-fcm-roadmap-issues) |
| `local` | — | omit | No FCM equivalent; the spec says **omit defaults with no meaning** |

**Rooms vs. static channels.** `global`/`trade`/`events`/`raids`/`infests` are **static topic
channels** — a flat `slug → UUID` lookup. `server` and `party` are **dynamic-membership rooms**, and
FCM already models them as Redis pub/sub **scopes** (`scope:'session'`/`'party'` with
`sessionId`/`memberUserIds`) — exactly the right primitive. The `server` slug binds to the
connection's current world-session room; `party` (deferred) binds to the user's party room. This is
the one place "WebSocket rooms" genuinely apply — for **fan-out membership**, not for expanding the
addressable channel namespace (that job belongs to `AllowedChannels`).

> **`server` chat conveys `worldId` in-band — no ZFE change needed (#293).** The `server` slug binds
> to the player's **current world-session room**, so the relay must know the connection's `worldId`.
> The standalone chat `.ba2` (#137/#293) reads `worldId` from the UI layer and **conveys it as an
> intercepted control message** over the existing `send` op — a reserved system-`userId` / sentinel
> the **relay consumes and never broadcasts, persists, or emits to poll/subscribe**. ZFE forwards it
> as an ordinary in-spec `send` (valid channel, small body — ZFE never inspects the meaning). The
> relay stores `worldId` per relay-`userId` (stale-after-~30s, like the existing player-bridge) and
> binds `server` to that room; the SWF re-sends on world change. This works **today** because FCM
> owns **both** ends (our SWF + our relay).
>
> **Generalization:** anything ZFE doesn't model can be **tunneled** through the fields it *does* pass
> (`body` / `senderDisplayName` / `targetUserId`), encoded by one end and decoded/stripped by the
> other. So per-user **cosmetics** are likely solvable the same way (relay encodes a color/clan suffix
> in `senderDisplayName`; our SWF decodes + strips it). The **one** thing that can't be tunneled is
> **channels** — ZFE validates them **client-side** against `AllowedChannels` — so **dynamic channels
> are the only genuine `chat.v1` extension need** (#292). Hardening: intercept the control message
> before `ingestMessage`/broadcast (airtight suppression), and **the control message MUST be
> HMAC-signed** — `HMAC-SHA256(secret, worldId || relayUserId || timestamp)`; the relay **rejects**
> any missing/invalid HMAC or stale timestamp (≈30s replay window). This is tamper-evidence + replay
> / cross-user protection on top of the already TLS- and token-authenticated `send`; it does not stop
> a user spoofing *their own* client-read `worldId` (inherent, low stakes — ephemeral server chat).

Channel eligibility stays uniform with the rest of FCM: only **leaf** channels
(`parent_id IS NOT NULL AND NOT is_archived`) map to a slug — the same predicate `hudPush.ts` and
the hud-feed SQL already enforce. An unknown/omitted slug or a container target returns the
relay-defined `invalid_channel` error (ZFE also pre-validates against `AllowedChannels`, so this is
defense in depth).

> **Static config vs. FCM's runtime channels.** `AllowedChannels` is **static** install config
> (fragment / `zfe.ini`). FCM admins create channels at runtime (`POST /api/channels`), and clans
> (#182) would add per-clan channels — none of which appear in a native client until the fragment is
> reshipped or the user edits `zfe.ini`. So the native `chat.v1` client is bound to the **shipped
> slug set**; FCMHUD/1's `CHAN~<channelId>` (any leaf UUID) has no such limit. This is a real
> residual FCMHUD/1 advantage — see the [roadmap note](#relationship-to-fcm-roadmap-issues) and the
> deprecation open question.

---

## Cursor design (the main net-new piece)

`poll` and `subscribe` require a **monotonically increasing integer `id`** per visible event, stable
across reconnect, so ZFE can dedup between push and poll. FCM messages have a UUID + `createdAt`
composite PK ([`Message`](../../../../backend/prisma/schema.prisma)) — **no global integer
sequence** today. We need one.

**Constraint:** FCM broadcasts on the hot path *before* async persistence (the Bull `messagePersist`
queue writes later). `subscribe` push happens at **broadcast** time; `poll` reads **persisted**
rows. The cursor must therefore be assigned at **broadcast** time and carried through to
persistence, or push and poll will disagree.

**Recommendation — assign `relaySeq` in `finalizeMessage`:**

1. At broadcast, `relaySeq = INCR relay:seq` (Redis, cluster-global, monotonic).
2. Include `relaySeq` in the `chat:message` payload **and** the Redis `chat:broadcast` envelope, so
   every instance's subscriber loop pushes the same cursor.
3. Persist `relaySeq` with the message (new indexed column, e.g. `messages.relay_seq BIGINT`).
4. `poll(cursor, max)` → `SELECT … WHERE relay_seq > :cursor ORDER BY relay_seq ASC LIMIT :max`,
   filtered to the requesting user's visible channels (and `isDeleted = false`).
5. `poll(cursor=0)` → return a bounded recent window (reuse the HUD's 30-message backfill policy),
   each event carrying its real `relay_seq` so the client continues from the newest it received.

This keeps **push and poll dedup correct**, which is the cursor's entire purpose. The Redis
`INCR` + a persisted indexed column is the minimal, horizontally-safe design (no per-connection
state, survives reconnect, works across instances). The alternative of deriving cursors from
`createdAt` epoch-millis is rejected — within-millisecond collisions break strict monotonicity.

> **The spec now endorses this exact approach.** The "Existing relay compatibility notes" section of
> [protocol-spec.md](protocol-spec.md#existing-relay-compatibility-notes) states: *"assign a relay
> cursor when the message is broadcast and make both poll and subscribe return that same cursor
> value for the same event."* That is the broadcast-time `relaySeq` design above — so this is no
> longer a speculative choice, it's the documented pattern.

---

## Message limits reconciliation

ZFE enforces a **local 512 UTF-16 code-unit** body cap; FCM enforces **500 characters** in
`ingestMessage`. FCM's limit is stricter, so any message FCM accepts is within ZFE's local cap —
keep FCM's 500-char validation as the authoritative server limit (the contract requires the relay
to enforce its own). Bodies of 501–512 units that pass ZFE's local check but fail FCM's get a
relay-defined `message_too_long` error rather than a silent drop. (Note the char-vs-code-unit
nuance: a surrogate-pair emoji is 1 "character" but 2 UTF-16 code units — FCM counts characters.)

---

## Permissions mapping

`chat.v1` `getAuthState` advertises a `permissions` object; ZFE pre-checks it for fast UI failure,
but the **server is authoritative**. Map from the requesting identity's FCM role:

| `permissions` field | Granted to |
|---|---|
| `canReport` | all authenticated relay users |
| `canDeleteMessage` | `moderator`+ (FCM `requireDiscordRole`) |
| `canMuteUser` | `moderator`+ |
| `canBanUser` | `moderator`+ (FCM `createBan` is moderator-gated) |
| `canSetSlowMode` | **always `false`** — FCM has no slow-mode primitive; reject `setSlowMode` with `permission_denied` / `invalid_action` (per the spec's compatibility notes) |

**Practical reality at launch:** a `register`-minted relay identity has `role: "user"` — it is
**report-only**. Real moderation still happens through the dashboard. `moderationAction` ops only
succeed once a relay identity is **linked** to a staff Discord account (the contract's separate
`moderator_token`). Until linking exists, the adapter returns `auth_token_invalid`-style failure for
privileged `moderationAction` ops from unlinked identities.

### `moderationAction` action mapping

| Action | FCM target | Status |
|---|---|---|
| `deleteMessage` | `messagesController.deleteMessage` (soft-delete + broadcast `chat:delete`) | map (staff-linked) |
| `muteUser` | `moderationActionsService.muteUser` | map (staff-linked) |
| `unmuteUser` | `unmuteUserHandler` service path | map (staff-linked) |
| `banUser` | `createBan` (needs a no-evidence service variant; the REST path is multipart) | map (staff-linked) |
| `unbanUser` | `reverseBan` | map (staff-linked) |
| `setSlowMode` | — | **unsupported** — reject with `permission_denied` / `invalid_action`; `canSetSlowMode=false` |

> **Deletion — what the spec now prescribes.** ZFE still has **no dedicated deleted-message event
> kind**. The compatibility notes say a relay should **hide deleted messages from later `poll` and
> history responses** (FCM already does this — the `poll` query filters `isDeleted = false`), and
> that **live removal of an already-rendered message needs a future ZFE event extension or a
> convention handled by your own SWF**. Because the `chat.v1` path uses ZFE's **native** client (not
> our SWF), the own-SWF option isn't available to us — so for now a deleted message simply **stops
> appearing in history/poll** but isn't pulled from a screen that already rendered it. FCM's
> internal `chat:delete` broadcast still drives the dashboard/overlay surfaces as before.

---

## Rate limiting

Reuse the existing `ws_rate:<userId>` sliding window (5 msg/sec) from `ingestMessage`. Because relay
identities are weakly authenticated (display-name-only `register`), the limiter should **fail
closed** on Redis errors for `source = "relay"` — matching the existing `hud` behavior (SR-004 in
[../realtime-socket.md](../realtime-socket.md)), not the fail-open `ws` behavior. Exceeding the
limit returns `{ success:false, error:{ code:"rate_limited" } }`.

---

## EULA / safety posture

The native chat SWF is a **HUD mod** — it rides the **`.ba2` modding track** (EULA §4(F), see
[`docs/README.md`](../../../README.md) and root `CLAUDE.md`). The same hard limits hold: **no
game-memory reading, no code injection, no network/port scanning.** The relay is just a chat
server; the adapter changes nothing about that boundary. This track must never be bundled into or
required by the EULA-safe desktop overlay.

---

## Phased rollout

| Phase | Scope | Gate |
|---|---|---|
| **R0** | Sign-off + finalize the `AllowedChannels` slug set (`global,trade,server,events,raids,infests`) + the decisions below | decisions answered |
| **R1** | `/relay` route + `register`/`hello` + relay-token model (`User.relayToken`, `relay:<token>` Redis) + **dev-only guard** (refuse when `NODE_ENV=production`, mirroring `hudPush`) | loopback compat test passes (`register → subscribe → send → poll`) |
| **R2** | `send` → `ingestMessage`, `relaySeq` cursor + `poll`; slug↔UUID map for `global/trade/server/events/raids/infests` | unit + contract tests green |
| **R3** | `subscribe` push via Redis pub/sub; cross-instance cursor consistency | push/poll dedup verified |
| **R4** | `report` → `createReport` | |
| **R5** | `moderationAction` (report-only first) + permissions + staff identity linking | |
| **R6** | Production exposure: `wss://falloutchatmod.com/relay` via the existing Cloudflare tunnel; 10s keepalive frames (defeat CF ~100s idle WS drop, as `/ws/hud` already does) | smoke + scan gates per release rules |
| **R7** | **Retire the FCMHUD/1 *transport*** — remove the `hudPush` TCP/WS front-ends + `/ws/hud` route, the M7 inbound parser, the line-wire feed, and the dev env wiring; flag the FCMHUD/1 docs deprecated. **The in-game SWF is retained and rewired to `chat.v1` — NOT removed** (its adaptation is the in-game UI track, below). Safe because the transport never reached prod. | dev-only transports removed; SWF adapted; docs flagged deprecated |

> **In-game UI track (runs alongside R1–R7, tracked under #137).** The in-game chat **SWF is ours
> and already built** (FCMBridge / FCMChatWidget). The client-side work is to **adapt** it to the
> `chat.v1` API (`connect`/`pollEvents`/`sendMessage` instead of the legacy socket + line parsing),
> ship it with the TextChat fragment + `AllowedChannels`, and keep its look at ChatOverlay parity.
> This is **not** a rewrite — ZFE absorbs the networking, so the SWF gets *simpler*.

Mirror the HUD-push **dev-only production guard**: the `/relay` front-end refuses to start when
`NODE_ENV=production` until R6 explicitly lifts it (the same pattern `initHudPushTcp`/`initHudPushWs`
use, per [../realtime-socket.md](../realtime-socket.md#transport-overview)). R7 then removes those
HUD-push front-ends entirely.

---

## Testing & CI (HARD RULE)

Per the repo's "every feature ships with unit tests + CI coverage" rule, each phase lands with
tests:

- **Op dispatch + error codes** — unit-test the adapter: malformed frames, each stable error code
  (`auth_token_invalid` / `auth_token_revoked` / `user_banned` / `rate_limited`), per-frame token
  re-validation.
- **Cursor monotonicity** — `relaySeq` strictly increases; `poll(cursor)` returns only newer
  events; `subscribe` does not drain history; reconnect-with-last-cursor yields only newer events.
- **Channel mapping** — each shipped slug (`global`/`trade`/`server`/`events`/`raids`/`infests`)
  resolves to the right leaf UUID and round-trips back to the slug on outbound events; unknown/
  omitted slugs and container targets return `invalid_channel`.
- **Loopback contract test** — reproduce the spec's local test (`register → subscribe → send →
  poll`) against an in-process relay, modeled on the existing
  [`backend/tests/upgradeRouter.test.js`](../../../../backend/tests/upgradeRouter.test.js) and
  `hudPushWs.test.js` harnesses.
- **Production guard** — the `/relay` front-end refuses to start under `NODE_ENV=production` before
  R6 (mirror `hudPushTcp.test.js` / `hudPushWs.test.js` "production guard" blocks).

Wire the suite into [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) and promote
into the required `CI Summary` gate once stable.

---

## Relationship to FCM roadmap issues

This spec materially reshapes several tracked roadmap epics. It doesn't *close* them, but it changes
the build approach and answers some of their open design questions:

- **#137 Standalone in-game chat `.ba2`** (and **#138**, **#162**). This epic is the in-game client
  side: **our SWF** (the UI we already built) packaged as the shipping `.ba2`. #138's scope — render
  the feed in-HUD, two-way input, connect **directly to the backend with no overlay**, and the open
  question *"how the mod authenticates the player without the overlay"* — splits cleanly: ZFE handles
  transport, input, and DPAPI token storage; **FCM provides both** the `/relay` backend **and** the
  in-game UI (adapt the existing SWF to `chat.v1`). #138's identity/auth question is answered by the
  `register → token → hello` model ([Identity & auth bridge](#identity--auth-bridge)). Net effect:
  #137 ships as *"adapt our existing chat SWF to the `chat.v1` API + package it with an
  `AllowedChannels` fragment"* — reusing the UI we built, dropping only the bespoke socket/wire code.
- **#152 Server-scoped chat** (**#154**, **#162**). The `server` slug + FCM session-scope rooms are
  the in-game surface for server chat — #162 ("render server-only channel in-game") in **our existing
  SWF**, via the `chat.v1` `server` channel. The worldId/roster **data-bridge** (#161, part of #144)
  is separate and **unaffected** — `chat.v1` is chat only, not game-UI data capture.
- **#182 Clans / #187 clan chat.** Corrects this plan's earlier "`clan` has no FCM equivalent": once
  Clans ships, the `clan` slug maps to the user's clan channel (relay resolves `clan` → their clan,
  members-only enforced server-side). Caveat: `AllowedChannels` is static, so the richer #187 UX
  (multiple per-clan channels as sub-tabs, runtime create/rename) stays a dashboard/overlay feature —
  the native client carries a **single** `clan` slot.
- **Per-user cosmetics are a *data* gap, not a rendering gap** (**#191**, **#192**, **#227**;
  **#228** is overlay-side and unaffected). Our SWF can render any color/badge we like — but the
  `chat.v1` event carries only `senderDisplayName` + `body`, so it isn't *handed* the per-user
  name-color / clan-tag data. With the FCMHUD/1 transport deprecated, these become explicit
  follow-ups: request a ZFE event-schema cosmetic extension (then our SWF renders it), or scope
  in-game cosmetics out (overlay/dashboard keep them via #228). Tracked under the deprecation epic's
  *ZFE-coordination* issue.
- **Runtime-created channels** are not addressable by static `AllowedChannels` (admin/clan channels
  created after install, `POST /api/channels` / #182). Also a ZFE-coordination follow-up (dynamic
  channel-list mechanism), not a blocker on deprecation.

---

## Open questions / decisions needed

The `AllowedChannels` revision of the spec **closed** several questions from the first draft:
channels (custom IDs via `AllowedChannels`), the cursor design (now the documented pattern),
muted-send (`user_muted`), slow-mode (`permission_denied`/`invalid_action`), and the deletion
convention (hide from history/poll). What remains:

1. **Channel slugs.** Confirm the public slug set (`global,trade,server,events,raids,infests`) and
   that the native UI displays the slug as-is (no separate label field). Do we want prettier slugs
   (e.g. `general` vs `global`), accepting that the slug is user-visible?
2. **Identity strength & linking.** Default lets `register` users post to public channels (parity
   with anonymous overlay users); linking only elevates. Confirm that, and decide whether to
   cross-link to the M7 `identityHash` when the same person uses both bridges (shared ban state).
3. **`party` / `whisper`.** Both are deferred/omitted at launch. When do we add `party` (needs
   identity linking + party-membership binding) and `whisper` (needs a `Block`-aware DM feature)?
4. **Live deletion (spec-settled — just confirm).** Not really a choice: the spec **dictates**
   hide-from-history/poll, and live removal of an already-rendered line needs a future ZFE
   `chat.delete` event kind (the "own-SWF convention" escape hatch doesn't apply to ZFE's native
   client). Confirm we accept that a native-client user keeps a deleted line on screen until refresh;
   FCM's dashboard/overlay surfaces are unaffected.
5. **FCMHUD/1 deprecation — DECIDED (locked).** We deprecate the bespoke bridge and go single-path on
   `chat.v1`; FCMHUD/1 never reached production, so there is nothing to migrate (see
   [How this differs](#how-this-differs-from-the-existing-fcmhud1-bridge) and **R7** in the rollout).
   The two follow-on decisions are *how* to handle the capabilities that don't carry over — (a)
   in-game **cosmetics** (#191/#192/#227): request a ZFE event-schema extension or scope them
   overlay-only; (b) **runtime-created channels**: request a ZFE dynamic-channel-list mechanism or
   accept config reships. Both are tracked under the deprecation epic, not reasons to keep FCMHUD/1.
6. **Slow-mode (optional).** Permanently advertise `canSetSlowMode=false`, or build a real
   per-channel slow-mode primitive later (it would also benefit the dashboard/overlay)?

---

## See also

- [protocol-spec.md](protocol-spec.md) — the upstream `chat.v1` contract (reproduced)
- [README.md](README.md) — index for this sub-topic
- [../realtime-socket.md](../realtime-socket.md) — the existing FCMHUD/1 push bridge
- [../two-way-chat-implemented.md](../two-way-chat-implemented.md) — M7 in-game send (FCMHUD/1)
- [../../../realtime/README.md](../../../realtime/README.md) — FCM's `/ws` relay protocol, presence, pub/sub
- [../../../backend/README.md](../../../backend/README.md) — REST API, services, auth model
