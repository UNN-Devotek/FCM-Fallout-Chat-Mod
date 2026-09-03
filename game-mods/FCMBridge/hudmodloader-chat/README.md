# FCMChatWidget

A HUDModLoader widget that adds interactive FCM community chat to Fallout 76's HUD.

> **Status (2026-09-03):** v2.10.39 — source, relay, and packaged BA2 are kept together. The
> in-game mod is an explicit opt-in; the default desktop overlay remains separate. Build, install,
> rollout, and acceptance checks are in [BUILD.md](BUILD.md).

## What it does

- Displays the FCM community feed (General / Trading / Events / Infests / Raids) as a scrolling
  amber-themed message log, sourced over the active script extender's native chat API: ZFE
  **chat.v1** (`chat.v1.connect` + `chat.v1.pollEvents`) or xScal `chatInterface`, selected
  automatically. It does not use the legacy text-chat socket.
- Resolves the outgoing sender name from Fallout 76's public Bethesda/Fallout account handle in
  `AccountInfoData.name`, preserving punctuation such as a trailing hyphen. `PlayerListData` and
  `CharacterInfoData` contain character labels and cannot satisfy the relay identity gate. If the
  account handle is not ready yet, the widget waits and retries before its first handshake; it
  never connects as the `Wanderer` placeholder or re-enters the native ZFE connect call when late
  HUD data arrives.
- Lets the player send messages. Press the configured open key (default: `INSERT`) to open the
  chat input, type a message, and press Enter to send (`chat.v1.sendMessage`, slug-based channels).
- Paints the player's own message before entering the synchronous native send RPC, then replaces
  the temporary row with the authoritative live relay event once it arrives. This prevents a
  slow TLS/socket call from hiding a locally accepted message; failed sends remove the temporary
  row, while successful sends still take cosmetics from the relay because ZFE can strip them from
  native acknowledgements.
- Supports a scrolling read-back mode: while the user scrolls up, a "N new messages below"
  indicator appears and auto-scroll is suppressed.
- Renders the server-resolved Overseer tag in the HUD when the relay negotiates widget capability.
  Self-authored messages use the same authoritative live event as Discord and other in-game
  messages, so the tag is not lost to the native send ACK boundary.
ZFE strips unknown event members before the SWF receives them, so v2.10.39 decodes validated
  cosmetics from the `FCMHUD/1;...` envelope in the known empty `targetUserId` slot. Older widget
  builds receive no envelope. The HUD renders server-validated channel and identity tags plus a
  supporter marker as a five-point vector `Shape` positioned from the author's text bounds. The
  marker uses the validated `starColor`; it never inserts U+2605, a bitmap, an HTML image, or a
  substitution token, so missing Scaleform font glyphs cannot become tofu blocks. Its bounds are
  transformed into the sibling marker layer and it sits immediately after the measured channel tag
  (before optional moderation/custom tags), middle-aligned to the author bounds. Feed leading is zero
  to keep rows compact, and the feed clip
  rectangle reserves only a 4px safety gap above the top-level HUDTools input field. New content
  snaps to the end of the feed after each reflow.
  After queuing the local row, the widget enters the synchronous send RPC on the next timer tick,
  then schedules one next-tick event poll after success so the authoritative cosmetics-bearing
  echo appears without waiting for the normal background poll interval. The echo reconciles the
  pending row in place, including when the extender changes the temporary native identity into the
  relay identity, so one send produces exactly one feed row.
- Converts Discord custom-emoji markup (`<:name:id>` and `<a:name:id>`) to a readable `:name:`
  label on the HUD. The web overlay may use Discord CDN images, but the Scaleform HUD does not
  load remote emoji images and therefore never exposes the numeric Discord snowflake ID.
- Handles the unlinked-account (limited) state: receive-only with a pinned link-code notice.
- Provides a standalone `/relink` command and an FCM HUDModLoader menu action. On a ZFE build that
  supports `clearChatAuth`, it deletes ZFE's local relay token and reconnects to show a new code.
  Older ZFE builds show the exact manual fallback (`Data/ZFE/chat-auth.bin`) and do not claim that
  the account was reset.
- Gives linked moderators an in-HUD command surface for delete, kick, mute, unmute, ban, and unban.
  Staff can enter an exact visible player name (quote multi-word names) or use the `[#XXXXXXXX]`
  fallback next to a visible message. The widget resolves either form to immutable relay IDs; duplicate
  visible names must use the reference. Full command syntax and DEV verification are in
  [BUILD.md](BUILD.md#staff-moderation-commands).

## Automatic ZFE/xScal chat + keyboard input

The widget discovers a validated ZFE bridge or xScal's `__SFECodeObj.chatInterface` on the parent
HUDMenu frame. ZFE is preferred for backwards compatibility; xScal is selected when ZFE is absent.
ZFE is gated on `zfe-chat-online-v1`; xScal is gated on the required `connect`, `pollEvents`, and
`sendMessage` methods. Both providers use the same relay payloads and cursor polling.

Player identity is read only from HUD-published `BSUIDataManager` data.
`AccountInfoData.name` is authoritative because it is the public Fallout/Bethesda handle other
players see. `PlayerListData` and `CharacterInfoData` are character-name sources and are not used
as relay identity fallbacks. HUD data can be late, so the widget waits for a usable account handle
before its first relay handshake and retries without opening a second native connection. An empty
read never overwrites a known name.

Text entry tries ZFE's **native chat-input API** lazily when Insert opens the editor. With xScal,
the widget uses SharedHUDTools directly because xScal does not expose the ZFE editor commands.
ZFE's **native chat-input API** — **top-level / bare** ZFE commands (NOT
`chat.v1.`-prefixed) that take **bare-value payloads** (`"true"` / `"false"`, NOT JSON) and return
**bare booleans/strings**:

| Verb (bare) | Payload | Returns | Role |
|------|---------|---------|------|
| `setChatInputActive` | `"true"` / `"false"` | `true` | open / close the native input session |
| `isChatInputActive` | `"{}"` | bool | session still active? (Esc detection) |
| `isChatKeyPressed` | `"{}"` | bool | the configured `OpenChatKey` (INSERT) is down |
| `readChatInput` | `"{}"` | string | the in-progress buffer — **this is the message text** |
| `consumeChatInputSubmitted` | `"{}"` | bool | `true` = Enter pressed (NOT the text) |
| `clearChatInput` | `"{}"` | `true` | reset the buffer |

The flow is **activate → clear/verify → lock game input → read → consume → send → clear → deactivate → unlock**:
`setChatInputActive("true")`,
immediately `clearChatInput` and verify `readChatInput` is empty, then poll `readChatInput` (show in-progress) + `consumeChatInputSubmitted` (Enter) + `isChatInputActive`
(Esc), on submit `chat.v1.sendMessage` the `readChatInput` text, then `clearChatInput("{}")` +
`setChatInputActive("false")`. The native path proceeds only when it can dispatch the engine's
balanced `ControlMap::StartEditText` / `EndEditText` pair; otherwise it closes the native session
and uses HUDModLoader's `SharedHUDTools.TextEdit` fallback. The fallback owns the only visible
text field; the widget never mirrors it into the prompt. `sendMessage` is the one command that stays `chat.v1.`-prefixed —
called bare it hits the legacy bridge and returns literal `false`. A low-rate `isChatKeyPressed`
edge poll opens chat on INSERT. Full contract: [BUILD.md](BUILD.md).

## HUDModLoader APIs used

### HUDMod::UserEvent

```
stage.addEventListener("HUDMod::UserEvent", onUserEvent)
```

HUDModLoader dispatches a bubbling `HUDMod::UserEvent` on the stage before
`HUDMenu.ProcessUserEvent` native handling. The event carries `actionName` (e.g.
`"Console"`, `"TeamChat"`) and `isDown`. The widget also accepts the legacy
`EventName`/`IsKeyDown` aliases used by older loader builds. This is the only reliable input channel for
a HUD-layer SWF — `stage.addEventListener(KeyboardEvent.KEY_DOWN)` does not fire on
the HUD layer (documented in `docs/overlay/zfe/scaleform-ui-guide.md §5`). The
HUDModLoader menu itself is opened with **F11** (outside the Pip-Boy); the widget
registers its build/select callbacks with that upstream menu.

### SharedHUDTools.TextEdit / FormatTextEdit (fallback)

```
SharedHUDTools.FormatTextEdit(x, y, w, h, font, size, color, bgColor, bgAlpha)
SharedHUDTools.TextEdit(callback, startText)
```

HUDModLoader's built-in text-entry machinery is retained as the fallback for unsupported native
input/platform combinations. The widget never runs the startup activation probe because some
Windows/ZFE builds expose the bare payload `true` as literal text. On native activation, it clears
and verifies the buffer before making the session visible. Affected ZFE/Steam Input builds can
return only the newest character from `readChatInput`; the widget accumulates that stream while
still honoring an empty buffer or a shorter edit as a clear/backspace. `TextEdit` opens an input box and
handles the `ControlMap::StartEditText` / `EndEditText` engine cycle (which suspends
WASD and routes typed characters to the field); the callback fires with the text on ENTER, or
an empty string on cancel. `SharedHUDTools` is resolved at runtime via
`flash.utils.getDefinitionByName` so the widget needs no compile-time stub. If HUDModLoader is
absent, the widget degrades to receive-only and shows an explanatory prompt.

### Channel tabs

The channel-tab row is one static text strip. It must not create HUDButton instances:
HUDButton labels share the same coordinates and would overlap the strip. Switch channels using
the configured control-map actions or slash commands. `SERVER` appears only after the relay
acknowledges the player's roster/world binding; observing nearby players alone never enables it.
Forwarded `NextPage` / `PrevPage` actions (plus PageUp/PageDown aliases) switch channels whether the
feed is idle or input is open. After Insert opens the typing session, ArrowUp/ArrowDown (plus
Up/Down aliases) scroll the feed and Home/End return to the newest message; before Insert they
remain game controls. While input is open, the draft remains in place. Named Quick Actions/Friends/Escape actions
close a native session before the game takes focus, preventing a stale editor from trapping input.

### isReloadable

`public var isReloadable:Bool = true` — HUDModLoader checks this field on the widget's
main class and exposes a hot-reload button in the F11 HUDModLoader menu when it is `true`.
This lets you iterate on the SWF without restarting the game.

## Fonts

No TTF is embedded. Text renders via HUDModLoader's **engine-registered GFx font aliases**:
`$MAIN_Font_Light` (body / feed / prompts) and `$MAIN_Font_Bold` (channel tabs, sender names,
headers). These resolve inside a child widget SWF (unlike HUDMenu's per-movie `$$MAIN_Font` and
unlike a Flash-embedded TTF, which GFx ignores for child SWFs); `embedFonts=true` is kept on every
TextField. Details are in [BUILD.md](BUILD.md).

## Customization (`Data/FCMChat.ini`)

All appearance + behavior is user-editable in `Data/FCMChat.ini`, parsed by `FcmConfig`
(`FcmConfig.hx`). Coordinate space is always 1920×1080 (HUDModLoader's fixed HUD viewport).
Editable keys (defaults reproduce the amber Pip-Boy theme): position `x`/`y`, `width`/`height`,
`fontSize`; colors `bgColor`/`bgAlpha`/`borderColor`/`textColor`/`senderColor`/`channelTagColor`/
`tabActiveColor`/`tabInactiveColor`/`promptColor`/`tabRowColor`; limits
`maxMessages`/`maxSendLen`; toggles `showChannelTag`/`showHints`; keybinds
`openKey`/`channelNextKey`/`channelPrevKey`/`hideKey`. Colors accept `#RRGGBB`, `RRGGBB`, or
`0xRRGGBB`. Every value is validated + clamped — a bad edit falls back to its default, never
crashes, never goes off-screen. Edit, then reload via the F11 HUDModLoader menu. Full catalog with
ranges: the comments in `FCMChat.ini`. Design + decisions: `docs/roadmap/hud-widget-customization-spec.md`.

Message timestamps are intentionally not displayed in the in-game feed. Older `showTimestamps`
and `timestampColor` entries in `FCMChat.ini` or persisted settings are ignored.

The F11 menu's **FCM → Customize → Reset all settings** action restores all user-facing values to
the `FcmConfig` defaults immediately. Under ZFE, settings persist with the other Customize actions
in vendor-scoped storage (`FCMChatWidget/settings.ini`); xScal has no equivalent vendor-storage
contract, so its settings remain session-local. It retains the environment-owned
account-link URL so a hosted-dev build continues to link against dev rather than production.
The generated ZIP also includes `HUDMODLOADER-MENU.txt` with the F11, Customize, reset, scroll,
hide, relink, channel, and reload steps. With Fallout 76 focused, press `Insert` to start typing;
`Enter` sends, `Escape` cancels, `/g` `/t` `/e` `/i` `/r` `/s` switch channels (`/s` after a
current server/world binding), `/hide` hides the feed, and `/relink` clears local auth when the
installed extender supports `clearChatAuth`. Replacing the BA2 or script-extender fragment requires a full game
restart; the loader reload control is for live widget changes.

## Files

| File | Purpose |
|------|---------|
| `FCMChatWidget.hx` | Main widget source (Haxe → AS3 SWF) |
| `../FcmNativeApi.hx` | Shared ZFE/xScal discovery and verb adapter |
| `FcmConfig.hx` | User-config model + INI parser/clamp (pure, unit-tested) |
| `FcmStarLayout.hx` | Pure measured supporter-marker placement geometry + tests |
| `FcmCommand.hx` / `TestFcmCommand.hx` / `test-command.hxml` | Pure slash-command matching and tests |
| `FcmWire.hx` / `TestFcmWire.hx` / `test-wire.hxml` | Whitespace-safe native event-array detection and tests |
| `TestFcmConfig.hx` / `test-config.hxml` | `FcmConfig` unit tests (`haxe --interp`; run in CI) |
| `build.hxml` | Haxe build file |
| `FCMChat.ini` | Per-user config — position, size, colors, font, limits, keybinds, toggles |
| `FCMChatWidget.ini` | ZFE TextChat fragment (endpoint default, `OpenChatKey=INSERT`) |
| `xscal.ini.example` | Target-specific xScal `[Chat]` settings emitted by `package.py` |
| `hudmodloader.ini` | Source line for the append-only loader entry; packages emit it as `FCMChatWidget.hudmodloader.ini` |
| `package.py` | Creates a target-specific, versioned install ZIP with instructions and all widget files |
| `BUILD.md` | Full build + install + verification steps |
| `README.md` | This file |
