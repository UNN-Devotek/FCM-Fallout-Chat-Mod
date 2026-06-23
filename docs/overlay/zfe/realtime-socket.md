# ZFE Real-Time Socket (FCMHUD/1)

> ⚠️ **DEPRECATED.** FCMHUD/1 (this bespoke `color~channel~user~content` push bridge + the M7
> inbound parser) was **dev-only and never shipped to production.** It is being **retired** in favor
> of the **ZFE `chat.v1` native chat relay** — see [native-chat-relay/](native-chat-relay/README.md)
> and its [FCM integration plan](native-chat-relay/fcm-integration.md) (phase **R7** removes the
> `hudPush` TCP/WS front-ends + `/ws/hud`). Kept as reference until that retirement lands; do not
> build new work against it.

ZFE's `readRemoteData` has a 300 s cache floor — the feed can never be real-time on that path.
ZFE ships a "Text Chat bridge" (live since dxgi.dll 0.9.1) that drives a native TCP socket or a
WebSocket from AS3. FCMBridge rides that bridge to receive a live push feed from the backend.

The REST polling endpoint (`GET /api/game/hud-feed`) continues to function as the cold-start and
fallback path. See [fcmbridge-data-pattern.md](fcmbridge-data-pattern.md).

---

## Transport overview

Two back-end front-ends share one push core (`hudPush.ts`):

| Transport | Default port | Env flag | Client endpoint value |
|-----------|-------------|----------|-----------------------|
| Path A — raw TCP | 4001 | `HUD_PUSH_TCP_ENABLED=true` | `host:port` |
| Path B — WebSocket | HTTP upgrade on backend port | `HUD_PUSH_WS_ENABLED=true` | `wss://host/ws/hud` |

Both are **off by default** (`false`). Enable in `backend/.env.local` for dev.

**Dev-only guard (current state):** both `initHudPushTcp` and `initHudPushWs` hard-refuse
to start when `NODE_ENV=production`, regardless of the env flags (a warning is logged if a
flag is set). HUD push cannot reach production by configuration alone — removing this guard
is an explicit step of the M6 production-exposure milestone. Guard tests:
`backend/tests/hudPushTcp.test.js` / `hudPushWs.test.js` ("production guard" describe blocks).

### Dev / prod switch matrix

| Mode | `ZFE_TEXT_CHAT_ENDPOINT` value | Backend requirement |
|------|-------------------------------|---------------------|
| Dev TCP | `127.0.0.1:4001` | local :7177, `HUD_PUSH_TCP_ENABLED=true` |
| Dev WS | `ws://127.0.0.1:7177/ws/hud` | local :7177, `HUD_PUSH_WS_ENABLED=true` (ws:// support UNVERIFIED — see Probe findings below) |
| Hosted Dev WS | `wss://dev.falloutchatmod.com:443/ws/hud` | `cloudflared-dev` tunnel; `HUD_PUSH_WS_ENABLED=true` set in `deploy/dev/docker-compose.yml`; `NODE_ENV=development` so the prod guard permits it. **Receive-only** (inbound bytes discarded — no in-game send over WS). |
| Hosted Dev TCP (two-way) | `localhost:4001` (via `cloudflared access tcp --hostname dev-hud.falloutchatmod.com --url localhost:4001`) | backend-dev `HUD_PUSH_TCP_ENABLED=true` + `HUD_PUSH_TCP_HOST=0.0.0.0` + inline-PEM cert (`HUD_PUSH_TCP_TLS_CERT/KEY`, see `readPemValue`) + non-default `HUD_IDENTITY_SECRET`; a cloudflared **TCP route** `dev-hud.falloutchatmod.com → tcp://backend-dev:4001` (Access service-token). The **only** dev path that accepts inbound **SEND**. |

> **ZFE endpoint format requires an explicit port** (verified against 0.9.1/0.9.2):
> `ZFE_TEXT_CHAT_ENDPOINT` must be `host:port` or `wss://host:port/target` — a
> portless `wss://host/path` is rejected with `endpoint must be host:port`. ZFE
> wraps **every** endpoint (including `host:port`) in Schannel TLS and does not
> validate the cert (self-signed is fine).
| Prod TCP | `tcp.falloutchatmod.com:4001` | direct host port, unproxied DNS |
| Prod WS | `wss://falloutchatmod.com/ws/hud` | existing cloudflared tunnel, `HUD_PUSH_WS_ENABLED=true` |

Switching transport requires only a `ZFE_TEXT_CHAT_ENDPOINT` change + Steam restart.
The backend runs both front-ends simultaneously; no backend change needed to switch.

---

## ZFE environment variables (client-side)

All three are Windows env vars, User scope. Value `1` means exactly the ASCII character `1`.
A full Steam exit and relaunch is required after any change — the game inherits Steam's env block.

| Variable | Purpose | Value format |
|----------|---------|--------------|
| `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND` | Opt-in to live transport (off by default) | exactly `1` |
| `ZFE_TEXT_CHAT_ENDPOINT` | Override default endpoint | `host:port` (raw TCP) or `wss://host/path` (TLS WebSocket); default `wss://falloutchatmod.com/ws/hud` |
| `ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND` | Force-disable live transport even if opt-in is set | exactly `1` |

**Set these values:**
```powershell
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND','1','User')
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','127.0.0.1:4001','User')
# Then: fully exit Steam (File > Exit), relaunch Steam, launch game.
```

**Clear them:**
```powershell
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND',$null,'User')
# Then: fully exit Steam, relaunch.
```

`zfe.log` startup summary line (confirms the values were read):

```
text_relay_backend=<value>
```

When opt-in is not set: `Text Chat transport backend: Schannel/Winsock (opt-in-disabled)`.

---

## FCMHUD/1 wire protocol

Plain UTF-8, `\n`-terminated lines. WebSocket = same lines inside text frames; ZFE queues
WS frame bytes into one `bytesAvailable` stream so the SWF parser is transport-agnostic.

### Record lines (server -> client)

```
color~channel~user~content
```

Byte-identical to `buildFeedLines()` output — every field has passed through `zfeSafe()`.
Field widths: content truncated to 70 chars (same `MAX_LINE` as hud-feed REST). `~` separators are
guaranteed absent from field values (zfeSafe maps `~` to `∼`).

Example: `#C8A840~General~Devotek~hello world`

### Control lines (server -> client)

Control lines have fewer than 4 `~`-delimited fields. FCMBridge's `renderRecords()` guard
(`if (f.length < 4) continue`) skips them silently — no SWF change needed.

| Line | When sent | Meaning |
|------|-----------|---------|
| `HELLO~1~<n>` | Immediately on connect, before backfill | Protocol version 1; `<n>` = number of backfill lines to follow |
| `ACTIVECHAN~<channelName>` | After HELLO on connect, and after every successful `CHAN` switch | Active channel name for this connection; SWF should clear its display and show the backfill lines that follow |
| `PING~<unixSeconds>` | Every 10 s when idle | Keepalive — ZFE drops the connection after ~15 s without inbound bytes; 10 s also defeats Cloudflare's ~100 s idle WebSocket drop |

### Connect sequence

1. Server sends `HELLO~1~<backfillCount>\n`
2. Server sends `ACTIVECHAN~<channelName>\n` (default: General)
3. Server sends the last 30 messages of the **active channel only** (oldest first, `\n`-terminated)
4. Server fans out live lines as they arrive via `localBroadcast` — only lines whose `channelId` matches the connection's active channel

### Inbound lines (client → server) — M7 two-way chat

M7 adds a full line parser for inbound bytes. The old blunt 4 KB total-bytes cap is replaced with
a **per-line cap** (MAX_LINE_BYTES = 2048). Lines exceeding the cap are silently dropped; the
connection is NOT destroyed. Flood control is the shared Redis rate-limiter (`ws_rate:<userId>`).

> **Rate-limit fail behaviour (SR-004):** if Redis is unreachable during the rate-limit check,
> ingestion **fails closed for the `hud` source** (the inbound socket is unauthenticated, so its
> only flood control must not silently disappear) and **fails open for the `ws` source**
> (availability for already-authenticated users). See `ingestMessage.ts › checkRateLimit`.

> **`DIAG` verb is gated (SR-005):** the diagnostic `DIAG~<cat>~<msg>` verb writes attacker-controlled,
> unauthenticated content to `hud-diag.log`. Disk writes are **off by default** and only happen when
> `HUD_PUSH_DIAG_LOG=true` (local debugging only) — this removes a disk-fill / log-injection vector.

The parser recognises these verbs (UTF-8, `\n`-terminated, `~`-delimited, ALL-CAPS):

| Verb | Format | Action |
|------|--------|--------|
| `HELLO` | `HELLO~<accountName>~<characterName>` | Identity handshake — must arrive before any SEND. Backend derives `identityHash = HMAC-SHA256(HUD_IDENTITY_SECRET, accountName)`, resolves/provisions a user (see Identity section below), checks the ban blocklist. |
| `SEND` | `SEND~<channelId>~<text>` | Ingest as a real chat message via `ingestMessage()`. Only honoured after a successful `HELLO`. Content starting with `/` is dropped (slash commands out of scope for v1). **channelId must be a leaf channel** (`parent_id IS NOT NULL`) — sends to a container channel return `ok=false reason=invalid-channel`. Default send target: `HUD_DEFAULT_CHANNEL_ID` (General, `00000000-…-000000000005`). |
| `CHAN` | `CHAN~<channelId>` | Switch the active channel for this connection. Server validates that `channelId` is a known, non-archived leaf channel (`parent_id IS NOT NULL`); invalid/unknown IDs are silently ignored. On success: server responds with `ACTIVECHAN~<channelName>\n` followed by the last 30 messages of the new channel (oldest first). The SWF should clear its display on `ACTIVECHAN` and render the history that follows. Live push is then filtered to the new channel only. |

Unknown verbs (e.g. legacy `AUTH2:`, `JOIN:`) are silently ignored.

**HELLO timeout:** a socket that sends no valid `HELLO` within 10 s is destroyed.

#### Identity model

- `identityHash = HMAC-SHA256(HUD_IDENTITY_SECRET, accountName)` — stable, server-side, non-correlatable key. Moderation target ("Discord ID" equivalent for HUD users).
  - **Fail-closed on default secret (SR-003):** if `HUD_IDENTITY_SECRET` is unset or still the dev default (`dev-hud-identity-secret-change-me`), `initHudPushTcp` **refuses to start the inbound path** — a known key makes `identityHash` forgeable. The receive-only feed is unaffected; only inbound `HELLO`/`SEND` is gated.
- `fo76CharacterName` — reconciled on every connect (renamed characters get the new name, same userId).

**Resolution priority on HELLO:**
1. Existing user already linked to this `identityHash` → use it; reconcile character name if changed.
2. Exactly one unlinked user whose `fo76CharacterName` matches → auto-pair (attach `identityHash`). Two+ matches → fall through to #3 (ambiguity guard).
3. Auto-provision a new lightweight user keyed on `identityHash`.

**Ban check at HELLO:** if `HudIdentityBlock` has an active `ban` entry for the hash, the socket is destroyed immediately.

**Mute check at SEND:** `ingestMessage` checks both the user's `isMuted` flag and any active `mute` block in `HudIdentityBlock`. Muted messages are dropped silently.

---

## Backend architecture

```
localBroadcast() in handlers.ts
  |
  +-- hudPushNotify(payload)   [hudPush.ts]
        |
        filter: type==='chat:message' && !isPrivate
        |
        resolveChannel(channelId) -- 60s TTL cache, Prisma lookup
        |
        isHudEligibleChannel(): parentId===null && !isArchived
        |
        buildFeedLines([row])  -- identical format to backfill
        |
        per-client filter: client.activeChannelId === channelId
        |
        fan-out to matching HudPushClient instances only
              |
              +-- HudPushClient {transport:'tcp', activeChannelId} --> hudPushTcp.ts --> net.Socket.write()
              +-- HudPushClient {transport:'ws',  activeChannelId} --> hudPushWs.ts  --> ws.send()
```

### hudFeedService.ts (shared core)

Extracted from `routes/hudFeed.ts`. Both the REST route and the push path reuse:

- `zfeSafe(s)` — strips `"`, `\`, `|`, `~`, `<`, `>`, `&`, newlines
- `buildFeedLines(rows)` — renders `color~channel~user~content` records
- `fetchFeedRows(limit?)` — the hud-feed SQL (returns rows newest-first; caller reverses)
- `FEED_LIMIT = 30`, `MAX_LINE = 70`

### hudPush.ts (transport-agnostic core)

- `registerClient(client)` — adds to registry, fires async `HELLO~1~<n>` + `ACTIVECHAN~<name>` + channel-filtered backfill (fire-and-forget). Default active channel: `HUD_DEFAULT_CHANNEL_ID` (General).
- `switchClientChannel(client, channelId)` — validates channel is a non-archived leaf; updates `client.activeChannelId`; sends `ACTIVECHAN~<name>` + last 30 messages of the new channel (fire-and-forget). Invalid IDs are silently ignored.
- `hudPushNotify(payload)` — called from `localBroadcast()` in `handlers.ts`; filters, formats, fans out to clients whose `activeChannelId === channelId` only (per-connection channel filter).
- `isHudEligibleChannel(info)` — single predicate: `parentId !== null && !isArchived` (leaf channels only; root container excluded)
- `HudPushClient.activeChannelId` — per-connection active channel; set on construction (default General) and mutated by `switchClientChannel`.
- 10 s `PING` heartbeat (ZFE ~15 s idle receive timeout) via `setInterval` (`.unref()`-ed so it does not block process exit)
- Channel info cached 60 s (TTL `CHANNEL_CACHE_TTL_MS`); injectable resolver + feed-fetcher for unit tests

**Channel eligibility — leaf channels only:** Both the feed SQL and the live-push predicate
select `parent_id IS NOT NULL AND NOT is_archived`. The root "Fallout 76" channel
(`00000000-…-000000000001`, `parent_id IS NULL`) is a container and is excluded. Only leaf
channels (General `…0005`, Trading `…0002`, Events `…0003`, Raids `…0004`) appear in the feed
or receive live-push lines.

**HUD send guard:** `ingestMessage` rejects any `SEND` from the `hud` source whose `channelId`
resolves to a container channel (`parentId IS NULL`) — returns `ok=false reason=invalid-channel`.
The SWF default send target must be a leaf channel (see `HUD_DEFAULT_CHANNEL_ID` below).

### hudPushTcp.ts (Path A)

- **TLS required for ZFE** (see Probe findings below). When `HUD_PUSH_TCP_TLS_CERT` + `HUD_PUSH_TCP_TLS_KEY` are both set: `tls.createServer` is used. When either is empty: `net.createServer` (plaintext — ZFE cannot connect). On cert-read failure the server refuses to start (does not silently fall back to plaintext).
- Bound to `HUD_PUSH_TCP_HOST:HUD_PUSH_TCP_PORT` (default `127.0.0.1:4001`)
- Enabled only when `HUD_PUSH_TCP_ENABLED=true`
- Per-IP cap: 3 concurrent connections (`tcpConnsByIp` Map)
- `socket.setNoDelay(true)`, `socket.setKeepAlive(true, 30000)`
- Destroys socket when `writableLength > 64 KB` (checked on send + 5 s interval)
- Destroys socket when inbound bytes exceed 4 KB
- Started from `server.ts start()` after `initPubSub()`
- Dev cert: `backend/certs/dev/hud-push.{crt,key}` (gitignored). Regenerate from `backend/`:
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/dev/hud-push.key -out certs/dev/hud-push.crt -days 730 -subj "/CN=fcm-hud-dev"
  ```

### hudPushWs.ts (Path B)

- `noServer: true` WebSocketServer; manual `server.on('upgrade')` handling
- Routes only `pathname === '/ws/hud'`; leaves all other paths untouched so the chat `/ws` router can claim them

> **Upgrade routing (fixed 2026-06-21).** The main chat server was
> `new WebSocketServer({ server, path: '/ws' })`, whose auto-attached upgrade
> handler aborts **every** non-`/ws` upgrade with **HTTP 400** — and it runs
> before hudPushWs's listener, so `/ws/hud` was killed before it could be
> claimed. Path B was therefore never reachable end-to-end (hence the earlier
> "ws:// UNVERIFIED" note). Fix: the chat server is now `noServer: true` behind
> `backend/src/websocket/upgradeRouter.ts` (`attachChatUpgradeRouter`) — `/ws` →
> chat (`verifyClient` still runs inside `handleUpgrade`), `/ws/hud` is left for
> hudPushWs, all other paths are rejected. Tests:
> `backend/tests/upgradeRouter.test.js`.

- Enabled only when `HUD_PUSH_WS_ENABLED=true`
- Per-IP cap: 3 concurrent connections (`wsHudConnsByIp` Map)
- No auth, no Origin check — game client sends no/odd Origin; feed is public read-only
- Destroys connection when inbound bytes exceed 4 KB
- `maxPayload: 8192` (slightly above the 4 KB inbound cap so the message handler applies the limit cleanly)
- Lines sent as WS text frames with `\n` appended (same framing as TCP)

### SPA catch-all skip

`server.ts:1671` — the Express SPA catch-all skips paths starting with `/ws/`:

```ts
if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') ||
    req.path === '/ws' || req.path.startsWith('/ws/')) {
  return next();
}
```

This ensures HTTP GET to `/ws/hud` is not served the dashboard HTML before the WS upgrade handler runs.

---

## SWF crash hard rules

**These rules apply to all FCMBridge SWF code — violations have crashed the game in production.**

1. **NO `GlowFilter` or any `filters` array** — crashes Scaleform on FO76.
2. **NO HTML entities** (`&amp;`, `&lt;`, etc.) in `htmlText` — crashes Scaleform on FO76.
3. Live content is `zfeSafe()`-d server-side before fan-out; `renderRecords()` in the SWF is reused unmodified.
4. On-screen debug panels: use `tf.text` (plain text), NOT `tf.htmlText`. No `TextFormat.color` dynamic assignment via filters.

---

## zfe.log oracle lines

When the live transport is working, these lines appear in `<game>\zfe.log` in order:

| Log line (partial) | Meaning |
|--------------------|---------|
| `text_relay_backend=` | Startup env summary — confirms `ZFE_TEXT_CHAT_ENDPOINT` was read |
| `registered AS3 socket object for native state write-back` | `register()` call succeeded; ZFE will write `connected`/`bytesAvailable` onto the AS3 sock object |
| `async connect completed: connected= bytesAvailable=` | Native TCP/WS connect completed |
| `queued received bytes=` | Server data arrived and was queued for the SWF to read |

Absence of the `registered` line = the `register()` call shape was wrong (see Probe findings below).

---

## Probe tooling (M0)

### SocketProbe.hx

`game-mods/FCMBridge/SocketProbe.hx` — diagnostic SWF that probes ZFE's socket bridge.
Built in place of `FCMBridge.swf` for one or more probe game launches.

**What it does:**

1. Enumerates `__ZFE`, `__SFCodeObj`, `ZFECodeObj` candidates; logs `typeof` of each socket field
2. Calls `probe` / `__zfe_probe` in direct and `.call()` forms
3. Tries `register(sock)`, `register(sock, "FCMBridge")`, `call("register", sock)` — logs `__zfe_registered_socket` marker appearance
4. Tries `connect()`, `connect("127.0.0.1", 4001)`, `connect("127.0.0.1", "4001")` at 0/10/20 s intervals
5. 100 ms drain timer for 45 s: logs every change of `connected`/`bytesAvailable`; tries `readUTFBytes(n)` and `readUTFBytes()` on bytes available

All output goes to `zfe.log` (vendor=FCMBridge, category=socketprobe) AND an on-screen text panel.

**Build:**

```bash
cd game-mods/FCMBridge
/mnt/c/Users/White/scoop/shims/haxe.exe --main SocketProbe --swf SocketProbe.swf --swf-version 32
python3 -c "
with open('SocketProbe.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"
```

**Deploy (replaces FCMBridge.swf for the probe run):**

```bash
# Back up production SWF first
cp "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf" \
   "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf.pre-probe.bak"

cp SocketProbe.swf "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf"
```

**Restore after probe run:**

```bash
cp "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf.pre-probe.bak" \
   "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf"
```

### probe-listener.ps1

`game-mods/FCMBridge/tools/probe-listener.ps1` — Windows TCP listener for sanity-checking the
server side during M0. Run on the Windows side before launching the probe game:

```powershell
# From game-mods/FCMBridge/tools/ (Windows path)
.\probe-listener.ps1 -Port 4001 -BindAddr 127.0.0.1
```

Sends `HELLO~1~3` + three test record lines on connect; sends `PING~<n>` every 10 s.
Logs all inbound bytes (text + hex) with timestamps to console and `probe-listener.log`.

**For the actual M0 run**, start the real backend (TCP enabled) instead of this script — it sends proper backfill.

---

## Probe findings (probe runs 1-2, 2026-06-10)

Confirmed by SocketProbe v1/v2 in-game runs, correlated against ZFE's native zfe.log lines.

| Question | Answer |
|----------|--------|
| Winning bridge object | The legacy `__SFCodeObj` (BRG_OBJ) instance found by walking the **parent chain** from the widget (also present on stage children). `ZFECodeObj` instances are modern-API-backed and reject all socket commands with `unsupported_command`. `__ZFE` has no socket commands. |
| Method form | **`.call()` only** — NO direct methods exist on any bridge object (`typeof register/connect/... === null` everywhere). |
| Working `register` form | `BRG_OBJ.call("register", sockObj)` — native logs `retained AS3 socket object` + `registered AS3 socket object for native state write-back`. `sockObj` is a plain `{}` pre-seeded with `connected:false, bytesAvailable:0`. NOTE: returns a generic `true` and the `__zfe_registered_socket` marker was NOT observed on the SWF side — the native zfe.log line is the only reliable success signal. Do NOT pre-seed dynamic fields on a Haxe class instance (sealed class → ReferenceError #1056); use an anonymous object. |
| Working `connect` form | `BRG_OBJ.call("connect")` — no args needed; native logs `socket call completed: connect (socket connecting to <endpoint>)`. |
| Endpoint source | Native side uses `ZFE_TEXT_CHAT_ENDPOINT` exclusively; SWF-passed host/port are accepted but irrelevant. |
| **Transport is TLS (Schannel) — ALWAYS** | Even for plain `host:port` endpoints, ZFE wraps the TCP connection in Schannel TLS (TLS 1.2 verified). Against a plaintext listener the handshake fails with `InitializeSecurityContextW failed with status -2146893032`. **The backend HUD push TCP front-end must be TLS-served.** |
| TLS certificate validation | **None observed** — ZFE connected to a self-signed cert (CN=fcm-hud-dev, not in any trust store) with `connected=true error=''`. Dev story: `tools/probe-listener-tls.ps1` auto-generates the cert; backend TCP front-end mirrors this with a dev PEM. |
| Read semantics (verified end-to-end 2026-06-10 18:14) | `connected`/`bytesAvailable` write-backs land on the registered `{}` within one 100 ms tick (`queued received bytes=` native line). `call("readUTFBytes")` (no arg) drains the whole buffer as a string; `call("readUTFBytes", n)` reads up to n bytes; `call("readByte")` consumes ONE byte and returns its Int value — never mix it with string reads (it ate the `H` of `HELLO`). Wrapper rule: **use `readUTFBytes()` only.** |
| Write path | `call("writeUTFBytes", str)` returns `true` and the bytes arrive at the server immediately; `call("flush")` returns `false` (no-op — writes auto-flush). v1 wrapper sends nothing. |
| `ws://` scheme support | UNTESTED — moot for dev (TCP+TLS works); prod Path B uses `wss://` regardless. |
| `zfe.ini` opt-in support | PENDING (matters for the installer story, not for dev). |

**Implemented wrapper (M3 — `game-mods/FCMBridge/FCMBridge.hx`):** find the legacy `__SFCodeObj`
by walking the parent chain (the modern-API decoys answer `call("__zfe_probe")` with a string
containing `unsupported_command`; the legacy bridge returns plain `false`); `call("register", sock)`
with `sock = {connected:false, bytesAvailable:0}` (anonymous object — adding fields to a Haxe class
instance throws #1056); `call("connect")` (endpoint comes from `ZFE_TEXT_CHAT_ENDPOINT`); 100 ms
drain loop polling `sock.connected`/`sock.bytesAvailable`, reading with `call("readUTFBytes")`;
reconnect = `call("connect")` again (native logs "connecting to ... after previous failure" and
recovers).

**State machine summary:**
1. After `init()`, discover legacy bridge → `register` once → `connect` → start 100 ms drain timer.
2. If bridge not found: warn once, stay on readRemoteData polling forever.
3. Drain tick: if not connected → schedule reconnect with 2 s→60 s exponential backoff; if
   connected + bytes available → `readUTFBytes()` → append to `_lineBuf` → split on `\n`. Control
   lines (`<4` tilde-fields) update `_lastLineAt`; record lines are pushed into a MAX_MSGS=8 ring
   and rendered via `renderRecords()`.
4. First complete line (control or record) → `_liveActive=true`, polling stopped.
5. Watchdog: if `_liveActive` and no line for 180 s (PINGs arrive every 10 s) → `_liveActive=false`,
   resume polling, schedule reconnect.
6. **Pre-live stale-connection nudge:** ZFE's native `connected` flag can stay stale-true after
   the transport dies (observed after a mid-session HUD reload: the new SWF instance re-registers,
   `connect()` no-ops with "(socket connected)", and no bytes ever arrive). If the instance shows
   `connected==true` but has NEVER received a line and 30 s have passed since its last `connect()`,
   the wrapper calls `call("close")` (may be unsupported — logged) then `call("connect")` to force
   the native side to rebuild the transport. Repeats every 30 s until the first line lands.
7. Backoff resets to 2 s whenever `sock.connected` becomes true.
8. Mid-session HUD reloads are expected: each new SWF instance re-registers (native retains the
   newest object) and the live byte stream simply follows it.

**zfe.log to collect during probe:**
- Full startup section (especially `text_relay_backend=` line)
- All `socketprobe` category lines
- `registered AS3 socket object` line (or its absence)
- `async connect completed` line
- `queued received bytes` lines
