# Making the FCM Relay ZFE-Native-Chat Compatible

> **Status: design proposal.** Nothing here is implemented. This doc specifies *how* FCM's
> existing backend would expose a relay endpoint that speaks the
> [ZFE Native Chat Relay Protocol (`chat.v1`)](protocol-spec.md), so a future ZFE's **native
> chat client** can connect to FCM directly — without FCM's bespoke `FCMHUD/1` SWF/wire code.
>
> It references real files/services by path so it can be picked up as an implementation plan.
> Treat every "FCM would…" as a proposal pending sign-off, not a description of shipped behavior.

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

| | **FCMHUD/1** (shipping) | **`chat.v1` relay** (this proposal) |
|---|---|---|
| Who defines the wire format | **FCM** (bespoke) | **ZFE** (standard contract) |
| In-game client | FCM's custom `FCMBridge.swf` (Haxe) | ZFE's **native** chat client |
| Transport | ZFE generic socket (TCP+TLS / `/ws/hud`) | ZFE native chat over `wss://…/relay` |
| Wire shape | `color~channel~user~content` lines + `HELLO/SEND/CHAN` verbs | JSON frames keyed by `op` |
| Identity | M7 `identityHash = HMAC-SHA256(secret, accountName)` ([hudIdentityService.ts](../../../../backend/src/services/hudIdentityService.ts)) | Relay-issued `userId` + opaque `token` |
| Backend route | `/ws/hud` ([hudPushWs.ts](../../../../backend/src/services/hudPushWs.ts)) / TCP :4001 | proposed `/relay` |
| Read model | server-push lines, no cursor | monotonic `cursor` (poll + subscribe dedup) |
| Moderation in-protocol | none (report/mute happen elsewhere) | `report` + `moderationAction` ops |

**Strategic note.** Once ZFE ships native chat, `chat.v1` is the better long-term target: FCM stops
maintaining a custom SWF and wire format and just keeps a compliant relay. The two can run in
parallel during transition (both are additive front-ends onto the same services). A deprecation
path for `FCMHUD/1` is an [open question](#open-questions--decisions-needed), not a v1 requirement.

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

### Auth error-code mapping

| FCM state | `chat.v1` error code |
|---|---|
| `relayToken` not found / stale | `auth_token_invalid` |
| `relayToken` revoked flag set | `auth_token_revoked` |
| `user.isBanned` active (incl. `bannedUntil` in future) | `user_banned` |
| `ws_rate:<userId>` exceeded | `rate_limited` |
| `user.isMuted` at `send` | relay-defined `muted` (no stable code exists — see [open questions](#open-questions--decisions-needed)) |
| body > 500 chars | relay-defined `message_too_long` |

Only the four codes in the [protocol spec](protocol-spec.md#success-and-error-envelopes)
(`auth_token_invalid`, `auth_token_revoked`, `user_banned`, `rate_limited`) are **load-bearing**
for ZFE. Relay-defined codes (`muted`, `message_too_long`) are surfaced to the SWF but ZFE takes no
special action on them.

---

## Channel mapping

ZFE's allowed channel vocabulary is fixed: `local global server trade party clan whisper`
(plus reserved `system`). FCM's leaf channels are UUID-keyed and seeded in
[`server.ts`](../../../../backend/src/server.ts) (`…0001` *Fallout 76* is a container, excluded).

| ZFE channel | FCM target | Status | Notes |
|---|---|---|---|
| `global` | **General** `…0005` (`HUD_DEFAULT_CHANNEL_ID`) | **map** | The broad default channel |
| `trade` | **Trading** `…0002` | **map** | Direct match |
| `server` | FCM virtual-server channel (`server:` id namespace + session scope) | **map** | Same-world server chat; FCM already has `server:join-manual` + session-scoped pub/sub |
| `local` | — | **alias→`server`** or reject | FO76 area chat has no FCM equivalent; alias to `server` initially |
| `party` | FCM `Party` / `PartyMember` model | **defer** | Party is feature-gated and tied to authed overlay accounts; needs identity linking first |
| `clan` | — | **defer/reject** | No FCM clan concept |
| `whisper` | — (requires `targetUserId`) | **defer/reject** | FCM has no 1:1 DM; revisit with `Block`-aware DMs |

> **Gap — Events / Raids / Infests are unreachable.** FCM's `…0003` Events, `…0004` Raids, and
> `983995c1-…` Infests leaf channels are **not** in ZFE's channel vocabulary, so the native client
> cannot address them. Options: (a) accept that native-client users see only `global`/`trade`/
> `server`; (b) ship one fragment per channel via `[TextChat] DefaultChannel`; (c) request ZFE
> widen the vocabulary. This is a [decision needed](#open-questions--decisions-needed).

Channel eligibility stays uniform with the rest of FCM: only **leaf** channels
(`parent_id IS NOT NULL AND NOT is_archived`) are valid send/poll targets — the same predicate
`hudPush.ts` and the hud-feed SQL already enforce. Sends to a container channel return a
relay-defined `invalid_channel` error.

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
| `canSetSlowMode` | **always `false`** — FCM has no slow-mode primitive (see gap below) |

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
| `setSlowMode` | — | **unsupported** (no primitive; `canSetSlowMode=false`) |

> **Deletion-event gap.** The contract's documented event `kind` is `chat.message`; it does not
> specify a `chat.delete` event. FCM soft-deletes and broadcasts `chat:delete` internally, but until
> ZFE defines a deletion event kind, the native client won't reflect deletions live. Flagged as a
> [decision needed](#open-questions--decisions-needed).

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
| **R0** | Sign-off + resolve the channel-vocabulary gap with ZFE | decisions below answered |
| **R1** | `/relay` route + `register`/`hello` + relay-token model (`User.relayToken`, `relay:<token>` Redis) + **dev-only guard** (refuse when `NODE_ENV=production`, mirroring `hudPush`) | loopback compat test passes (`register → subscribe → send → poll`) |
| **R2** | `send` → `ingestMessage`, `relaySeq` cursor + `poll`; channels `global`/`trade`/`server` | unit + contract tests green |
| **R3** | `subscribe` push via Redis pub/sub; cross-instance cursor consistency | push/poll dedup verified |
| **R4** | `report` → `createReport` | |
| **R5** | `moderationAction` (report-only first) + permissions + staff identity linking | |
| **R6** | Production exposure: `wss://falloutchatmod.com/relay` via the existing Cloudflare tunnel; 10s keepalive frames (defeat CF ~100s idle WS drop, as `/ws/hud` already does) | smoke + scan gates per release rules |

Mirror the HUD-push **dev-only production guard**: the `/relay` front-end refuses to start when
`NODE_ENV=production` until R6 explicitly lifts it (the same pattern `initHudPushTcp`/`initHudPushWs`
use, per [../realtime-socket.md](../realtime-socket.md#transport-overview)).

---

## Testing & CI (HARD RULE)

Per the repo's "every feature ships with unit tests + CI coverage" rule, each phase lands with
tests:

- **Op dispatch + error codes** — unit-test the adapter: malformed frames, each stable error code
  (`auth_token_invalid` / `auth_token_revoked` / `user_banned` / `rate_limited`), per-frame token
  re-validation.
- **Cursor monotonicity** — `relaySeq` strictly increases; `poll(cursor)` returns only newer
  events; `subscribe` does not drain history; reconnect-with-last-cursor yields only newer events.
- **Channel mapping** — `global`/`trade`/`server` resolve to the right leaf UUIDs; container and
  deferred channels (`party`/`clan`/`whisper`) are rejected cleanly.
- **Loopback contract test** — reproduce the spec's local test (`register → subscribe → send →
  poll`) against an in-process relay, modeled on the existing
  [`backend/tests/upgradeRouter.test.js`](../../../../backend/tests/upgradeRouter.test.js) and
  `hudPushWs.test.js` harnesses.
- **Production guard** — the `/relay` front-end refuses to start under `NODE_ENV=production` before
  R6 (mirror `hudPushTcp.test.js` / `hudPushWs.test.js` "production guard" blocks).

Wire the suite into [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) and promote
into the required `CI Summary` gate once stable.

---

## Open questions / decisions needed

1. **Channel vocabulary gap.** Events / Raids / Infests aren't addressable by ZFE's fixed channel
   set. Accept the reduced surface, ship per-channel fragments, or ask ZFE to widen it?
2. **`local` / `clan` / `whisper`.** Alias `local`→`server`? Leave `clan`/`whisper` rejected until
   FCM has clan/DM features?
3. **Identity strength.** Display-name-only `register` is weaker than M7's `identityHash`. Do we
   require account linking (invite code / Discord) before granting any non-report capability, and
   should we cross-link to the existing `identityHash` when the same person uses both bridges?
4. **Muted-send semantics.** FCMHUD/1 drops muted messages silently; the contract has no `muted`
   error code. Drop silently (return `success:true` with no broadcast — risks cursor confusion),
   or return a relay-defined `muted` error (cleaner, but ZFE shows a generic failure)?
5. **Deletion events.** ZFE documents only `chat.message`. Do we wait for a ZFE `chat.delete` event
   kind, or accept that deletions aren't reflected live on the native client?
6. **Slow-mode.** `setSlowMode` has no FCM primitive. Build one, or permanently advertise
   `canSetSlowMode=false`?
7. **FCMHUD/1 deprecation.** Once `chat.v1` ships and FCM has a compliant relay, do we sunset the
   bespoke `FCMBridge.swf` + `FCMHUD/1` path, or keep both indefinitely?

---

## See also

- [protocol-spec.md](protocol-spec.md) — the upstream `chat.v1` contract (reproduced)
- [README.md](README.md) — index for this sub-topic
- [../realtime-socket.md](../realtime-socket.md) — the existing FCMHUD/1 push bridge
- [../two-way-chat-implemented.md](../two-way-chat-implemented.md) — M7 in-game send (FCMHUD/1)
- [../../../realtime/README.md](../../../realtime/README.md) — FCM's `/ws` relay protocol, presence, pub/sub
- [../../../backend/README.md](../../../backend/README.md) — REST API, services, auth model
