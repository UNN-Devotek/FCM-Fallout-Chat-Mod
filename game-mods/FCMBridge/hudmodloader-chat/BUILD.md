# FCMChatWidget — Build & Install Guide

## What this builds

`FCMChatWidget.swf` — a HUDModLoader widget that adds an interactive amber-themed
chat UI to Fallout 76's HUD. It receives the FCM community feed (same socket as
FCMBridge) and lets the player send messages using the HUDModLoader text-entry API.

> **Untested caveat:** The `SharedHUDTools.TextEdit` / `FormatTextEdit` input path
> has not yet been tested in-game. Bridge discovery, receive, and send protocol are
> all proven by FCMBridge and the hudmenu-chat patch. The SharedHUDTools call path
> is architecturally new for this project. See "Known gaps" below.

---

## Prerequisites

| Tool | Version | How to get |
|------|---------|-----------|
| Haxe | 4.3+ | `scoop install haxe` (Windows) or haxe.org |
| Python 3 | any | for the mandatory SWF version-byte patch |
| HUDModLoader | latest | Nexus — required at runtime |
| ZFE (dxgi.dll + zfe.ini) | latest | required at runtime for socket |
| ffdec (JPEXS) | 21.0.5+ | optional — for SWF inspection only |

---

## Build steps

Run from the `game-mods/FCMBridge/hudmodloader-chat/` directory.

### 1. Compile

```bash
# Windows (Scoop Haxe path — adjust if installed elsewhere)
/mnt/c/Users/<YourName>/scoop/shims/haxe.exe build.hxml

# Or on Linux with system Haxe
haxe build.hxml
```

This produces `FCMChatWidget.swf`.

### 2. Patch the SWF version byte (MANDATORY)

Haxe writes SWF version byte 43 (Flash Player 32 in one encoding). FO76's Scaleform
expects version byte 32. Without this patch the game ignores or crashes on the SWF.

```bash
python3 -c "
with open('FCMChatWidget.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"
```

### 3. Copy the SWF

HUDModLoader loads SWFs from the path listed in `hudmodloader.ini`. Default path
matches what ships in the FCMBridge BA2:

```
Data/MCM/Config/FCMBridge/hudmodloader-chat/FCMChatWidget.swf
```

On Linux/WSL2:

```bash
cp FCMChatWidget.swf \
   "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/MCM/Config/FCMBridge/hudmodloader-chat/FCMChatWidget.swf"
```

Create the directory first if it does not exist:

```bash
mkdir -p "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/MCM/Config/FCMBridge/hudmodloader-chat/"
```

### 4. Copy the config file

```bash
cp FCMChat.ini \
   "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/FCMChat.ini"
```

The widget loads `../FCMChat.ini` relative to the SWF, which resolves to
`Data/FCMChat.ini`. Edit x/y/width/height/fontSize/openKey/channel to taste.

### 5. Add to hudmodloader.ini

Append the entry from `hudmodloader.ini` in this directory to the game's
`Data/hudmodloader.ini`. FCMChatWidget should appear **after** FCMBridge so it
renders on top:

```ini
[FCMChatWidget]
file=Data/MCM/Config/FCMBridge/hudmodloader-chat/FCMChatWidget.swf
reloadable=true
```

### 6. Launch the game

Boot Fallout 76 with HUDModLoader active. The widget should appear at startup.

---

## Verifying it loaded

1. Press **F12** in-game to open the HUDTools menu.
2. FCMChatWidget should appear in the widget list marked "reloadable".
3. Use the HUDTools reload button to hot-reload after a SWF change (no game restart needed).
4. Check `%LocalAppData%\zfe.log` for lines tagged `[FCMChatWidget]` — they appear as
   `Mod API [FCMChatWidget]` entries from `zfeLog()`.
5. Press `~` (tilde) to open the chat input. Type a message and press Enter.
6. Watch `backend/hud-diag.log` on the server for `HELLO-ACCEPTED` and `SEND ok=true` lines.

---

## Packaging into FCMBridge.ba2

If you want to distribute the widget inside the FCMBridge BA2 rather than as a
loose file:

1. The BA2 swapping toolchain lives in `game-mods/FCMBridge/tools/`.
2. Add `FCMChatWidget.swf` and `FCMChat.ini` as new records using the same
   GNRL packing approach documented in `hudmenu-chat/BUILD.md`.
3. The loose-file path (`Data/MCM/Config/…`) is reliable for HUDModLoader widgets;
   the BA2 path is optional but avoids loose-file loading quirks.

---

## Known gaps / follow-ups

- **SharedHUDTools.TextEdit untested in-game.** The call goes through `Reflect`
  to avoid a compile-time class reference. If HUDModLoader's `SharedHUDTools` class
  exposes `TextEdit` and `FormatTextEdit` under different names, update
  `FCMChatWidget.hx` accordingly after inspecting a decompiled HUDModLoader SWF
  with ffdec.
- **Scroll keybind.** `scrollUp()` / `scrollDown()` / `scrollToBottom()` are
  implemented but no HUDModUserEvent is wired to them yet. Wire via `onUserEvent`
  once the best control-map action is confirmed (e.g. `"PipBoy"` held for scroll).
- **Identity.** BSUIDataManager `AccountInfoData` / `CharacterInfoData` is read
  lazily on first send. If the data isn't populated yet at that moment the identity
  fields will be empty strings — the backend auto-provisions. Confirm timing in-game.
- **Channel selector.** Only one channel (`FCMChat.ini channel=`) is supported.
  Multi-channel tab UI is a future iteration.
- **Pending-echo dedup.** The local echo record uses `PENDING_HEX` color to dim it.
  When the server broadcasts the real record back, both appear. Dedup (match
  user+content, replace pending) is a follow-up.
