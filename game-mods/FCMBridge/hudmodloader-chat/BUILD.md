# FCMChatWidget — Build & Install Guide (chat.v1)

## What this builds

`FCMChatWidget.swf` inside `FCMChatWidget.ba2` — a HUDModLoader widget that renders
FCM community chat inside Fallout 76's HUD, using the ZFE chat.v1 native API (ZFE 0.9.8+).

The widget:
- Discovers `__ZFE` on the parent HUDMenu frame via `findZfeApi()` — no env-var or
  `child_bridge_access` workaround needed. HUDModLoader's `ApplicationDomain.currentDomain`
  puts the widget in the same domain as HUDMenu, where ZFE installs `__ZFE`.
- Calls `chat.v1.getRuntimeInfo` first to gate on `zfe-chat-online-v1` (requires ZFE 0.9.8+).
- Connects via `chat.v1.connect`, polls via `chat.v1.pollEvents` (2 s cursor poll),
  sends via `chat.v1.sendMessage` with slug-based channels.
- Handles limited-state (unlinked account): receive-only, pinned link-code notice.
- Self-reads `worldId` from BSUIDataManager, sends HMAC-SHA256 control message on the
  `server` channel to bind the world-session room (EULA section 4(F)-safe: game's own HUD data).

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| Haxe | build | 4.3+ |
| Python 3 | build | stdlib only |
| HUDModLoader | runtime | Nexus; provides HUDMenu shell + SharedHUDTools |
| ZFE (dxgi.dll + zfe.ini) | runtime | 0.9.8+ required |

---

## Widget load mechanism — why a ba2 is required

HUDModLoader reads `Data/hudmodloader.ini` (bare name per line) and calls:

```actionscript
// LoaderHelper.load() -- from decompiled source:
this._loader.load(new URLRequest("FCMChatWidget.swf"),
    new LoaderContext(false, ApplicationDomain.currentDomain));
```

`URLRequest("FCMChatWidget.swf")` is a **relative URL**. In Fallout 76's Scaleform/GFx
context, relative URLs are resolved through the **archive virtual filesystem**. The loader
SWF lives at `interface/hudmodloader.swf` inside HUDModLoader.ba2 -- so the relative URL
resolves to `interface/FCMChatWidget.swf` inside any loaded ba2.

A loose file at `Data/interface/FCMChatWidget.swf` is invisible unless
`bInvalidateOlderFiles=1` and loose interface dirs are enabled. The ba2 path is clean
and matches the distribution deliverable.

---

## Build steps

Run from the `game-mods/FCMBridge/hudmodloader-chat/` directory.

### Step 1 -- Compile

```bash
# Staged toolchain:
HAXE_STD_PATH=<buildtools>/haxe_*/std <buildtools>/haxe_*/haxe build.hxml

# System Haxe:
haxe build.hxml
```

Produces `FCMChatWidget.swf` (CWS -- zlib-compressed, Haxe default).

### Step 2 -- Patch SWF (CWS to FWS, version byte 32)

Scaleform requires FWS (uncompressed) with version byte 32.

```python
python3 - << 'EOF'
import zlib, struct
path = 'FCMChatWidget.swf'
with open(path, 'rb') as f:
    raw = f.read()
sig = raw[:3]
if sig == b'CWS':
    body = zlib.decompress(raw[8:])
    file_len = 8 + len(body)
    header = b'FWS' + raw[3:4] + struct.pack('<I', file_len)
    raw = bytearray(header + body)
else:
    raw = bytearray(raw)
raw[3] = 32
with open(path, 'wb') as f:
    f.write(bytes(raw))
print("Patched: FWS v32, %d bytes" % len(raw))
EOF
```

### Step 3 -- Pack into FCMChatWidget.ba2

`ba2tool.py` (in `hudmenu-chat/`) supports creating new BTDX GNRL ba2 archives. The
Bethesda hash algorithm was reverse-engineered from HUDModLoader.ba2 known records and
is verified at import time.

```bash
python3 ../hudmenu-chat/ba2tool.py create \
    FCMChatWidget.ba2 \
    "interface/FCMChatWidget.swf=FCMChatWidget.swf"
```

Output record:
- Internal path: `interface/FCMChatWidget.swf`
- `nameHash=0x87ac17e5` (btdx_hash("fcmchatwidget"))
- `dirHash=0xd2fdf873`  (btdx_hash("interface") -- same as HUDModLoader.ba2)

### Step 4 -- Install files

```bash
GAME="/mnt/d/SteamLibrary/steamapps/common/Fallout76"

cp FCMChatWidget.ba2 "$GAME/Data/FCMChatWidget.ba2"
cp FCMChat.ini       "$GAME/Data/FCMChat.ini"

mkdir -p "$GAME/Data/ZFE/TextChat/fragments/"
cp FCMChatWidget.ini "$GAME/Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
```

### Step 5 -- Register the ba2

In `Fallout76Custom.ini` `[Archive]`:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2, FCMChatWidget.ba2
```

If other ba2s are already listed, append `, FCMChatWidget.ba2`.

### Step 6 -- Register with HUDModLoader

Add to game's `Data/hudmodloader.ini` (bare name, no section or file= syntax):

```
FCMChatWidget
```

### Step 7 -- ZFE endpoint (if not already set)

`Data/configuration/zfe.ini`:

```ini
[TextChat]
Endpoint=wss://dev.falloutchatmod.com/relay
```

For local relay: `Endpoint=ws://127.0.0.1:7177/zfe-relay`

The fragment supplies the dev default; `zfe.ini` overrides per-key.

### Step 8 -- Launch the game

Boot Fallout 76 with HUDModLoader and ZFE active. The widget loads automatically.

---

## Keybind configuration

Two independent bindings control chat input. Keep them matching (default: `PAGE_DOWN`).

### 1. ZFE native hotkey

File: `Data/ZFE/TextChat/fragments/FCMChatWidget.ini`

```ini
[TextChat]
OpenChatKey=PAGE_DOWN
```

User override (wins over fragment, per-key): `Data/configuration/zfe.ini` `[TextChat] OpenChatKey=...`

### 2. HUDMod::UserEvent binding

File: `Data/FCMChat.ini`

```ini
[FCMChat]
openKey=PAGE_DOWN
```

### Valid key/action names

| Value | Key |
|-------|-----|
| `Console` | Tilde / backtick |
| `TeamChat` | T (default team chat) |
| `PAGE_DOWN` | Page Down |
| `NextPage` | Page Down (also used for channel cycling) |
| `DiagnosticSnapshot` | Rarely used; safe fallback |

---

## Controls

| Action | Binding |
|--------|---------|
| Open chat input | Page Down (configurable -- see above) |
| Switch channel | `/g` `/t` `/e` `/i` `/r` in input, or Page Down (NextPage) |
| Scroll | `scrollUp/Down()` -- implemented but not yet bound to a key |
| Close input | Esc |

Channels: `global` (GENERAL), `trade` (TRADING), `events` (EVENTS), `infests`
(INFESTS), `raids` (RAIDS).

---

## Verifying it loaded

Open `zfe.log` (Windows: `%LocalAppData%\zfe.log`; Linux/Proton: `~/.local/share/zfe/zfe.log`).

Expected on load (ZFE found on first attempt):

```
[FCMChatWidget] info startup: FCMChatWidget 2.0.3 loaded
[FCMChatWidget] info startup: BUILD=chatv1-widget
[FCMChatWidget] info startup: zfe-chat-online-v1 OK
[FCMChatWidget] info startup: found after 1 attempt(s)
[FCMChatWidget] info hud: SharedHUDTools constructed + registered
[FCMChatWidget] info connect: attempt=1 displayName=<YourName>
[FCMChatWidget] info connect: connected
[FCMChatWidget] info auth: userId=<prefix>...
[FCMChatWidget] info auth: authState=authenticated
[FCMChatWidget] info world: worldId changed; sending control message
```

If ZFE is still attaching when the widget loads, you may first see:

```
[HUD status bar] chat.v1: searching ZFE (1/30)...
[HUD status bar] chat.v1: searching ZFE (2/30)...
...then the startup lines above when found (up to ~30 s)
```

Expected on send:

```
[FCMChatWidget] info send: sent ch=global len=<n>
```

If the widget produces NO zfe.log output at all: the ba2 was not loaded by the game.
Check `sResourceArchive2List` contains `FCMChatWidget.ba2` and the file is in `Data/`.

If you see "ZFE not found" on screen after 30 s: ZFE is not installed or zfe.ini is misconfigured.

Press **F12** in-game (HUDTools menu) -- FCMChatWidget should appear. `isReloadable=true`
so a hot-reload button is available without restarting.

---

## Known gaps / follow-ups

- **SharedHUDTools.TextEdit untested in-game.** Wired via `Reflect` to avoid compile-time
  class dependency. If method name or signature differs in the shipped HUDTools.swf, update
  `openInput()` in `FCMChatWidget.hx`.
- **Scroll keybind.** `scrollUp/Down/ToBottom()` implemented, not yet wired to a HUDMod
  action key.
- **Pending-echo dedup.** Server echo of a sent message shows twice. Follow-up.
