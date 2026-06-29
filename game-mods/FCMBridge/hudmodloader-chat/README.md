# FCMChatWidget

A HUDModLoader widget that adds interactive FCM community chat to Fallout 76's HUD.

> **Status (2026-06-26):** v2.5.3 — works end-to-end on **native Windows** with **ZFE 0.9.9+**;
> merged to `dev` (PR #330). **BLOCKED under Proton/Wine** (Linux / Steam Deck) by an upstream Zig
> TLS bug (tracked in #326). Full build/install/verify steps + the Proton/Wine details are in
> [BUILD.md](BUILD.md).

## What it does

- Displays the FCM community feed (General / Trading / Events / Infests / Raids) as a scrolling
  amber-themed message log, sourced over the ZFE **chat.v1** native API (`chat.v1.connect` +
  `chat.v1.pollEvents` cursor poll), not the legacy text-chat socket.
- Lets the player send messages. Press the configured open key (default: `PAGE_DOWN`) to open the
  chat input, type a message, and press Enter to send (`chat.v1.sendMessage`, slug-based channels).
- Echos the player's own message immediately as a dim pending record before the server round-trip
  confirms it (dedup'd against the server's echo by `messageId`).
- Supports a scrolling read-back mode: while the user scrolls up, a "N new messages below"
  indicator appears and auto-scroll is suppressed.
- Handles the unlinked-account (limited) state: receive-only with a pinned link-code notice.

## ZFE chat.v1 + native chat input (ZFE 0.9.9+)

The widget discovers `__ZFE` on the parent HUDMenu frame via `findZfeApi()` (HUDModLoader shares
`ApplicationDomain.currentDomain`, where ZFE installs `__ZFE`), gates on `zfe-chat-online-v1` via
`chat.v1.getRuntimeInfo`, then connects/polls/sends over chat.v1.

Text entry uses ZFE's **native chat-input API** — **top-level / bare** ZFE commands (NOT
`chat.v1.`-prefixed) that take **bare-value payloads** (`"true"` / `"false"`, NOT JSON) and return
**bare booleans/strings**:

| Verb (bare) | Payload | Returns | Role |
|------|---------|---------|------|
| `setChatInputActive` | `"true"` / `"false"` | `true` | open / close the native input session |
| `isChatInputActive` | `"{}"` | bool | session still active? (Esc detection) |
| `isChatKeyPressed` | `"{}"` | bool | the configured `OpenChatKey` (PAGE_DOWN) is down |
| `readChatInput` | `"{}"` | string | the in-progress buffer — **this is the message text** |
| `consumeChatInputSubmitted` | `"{}"` | bool | `true` = Enter pressed (NOT the text) |
| `clearChatInput` | `"{}"` | `true` | reset the buffer |

The flow is **open → read → consume → send → clear → deactivate**: `setChatInputActive("true")`,
poll `readChatInput` (show in-progress) + `consumeChatInputSubmitted` (Enter) + `isChatInputActive`
(Esc), on submit `chat.v1.sendMessage` the `readChatInput` text, then `clearChatInput("{}")` +
`setChatInputActive("false")`. `sendMessage` is the one command that stays `chat.v1.`-prefixed —
called bare it hits the legacy bridge and returns literal `false`. A low-rate `isChatKeyPressed`
edge poll opens chat on PAGE_DOWN. Full contract: [BUILD.md](BUILD.md) → "Native chat input (v2.5.3)".

## HUDModLoader APIs used

### HUDMod::UserEvent

```
stage.addEventListener("HUDMod::UserEvent", onUserEvent)
```

HUDModLoader dispatches a bubbling `HUDMod::UserEvent` on the stage before
`HUDMenu.ProcessUserEvent` native handling. The event carries `actionName` (e.g.
`"Console"`, `"TeamChat"`) and `isDown`. This is the only reliable input channel for
a HUD-layer SWF — `stage.addEventListener(KeyboardEvent.KEY_DOWN)` does not fire on
the HUD layer (documented in `docs/overlay/zfe/scaleform-ui-guide.md §5`).

### SharedHUDTools.TextEdit / FormatTextEdit (fallback)

```
SharedHUDTools.FormatTextEdit(x, y, w, h, font, size, color, bgColor, bgAlpha)
SharedHUDTools.TextEdit(callback, startText)
```

HUDModLoader's built-in text-entry machinery, used as the **fallback** when the ZFE native
input session is unavailable (the startup probe finds it unusable). `TextEdit` opens an input
box and handles the `ControlMap::StartEditText` / `EndEditText` engine cycle (which suspends
WASD and routes typed characters to the field); the callback fires with the text on ENTER, or
an empty string on cancel. `SharedHUDTools` is resolved at runtime via
`flash.utils.getDefinitionByName` so the widget needs no compile-time stub. If HUDModLoader is
absent, the widget degrades to receive-only and shows an explanatory prompt.

### HUDButton (channel tabs)

The channel-tab row renders as interactive HUDButtons when HUDButton is available
(gamepad-focusable + clickable) and falls back to a static text strip otherwise.

### isReloadable

`public var isReloadable:Bool = true` — HUDModLoader checks this field on the widget's
main class and exposes a hot-reload button in the F12 HUDTools menu when it is `true`.
This lets you iterate on the SWF without restarting the game.

## Fonts

No TTF is embedded. Text renders via HUDModLoader's **engine-registered GFx font aliases**:
`$MAIN_Font_Light` (body / feed / prompts) and `$MAIN_Font_Bold` (channel tabs, sender names,
headers). These resolve inside a child widget SWF (unlike HUDMenu's per-movie `$$MAIN_Font` and
unlike a Flash-embedded TTF, which GFx ignores for child SWFs); `embedFonts=true` is kept on every
TextField. Details + the tofu root cause: [BUILD.md](BUILD.md) → "Fonts (v2.5.3 - engine aliases)".

## Customization (`Data/FCMChat.ini`)

All appearance + behavior is user-editable in `Data/FCMChat.ini`, parsed by `FcmConfig`
(`FcmConfig.hx`). Coordinate space is always 1920×1080 (HUDModLoader's fixed HUD viewport).
Editable keys (defaults reproduce the amber Pip-Boy theme): position `x`/`y`, `width`/`height`,
`fontSize`; colors `bgColor`/`bgAlpha`/`borderColor`/`textColor`/`senderColor`/`channelTagColor`/
`tabActiveColor`/`tabInactiveColor`/`promptColor`/`tabRowColor`/`timestampColor`; limits
`maxMessages`/`maxSendLen`; toggles `showChannelTag`/`showTimestamps`/`showHints`; keybinds
`openKey`/`channelNextKey`/`channelPrevKey`/`hideKey`. Colors accept `#RRGGBB`, `RRGGBB`, or
`0xRRGGBB`. Every value is validated + clamped — a bad edit falls back to its default, never
crashes, never goes off-screen. Edit, then reload via the F12 HUDTools menu. Full catalog with
ranges: the comments in `FCMChat.ini`. Design + decisions: `docs/roadmap/hud-widget-customization-spec.md`.

## Files

| File | Purpose |
|------|---------|
| `FCMChatWidget.hx` | Main widget source (Haxe → AS3 SWF) |
| `FcmConfig.hx` | User-config model + INI parser/clamp (pure, unit-tested) |
| `TestFcmConfig.hx` / `test-config.hxml` | `FcmConfig` unit tests (`haxe --interp`; run in CI) |
| `build.hxml` | Haxe build file |
| `FCMChat.ini` | Per-user config — position, size, colors, font, limits, keybinds, toggles |
| `FCMChatWidget.ini` | ZFE TextChat fragment (endpoint default, `OpenChatKey`) |
| `hudmodloader.ini` | Entry to append to the game's `Data/hudmodloader.ini` |
| `BUILD.md` | Full build + install + verification steps |
| `README.md` | This file |
