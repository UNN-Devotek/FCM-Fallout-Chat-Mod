# FCMBridge

A Fallout 76 HUDModLoader widget that displays the Fallout Chat Mod community chat feed inside
the in-game HUD. It connects to the FCM backend — not to the game's memory or network state.

## What it does

FCMBridge renders live community chat (General / Trading / Events / Raids) as styled htmlText in
the Scaleform overlay. Two delivery paths are implemented:

### Polling path (cold-start / fallback)

FCMBridge calls `ZFE.readRemoteData({vendor:"FCMBridge", key:"hud-feed"})` which triggers
`GET /api/game/hud-feed`. ZFE caches responses for at least 300 s, so this path updates at most
once per ~5 minutes. It is the default path and requires no extra setup beyond the ZFE
configuration files shipped with the mod.

### Real-time push path (live feed — M3, implemented)

When `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1` is set, ZFE's Text Chat bridge opens a TLS TCP or
WebSocket connection to the backend. The SWF receives `\n`-terminated FCMHUD/1 lines — the same
`color~channel~user~content` format as polling, plus control lines (`HELLO`, `PING`).

The real-time wrapper is fully implemented in `FCMBridge.hx` (M3). The SWF discovers the legacy
`__SFCodeObj` bridge via parent-chain walk, registers an anonymous socket object, calls `connect()`,
and drains bytes every 100 ms. On first socket line the polling path stops; on socket death a 180 s
watchdog resumes polling and reconnects with 2 s→60 s exponential backoff. See
[docs/overlay/zfe/realtime-socket.md](../../docs/overlay/zfe/realtime-socket.md) for the full
state machine and probe findings.

## Files

| File | Purpose |
|------|---------|
| `FCMBridge.hx` | Main SWF source — polling feed display, `renderRecords`, `zfeLog`, `findZfeApi` |
| `SocketProbe.hx` | M0 diagnostic SWF — probes ZFE's socket bridge call shapes (deployed instead of FCMBridge.swf for probe runs) |
| `FCMBridge.swf` | Compiled and version-byte-patched output (deployed to game) |
| `tools/probe-listener.ps1` | Windows TCP echo listener for M0 probe sanity check |

## Build requirements

- Haxe 4.3+ (`scoop install haxe` on Windows)
- Python 3 (for the mandatory SWF version-byte patch)

## Build & Deploy (every change)

```bash
cd game-mods/FCMBridge

# 1. Compile FCMBridge (or SocketProbe for a probe run)
/mnt/c/Users/White/scoop/shims/haxe.exe --main FCMBridge --swf FCMBridge.swf --swf-version 32

# 2. Patch SWF version byte (MANDATORY -- haxe writes byte 43; game requires 32)
python3 -c "
with open('FCMBridge.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"

# 3. Deploy to game
cp FCMBridge.swf "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf"
```

Full build loop and iteration checklist: **[docs/overlay/zfe/fcmbridge-data-pattern.md](../../docs/overlay/zfe/fcmbridge-data-pattern.md)**

## Deploying SocketProbe for probe runs

```bash
# Back up the production SWF
cp "/mnt/d/SteamLibrary/.../FCMBridge.swf" \
   "/mnt/d/SteamLibrary/.../FCMBridge.swf.pre-probe.bak"

# Build and deploy SocketProbe as FCMBridge.swf
/mnt/c/Users/White/scoop/shims/haxe.exe --main SocketProbe --swf SocketProbe.swf --swf-version 32
python3 -c "
with open('SocketProbe.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"
cp SocketProbe.swf "/mnt/d/SteamLibrary/.../FCMBridge.swf"

# After the probe run, restore
cp "/mnt/d/SteamLibrary/.../FCMBridge.swf.pre-probe.bak" \
   "/mnt/d/SteamLibrary/.../FCMBridge.swf"
```

Run `tools/probe-listener.ps1` on port 4001 (or the full backend with TCP enabled) before
launching the game. All probe output goes to `zfe.log` (category=socketprobe) and an on-screen panel.

## Installation (end-user)

1. Copy `dxgi.dll` to the Fallout 76 root directory (ZFE itself)
2. Copy `Data/configuration/zfe.ini` to `<game>/Data/configuration/` AND `Documents/My Games/Fallout 76/configuration/` (CRLF line endings)
3. Copy `Data/ZFE/RemoteData/sources/FCMBridge.ini` to the same path under the game directory
4. Copy `FCMBridge.swf` (or the `.ba2`) to `<game>/Data/interface/`
5. Add FCMBridge to `hudmodloader.ini` (requires HUDModLoader)

For dev/localhost testing, also set `ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT=1` (User env var)
and add `AllowLocalhostDevelopment=yes` to `zfe.ini`. See
[docs/overlay/zfe/env-vars.md](../../docs/overlay/zfe/env-vars.md).

## Crash hard rules

**Violations have crashed the game in production — do not reintroduce these:**

- **NO `GlowFilter` or any `filters` array** on Scaleform display objects
- **NO HTML entities** (`&amp;`, `&lt;`, etc.) anywhere in `htmlText`
- On-screen debug panels: use `tf.text` (plain), never `tf.htmlText`

## Two-way in-game chat (M7 -- FCMChat.ba2)

Milestone M7 adds a chat INPUT to FCMBridge: press INSERT in-game to focus a
text field, type a message, press ENTER to send it to the FCM backend.  The
message is ingested, broadcast to all connected clients, and echoes back into
the live feed within ~1 second.

### How it works

The input chain follows the mechanism used by the original FO76 Text Chat mod
(fully documented in docs/overlay/zfe/textchat-blueprint.md):

1. HUDMenu.swf is REPLACED with a patched copy (Path A).  Because we ARE the
   engine's HUDMenu, ProcessUserEvent delivers INSERT key-up events to our code.
2. enterChatMode() sets stage.focus to the input TextField and dispatches
   BSUIDataManager "ControlMap::StartEditText" -- this suspends WASD/game input
   for the duration (you can type safely).
3. On ENTER, writeUTFBytes("SEND~<channelId>~<text>\n") is called on the legacy
   __SFCodeObj socket (same bridge FCMBridge already uses for the read feed).
4. A HELLO line is sent once per connection (after connect()) with the player's
   accountName and characterName read from BSUIDataManager.  The backend uses
   these to identify the sender without any login flow.
5. On ESC or ENTER, resetChatMode() returns stage.focus to stage and dispatches
   "ControlMap::EndEditText" to resume game input.

### Single-.ba2 install (ini-line method)

Everything ships in one file: FCMChat.ba2 (BTDX/GNRL format).

Contents:
  interface/HUDMenu.swf    -- the patched HUDMenu (replaces the vanilla copy)
  configuration/fcmchat.ini -- default chat settings

Install:
1. Copy FCMChat.ba2 to <game>\Data\
2. Add to Fallout76Custom.ini under [Archive]:
     sResourceArchive2List = FCMChat.ba2
3. Set ZFE env vars (see below) and restart Steam.

This is the standard Bethesda-sanctioned UI modding approach.  It does NOT
require HUDModLoader for the chat input path (HUDModLoader is still used for
the existing FCMBridge read-feed widget).

### ZFE dependency

Two-way chat requires ZFE's Text Chat native bridge (__SFCodeObj) for the
socket, which is the same dependency as the existing M3 real-time feed.  The
user must have ZFE installed and the live transport enabled:

  ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1  (Windows User env var)
  ZFE_TEXT_CHAT_ENDPOINT=<host:port>   (e.g. 127.0.0.1:4001 for dev)

See docs/overlay/zfe/realtime-socket.md for the full env var reference.

### Re-merge caveat

Because FCMChat.ba2 contains a full copy of HUDMenu.swf, every Bethesda patch
that updates the vanilla HUDMenu requires a re-merge: extract the new vanilla
SWF, diff against the previous vanilla, re-apply our additions, recompile, and
repack.  The additions are isolated in game-mods/FCMBridge/hudmenu-chat/ to
make this as mechanical as possible.  See the BUILD.md in that folder.

### Source and build guide

  game-mods/FCMBridge/hudmenu-chat/FCMChatPatch.as  -- all AS3 additions
  game-mods/FCMBridge/hudmenu-chat/fcmchat.ini      -- default config
  game-mods/FCMBridge/hudmenu-chat/BUILD.md         -- step-by-step build guide

---

## Documentation

| Doc | What it covers |
|-----|---------------|
| [docs/overlay/zfe/fcmbridge-data-pattern.md](../../docs/overlay/zfe/fcmbridge-data-pattern.md) | Pipeline, payload format, every pitfall, build loop |
| [docs/overlay/zfe/realtime-socket.md](../../docs/overlay/zfe/realtime-socket.md) | Live push path, FCMHUD/1 protocol, env vars, probe tooling |
| [docs/overlay/zfe/env-vars.md](../../docs/overlay/zfe/env-vars.md) | All ZFE env vars (remote data + live feed) |
| [docs/overlay/zfe/README.md](../../docs/overlay/zfe/README.md) | ZFE integration overview |
| [docs/overlay/zfe/textchat-blueprint.md](../../docs/overlay/zfe/textchat-blueprint.md) | Text Chat decompile -- the mechanism M7 mimics |
| [docs/overlay/zfe/two-way-chat-implemented.md](../../docs/overlay/zfe/two-way-chat-implemented.md) | M7 implementation — exact working pattern, design constraints, known gaps |
