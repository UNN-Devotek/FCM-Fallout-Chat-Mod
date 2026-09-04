# FCMBridge

A Fallout 76 HUDModLoader widget that displays the Fallout Chat Mod community chat feed inside
the in-game HUD. Connects to the FCM backend via **ZFE chat.v1** or xScal `chatInterface` — not to the
game's memory or network state.

## Transport: automatic ZFE/xScal selection

FCMBridge uses ZFE's **standardized native chat relay protocol** (`chat.v1`) or xScal's
`chatInterface` under `__SFECodeObj` or `__SFCodeObj` instead of the legacy bespoke FCMHUD/1
socket layer. The SWF
normalizes both provider surfaces to the same connect/poll/send/auth flow:

```actionscript
__ZFE.call("chat.v1.connect",    payload)  // register + connect; displayName from AccountInfoData
__ZFE.call("chat.v1.pollEvents", payload)  // poll every 2s; cursor-based dedup
__ZFE.call("chat.v1.sendMessage",payload)  // send on the active channel
__ZFE.call("chat.v1.getAuthState","{}") // connection health check
```

The SWF never sees the raw relay token. ZFE stores it in a DPAPI-protected file and
re-presents it via `hello` on each session.

At startup the SWF probes exposed Scaleform bridge objects, prefers a valid ZFE bridge for
backwards compatibility, and otherwise selects xScal. xScal exposes both the chat surface
(`chatInterface` under either `__SFECodeObj` or `__SFCodeObj`) and, in current builds, may also
expose a separate call-only `__SFCodeObj` callback object. The latter is not treated as ZFE.
xScal's chat bridge does not expose ZFE's native text-edit buffer, so the HUD widget uses
SharedHUDTools input on xScal and
does not send unsupported editor commands to it.

The capability probe is provider-specific: ZFE receives `chat.v1.getRuntimeInfo`, while xScal
receives `getRuntimeInfo` through `chatInterface` (when available). The widget never sends a
ZFE verb through xScal's generic callback object.

xScal's `connect` completes asynchronously. FCM treats
`success:true,status:"connecting"` as a pending native transport, keeps polling its auth state,
and does not call `connect` again until xScal reports a terminal failure. A separate generic
`__SFCodeObj.call` may be used for the `log` diagnostic only; it is never a fallback chat
dispatcher. This policy is shared by the modern HUDModLoader widget and the legacy bridge.

## What it does

FCMBridge renders live community chat (General / Trading / Events / Infests / Raids) as styled
htmlText in the Scaleform overlay. Channel slugs and their FCM mappings:

| Slug | FCM target | Notes |
|------|-----------|-------|
| `global` | General | broad default |
| `trade` | Trading | |
| `events` | Events | custom slug via AllowedChannels |
| `infests` | Infests | custom slug |
| `raids` | Raids | custom slug |
| `server` | world-session room | dynamic; worldId-bound by relay |

The active channel is tracked by the patched HUDMenu and communicated to FCMBridge via
`fcmSwitchChannelTo(idx)`. Sends go through `fcmSendMessage(body, channelSlug)`.

## Auth state gate (limited vs authenticated)

When a player has not yet linked their FCM account, the relay returns `state:"limited"` from
`chat.v1.getAuthState`. FCMBridge tracks this in `_authState` and enforces two behaviours:

### 1. Pinned link-code notice

The relay pushes a system event over the poll/subscribe stream:

```json
{ "kind": "chat.message", "channel": "system", "senderUserId": "system",
  "senderDisplayName": "FCM",
  "body": "LINK REQUIRED - visit falloutchatmod.com/link, sign in, and enter code: XXXX-XXXX (expires 10m)" }
```

FCMBridge special-cases `channel === "system"` or `senderUserId === "system"`: it stores the
body in `_pinnedSystemBody` and renders it **above the message feed** (prefixed with `** ... **`)
on every render cycle. It is never scrolled off. If the relay re-emits the notice with a
refreshed code the pin is updated automatically.

### 2. Send gate

`fcmSendMessage(body, slug)` returns immediately (logs a warn) when `_authState != "authenticated"`.
The public `fcmCanSend():Bool` method exposes this for the injected HUDMenu code:

- `fcm-inject.as` calls `fcmCanSend()` **before** calling `fcmSendMessage`. If false it calls
  `fcmShowAuthHint(fcmLinkHint())` which writes the link-code text into the chat input bar
  in amber and returns without sending.
- `fcmSendMessage` also enforces the gate defensively (double gate).

The worldId control message (`sendWorldIdControl`) bypasses the send gate — it is an internal
relay signal, not player-visible chat, and must fire regardless of link state to keep the
server-channel room binding correct.

## worldId self-read (#293, EULA §4(F)-safe)

FCMBridge reads `worldId` from `BSUIDataManager.GetDataFromClient("AccountInfoData")` — the
same sanctioned UI-layer surface the game uses for HUD rendering. No game-memory reads,
no injection, no network scanning. On world transition it emits a reserved control message
over `chat.v1.sendMessage` (channel `server`, body signed with HMAC-SHA256) that the relay
intercepts, never broadcasts, and uses to bind the subscriber to the correct world room.

## Files

| File | Purpose |
|------|---------|
| `FCMBridge.hx` | Main SWF source — chat.v1 client, render loop, worldId read + HMAC |
| `FcmNativeApi.hx` | Shared automatic ZFE/xScal discovery and verb adapter |
| `FCMBridge.swf` | Compiled + version-byte-patched output (SWF v32, deploy to game) |
| `Data/ZFE/TextChat/fragments/FCM.ini` | TextChat fragment (AllowedChannels, Endpoint, OpenChatKey) |
| `hudmenu-chat/apply-patch.py` | Injects `fcm-inject.as` into vanilla HUDMenu.as |
| `hudmenu-chat/fcm-inject.as` | Injected AS3 — HUDMenu input chain + FCMBridge delegation |
| `hudmenu-chat/test_anchors.py` | Anchor assertions for apply-patch.py (runnable on Linux) |
| `hudmenu-chat/BUILD.md` | Step-by-step build guide |
| `SocketProbe.hx` | M0 diagnostic SWF for ZFE API probing (not part of release) |

## Build requirements

- Haxe 4.3+ (`scoop install haxe` on Windows)
- Python 3 (for `apply-patch.py`, `test_anchors.py`, and the version-byte patch)
- ZFE 0.9.8+ installed in the game (requires `zfe-chat-online-v1`) **or** xScal
  installed with its `[Chat]` relay configuration and `chatInterface` enabled
- Archive2.exe (ships with CK) to pack the `.ba2`

**Haxe is Windows-only in this project.** The Linux CI can run `test_anchors.py` and the
Vitest SWF shape guard, but the Haxe compile, ffdec recompile, and Archive2 pack must run
on Windows (see Phase 7).

## Build and deploy (every change to FCMBridge.hx)

```bash
cd game-mods/FCMBridge

# 1. Compile FCMBridge (Windows only -- Haxe not available on Linux)
haxe --main FCMBridge --swf FCMBridge.swf --swf-version 32

# 2. Patch SWF version byte (MANDATORY -- haxe writes byte 43; game requires 32)
python3 -c "
with open('FCMBridge.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"

# 3. Verify
python3 -c "print(open('FCMBridge.swf','rb').read(4)[3])"  # must print 32

# 4. Deploy to game for testing
cp FCMBridge.swf "<FO76>\Data\interface\FCMBridge.swf"
```

Full build pipeline including HUDMenu patch + Archive2 pack: **[hudmenu-chat/BUILD.md](hudmenu-chat/BUILD.md)**

## Anchor test (runnable on Linux)

```bash
cd game-mods/FCMBridge/hudmenu-chat
python3 test_anchors.py               # tests fcm-inject.as + FCMBridge.hx + FCM.ini
python3 test_anchors.py path/to/HUDMenu.as  # also checks all 6 HUDMenu injection anchors
```

All 78 assertions should pass. Run this before patching any new `HUDMenu.as`.

## Installation (end-user, standalone)

1. Copy `FCM-standalone.ba2` to `<FO76>\Data\`.
2. Add to `Fallout76Custom.ini` under `[Archive]`:
   ```
   sResourceArchive2List = FCM-standalone.ba2
   ```
3. Ensure ZFE 0.9.8+ (`dxgi.dll`) **or xScal** is installed and its chat relay is enabled.
   No env vars are needed for prod. If using xScal, merge the `[Chat]` section from
   `hudmodloader-chat/xscal.ini.example` into the existing `xscal.ini` beside the game executable.
4. For dev/localhost testing, set in `Data/configuration/zfe.ini`:
   ```ini
   [TextChat]
   Endpoint=ws://127.0.0.1:8788/
   ```

## Crash hard rules

**Violations have crashed the game in production -- do not reintroduce these:**

- **NO `GlowFilter` or any `filters` array** on Scaleform display objects
- **NO HTML entities** (`&amp;`, `&lt;`, etc.) anywhere in `htmlText`
- On-screen debug panels: use `tf.text` (plain), never `tf.htmlText`

## What changed from FCMHUD/1

| FCMHUD/1 (removed) | chat.v1 (current) |
|---|---|
| `__SFCodeObj` legacy bridge discovery (parent-chain walk) | `__ZFE.call("chat.v1.*")` directly |
| `register(anon_obj)` / `connect()` / `readUTFBytes()` / `writeUTFBytes()` | `chat.v1.connect`, `pollEvents`, `sendMessage` |
| `color~channel~user~content` line parsing | JSON event objects from `pollEvents` |
| `HELLO~accountName~characterName` identity | ZFE DPAPI token + relay-issued `userId` |
| `SEND~<channelUUID>~<text>` outbound | `chat.v1.sendMessage {channel:slug,body}` |
| `CHAN~<channelUUID>` channel switch | `fcmSwitchChannelTo(idx)` via FCMBridge public API |
| `ACTIVECHAN` / `PING` control lines | cursor-based poll; auth state via `getAuthState` |
| `BRG_OBJ` TCP socket on port 4001 | ZFE-owned WebSocket at `Endpoint` from fragment |
| Channel UUIDs in SWF | Channel slugs only; relay owns UUID mapping |
| `DIAG~cat~msg` diagnostic line | `zfeLog` via `__ZFE.call("log", ...)` |

---

## Documentation

| Doc | What it covers |
|-----|---------------|
| [docs/overlay/zfe/native-chat-relay/protocol-spec.md](../../docs/overlay/zfe/native-chat-relay/protocol-spec.md) | chat.v1 call surface (connect/pollEvents/sendMessage/getAuthState) |
| [docs/overlay/zfe/native-chat-relay/fcm-integration.md](../../docs/overlay/zfe/native-chat-relay/fcm-integration.md) | FCM relay adapter design, worldId scheme (#293), channel mapping |
| [docs/overlay/zfe/env-vars.md](../../docs/overlay/zfe/env-vars.md) | ZFE env vars |
| [docs/overlay/zfe/README.md](../../docs/overlay/zfe/README.md) | ZFE integration overview |
