# HUD Push (`/ws/hud` and TCP :4001)

The HUD push path delivers live chat lines to FCMBridge.swf running inside Fallout 76.
It is a **separate, non-JSON, newline-delimited line-protocol endpoint** — not part of the
authenticated `/ws` JSON message catalog described in [websocket-protocol.md](./websocket-protocol.md).

## Distinction from `/ws`

| | `/ws` | `/ws/hud` (and TCP :4001) |
|-|-------|--------------------------|
| Protocol | JSON frames (`{"type":"...","payload":{...}}`) | FCMHUD/1 newline-delimited text lines |
| Auth | Required (session token or WS ticket) | None |
| Clients | Electron overlay, web dashboard | FCMBridge.swf in-game (ZFE Text Chat bridge) |
| Direction | Bidirectional | Both (M7: inbound HELLO/SEND parsed; outbound push unchanged) |
| Delivery | Every message type in the catalog | `chat:message` events on eligible channels only |

## Where to find the full spec

All details — wire protocol, env vars, backend architecture, per-IP caps, TCP backpressure
limits, SWF crash rules, probe tooling, and PENDING probe findings — are in:

**[docs/overlay/zfe/realtime-socket.md](../overlay/zfe/realtime-socket.md)**

## Quick reference

- Lines are `\n`-terminated UTF-8 on both TCP and WS transports.
- On connect: `HELLO~1~<n>` + `ACTIVECHAN~<channelName>` + `<n>` backfill lines (active channel only) + live lines as they arrive. Backfill can be
  disabled with `HUD_PUSH_BACKFILL_ENABLED=false` (default `true`) — then `n=0` and the feed shows
  ONLY live messages, no history.
- **Per-connection channel filter:** each connection has an `activeChannelId` (default: General,
  `HUD_DEFAULT_CHANNEL_ID`). Live push only delivers messages whose `channelId` matches the
  connection's active channel. The SWF can switch channels by sending `CHAN~<channelId>` — see the
  inbound verb table in [realtime-socket.md](../overlay/zfe/realtime-socket.md).
- Keepalive: `PING~<unixSeconds>` every 10 s (ZFE drops idle connections after ~15 s).
- Record format: `color~channel~user~content` — identical to `GET /api/game/hud-feed` records.
- Both transports default to **off** (`HUD_PUSH_TCP_ENABLED=false`, `HUD_PUSH_WS_ENABLED=false`).
- **M7 inbound** (TCP only, dev-only): `HELLO~<accountName>~<characterName>` then `SEND~<channelId>~<text>` and `CHAN~<channelId>`. Requires `HUD_IDENTITY_SECRET` env var. `SEND` channelId must be a **leaf channel** (`parent_id IS NOT NULL`) — the root container (`00000000-…-000000000001`) is rejected (`ok=false reason=invalid-channel`). `CHAN` switches the active channel for the connection (invalid IDs silently ignored). Full spec in [realtime-socket.md](../overlay/zfe/realtime-socket.md).
- **`HUD_IDENTITY_SECRET`** — HMAC-SHA256 key for identity hash derivation. Dev default allowed for the
  receive-only feed, but the **inbound path refuses to start** if it is unset/default (SR-003); set a
  strong secret to enable `HELLO`/`SEND`.
- **`HUD_PUSH_BACKFILL_ENABLED`** (default `true`) — when `false`, no backfill history is sent (poll + socket).
- **`HUD_PUSH_DIAG_LOG`** (default `false`) — when `true`, the TCP listener appends `DIAG`/`HELLO`/`SEND`
  lines to `hud-diag.log`. Off by default because `DIAG` content is unauthenticated and attacker-controlled (SR-005).
- **Rate-limit on Redis outage:** inbound `hud` messages fail **closed**; authenticated `ws` messages fail **open** (SR-004).
- **`HUD_DEFAULT_CHANNEL_ID`** (default `00000000-0000-0000-0000-000000000005` = General) — the leaf channel the SWF should use as its default send target. The backend does not auto-redirect sends; the SWF must send to this channel ID.
- **Channel eligibility:** feed SQL and live-push both use `parent_id IS NOT NULL AND NOT is_archived` — the root container is excluded. Eligible channels: General, Trading, Events, Raids.
