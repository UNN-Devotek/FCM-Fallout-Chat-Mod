# Text Chat Mod — Decompiled Build Blueprint

The basis for M7 two-way in-game chat. Reverse-engineered from the original FO76 **Text Chat** mod
(`ChatMod.ba2` → two SWFs: a modified **HUDMenu.swf** + a **TextChat.swf** chat-UI). We mimic this
architecture. See [two-way-chat-implemented.md](two-way-chat-implemented.md) for the implemented result.

> Method: carved the two SWFs out of the BTDX/GNRL `.ba2` (zlib-decompress each `CWS` stream → `FWS`),
> then decompiled AS3 with JPEXS/ffdec. All line refs below are into that decompiled source.

## Architecture at a glance

- **HUDMenu.swf** — a full COPY of the game's HUDMenu with chat logic baked in. It is the **controller**:
  it owns key detection, focus, the socket, parsing, and command handling. Being the real HUDMenu is
  what lets the engine deliver input to it (`ProcessUserEvent`).
- **TextChat.swf** — the chat **window UI** (tabs, text fields, user list, emojis, fonts). It is a
  **display slave**, dynamically loaded into HUDMenu via `Loader` into
  `ApplicationDomain.currentDomain`. No LocalConnection/ExternalInterface between them — HUDMenu holds a
  direct reference and drives TextChat's display list (`TextChat.TextChatBase_mc.…`).
- **Native bridge `__SFCodeObj`** — the SFE/ZFE code object exposed to Flash. Provides the socket
  (`register`/`connect`/`writeUTFBytes`/`readUTFBytes`) and key helpers (`isChatKeyPressed`,
  `updateChatHotkey`, `isEmergencyClosePressed`, `writeChatConfigFile`). The current
  `FCMChatWidget` uses ZFE's `chat.v1` transport and vendor-scoped `readStorage`/`writeStorage`;
  these legacy calls remain historical reference only.

## 1. Opening chat — key capture (two paths, both → `enterChatMode()`)

**Path A (primary): `ProcessUserEvent(name, isDown)`** — a Scaleform virtual the engine calls for every
mapped UI action. Fires `enterChatMode()` on **key-up** when `name == hotKey` (default `"INSERT"`) and
no blocking menu mode is active (TERMINAL/PERKS/CAMP/INSPECT/RadialMenu/WORKSHOP). Only available
because the mod IS the HUDMenu. (`HUDMenu.as` ~3273)

**Path B (secondary): 50 ms poll** of `__SFCodeObj.call("isChatKeyPressed")` via a one-shot `Timer`
re-armed each tick (`onCheckChatKey`, ~841). Backstop for when the engine consumes the key before
`ProcessUserEvent`. Also polls `isEmergencyClosePressed` to force-close.

Hotkey is registered to the native layer after INI load: `__SFCodeObj.call("updateChatHotkey", hotKey)`.

## 2. Focus + game-input suppression

`enterChatMode()` (~1935):
```
stage.focus = TextChat.TextChatBase_mc.TextChatEntryWidget_mc.ChatEntryText_tf;
BSUIDataManager.dispatchEvent(new CustomEvent("ControlMap::StartEditText", {tag:"Chat"}));
```
- `stage.focus = <TextField>` routes keystrokes to the input field (its KEY_DOWN/UP listeners).
- The `ControlMap::StartEditText` engine event makes the game **suspend its own keyboard/gamepad
  routing** for the duration — this is the WASD-doesn't-move-you mechanism.

`resetChatMode()` (~1945) reverses it: `stage.focus = stage;` + dispatch
`"ControlMap::EndEditText"`, clears the field, restores visibility/state.

> NOTE: `UIMenuFocus`, `_uiKeyboard`, `ignorePCKeyMapping` are **NOT used** — earlier string-level
> guesses were wrong. The real mechanism is `stage.focus` + the StartEditText/EndEditText event pair.

## 3. Typing + submit

Listeners are wired by HUDMenu **onto TextChat's `ChatEntryText_tf`** after load (`textChatLoaded`, ~828):
```
ChatEntryText_tf.addEventListener(KeyboardEvent.KEY_UP,   chatEntryKeyUp);
ChatEntryText_tf.addEventListener(KeyboardEvent.KEY_DOWN, chatEntryKeyDown);
ChatEntryText_tf.addEventListener(FocusEvent.FOCUS_OUT,   chatEntryFocusOut);
```
- `chatEntryKeyUp` (~1996): `ENTER` → `sendChatMessage(text)` then `resetChatMode()`; `ESCAPE` →
  `resetChatMode()`.
- `chatEntryKeyDown` (~2225): `TAB` → `changeTab()`; `UP`/`DOWN` → scroll history/user list; `HOME` →
  close + hide.
- `chatEntryFocusOut` (~2460): safety net → `resetChatMode()`.
- Input `TextField` (`ChatEntryText_tf`, lives in TextChat.swf, type INPUT). Per-channel length caps
  enforced in `sendChatMessage` (Global/Trade/Event 300, Local/Server/Clan/Party 1000, Whisper/Alliance
  500). Field cleared on reset.

## 4. Networking — `ExtendedSocket` over the native bridge

`ExtendedSocket.as` wraps `sfCodeObject.call(...)` (NOT `flash.net.Socket`):
- ctor → `sfCodeObject.call("register", this)`
- `connect(host, port)` → `call("connect", host, port)` + start `connectTimer` (5 ms, watches
  `connected`) and `dataTimer` (50 ms, watches `bytesAvailable`)
- `writeUTFBytes(s)` → `call("writeUTFBytes", s)` (throws IOError if it returns false); `flush()` is a
  native no-op
- Receive: C++ sets `bytesAvailable`; on growth dispatches `SocketData`; HUDMenu drains byte-by-byte.

**Incoming wire format** (`socketDataHandler` ~1648): raw TCP byte stream, **no length prefix/delimiter**
— a message is complete when the buffer ends with `"}` or `]}`; strip to first `{"`, drop newlines,
`JSONDecoder`. Skips UTF-8 continuation byte `0xC2`.

**Outgoing** (all JSON via writeUTFBytes, except JOIN/AUTH via dedicated native calls):
- JOIN: `__SFCodeObj.call("sendJoin", "JOIN:"+name+":"+version+":")`
- AUTH (on server `{"type":"auth"}`): `call("sendAuth", "AUTH2:"+name+":")`
- message: `{"type":"message","message":..,"channel":int,"whisperTarget":..,"serverPlayerCount":..,"nearbyPlayers":[..],"partyMembers":[..]}`
- command: `{"type":"command","command":..,"commandArguments":..,"channel":int,"isWanted":bool,"isOnPrivateWorld":bool,..}`

**Incoming types:** `auth` (→ send AUTH2), `player_list_update` (→ UserList), else a chat record
(`type`,`channel`,`old`,`sender`,`message`,`tag`,`color`,`whisperTarget`) → `OnNetworkedUIEventReceived`
→ @mention highlight + emoji substitution → `TextChatWidget.addChatMessage(...)`.

## 5. Identity — from BSUIDataManager (this is the key precedent for our hash model)

Player name = `BSUIDataManager.GetDataFromClient("AccountInfoData").data` → `account.name`. The socket
only connects when `account.name.length > 2`. Auth is **name-only** (`JOIN`/`AUTH2`), no token. This is
exactly the FO76-sanctioned UI-data surface we plan to read; we layer `HMAC(serverSecret, accountName)`
on top as a stable, blockable identity hash and reconcile `characterName` as display name.

## 6. Channels / tabs

6 tabs (0 All, 1 Local, 2 Global, 3 Trade, 4 Party, 5 Clan). Channel ints 0–9 route to per-channel
arrays (each capped 100): Local0/Server7→Local; Global1/Event6→Global; Trade3; Party4; Clan5/Alliance9;
Alert2 & Whisper8 broadcast to all. `TAB` cycles tabs (skips disabled). UserList shown only on Local tab.

## 7. Config — `Data/configuration/chatmod.ini`

Loaded via `URLLoader` from `../configuration/chatmod.ini` relative to the SWF; if missing, embedded
`defaultSettings` is written via `__SFCodeObj.call("writeChatConfigFile", …)`. Custom INI parser:
`[section]`/`key=value`, auto-typed (bool, 6-hex→color int, float, else string). Sections:
`channelVisibilitySettings`, `chatBoxSettings`, `chatEntryBoxSettings`, `userListSettings`,
`chatBoxTabSettings`, `emojiSettings`, `fontSettings`, `miscellaneousSettings`
(`openChatKey=INSERT`, `defaultToGlobalChat`, `enableRandomNameColors`, `enableTimestamps`,
`shortenChannelTags`), `notificationSettings`, `hudModListSettings`.

## 8. Commands

No registry — hardcoded `if/else` in `sendChatMessage`. Local: `/season`, `/reload`, `/convert`,
toggles (`/randomnames`,`/disableemojis`,`/mentions`,`/tags`,`/timestamps`,`/global`,`/trade`,…) and
channel shorthands (`/g /l /t /p /c /a /e /s /w <name> /r`). Unknown `/word` → server `sendCommand`.
`Season.as` is the only modular command class (reads `SeasonWidgetData`/`AccountInfoData`, returns a
local string).

## 9. Emojis

~70 embedded bitmap classes (`heart.as`, `wink.as`, …). `insertEmojis()` matches `:name:`, resolves via
`getDefinitionByName(name.toLowerCase())`, replaces with `<img src="name" height/width=fontSize+emojiScale>`
rendered by Scaleform `TextFieldEx`.

---

## What this means for OUR build (mimic strategy)

1. **Path A (replace HUDMenu.swf) is the proven route** and needs nothing exotic: input via
   `ProcessUserEvent` (engine-delivered because we ARE HUDMenu), focus via `stage.focus` +
   `ControlMap::StartEditText`/`EndEditText`, typing via KEY_UP/DOWN on the input field — none of which
   require the native bridge to expose anything beyond the socket we already have.
2. **Our existing FCMBridge socket already matches `ExtendedSocket`** (same `__SFCodeObj`
   register/connect/writeUTFBytes/readUTFBytes). We keep our FCMHUD/1 line protocol on the wire rather
   than Text Chat's brace-terminated JSON — our backend already speaks it.
3. **Identity** uses the same BSUIDataManager `AccountInfoData`/`isLocal` source, upgraded to
   `HMAC(serverSecret, accountName)` + characterName reconcile (see plan Phase 3).
4. We do **not** need Text Chat's full 6-channel/emoji/command surface for v1 — start with one channel
   and ENTER-to-send; layer the rest later.
