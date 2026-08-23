# FCMChatWidget

A HUDModLoader widget that adds interactive FCM community chat to Fallout 76's HUD.

> **Status (2026-08-21):** v2.10.3 — source, relay, and packaged BA2 are kept together. The
> in-game mod is an explicit opt-in; the default desktop overlay remains separate. Build, install,
> rollout, and acceptance checks are in [BUILD.md](BUILD.md).

## What it does

- Displays the FCM community feed (General / Trading / Events / Infests / Raids) as a scrolling
  amber-themed message log, sourced over the ZFE **chat.v1** native API (`chat.v1.connect` +
  `chat.v1.pollEvents` cursor poll), not the legacy text-chat socket.
- Lets the player send messages. Press the configured open key (default: `INSERT`) to open the
  chat input, type a message, and press Enter to send (`chat.v1.sendMessage`, slug-based channels).
- Echos the player's own message immediately as a dim pending record before the server round-trip
  confirms it (dedup'd against the server's echo by `messageId`).
- Supports a scrolling read-back mode: while the user scrolls up, a "N new messages below"
  indicator appears and auto-scroll is suppressed.
- Handles the unlinked-account (limited) state: receive-only with a pinned link-code notice.
- Gives linked moderators an in-HUD command surface for delete, kick, mute, unmute, ban, and unban.
  Staff can enter an exact visible player name (quote multi-word names) or use the `[#XXXXXXXX]`
  fallback next to a visible message. The widget resolves either form to immutable relay IDs; duplicate
  visible names must use the reference. Full command syntax and DEV verification are in
  [BUILD.md](BUILD.md#staff-moderation-commands).

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
| `isChatKeyPressed` | `"{}"` | bool | the configured `OpenChatKey` (INSERT) is down |
| `readChatInput` | `"{}"` | string | the in-progress buffer — **this is the message text** |
| `consumeChatInputSubmitted` | `"{}"` | bool | `true` = Enter pressed (NOT the text) |
| `clearChatInput` | `"{}"` | `true` | reset the buffer |

The flow is **open → lock game input → read → consume → send → clear → deactivate → unlock**:
`setChatInputActive("true")`,
poll `readChatInput` (show in-progress) + `consumeChatInputSubmitted` (Enter) + `isChatInputActive`
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
`"Console"`, `"TeamChat"`) and `isDown`. This is the only reliable input channel for
a HUD-layer SWF — `stage.addEventListener(KeyboardEvent.KEY_DOWN)` does not fire on
the HUD layer (documented in `docs/overlay/zfe/scaleform-ui-guide.md §5`). The
HUDModLoader menu itself is opened with **F11** (outside the Pip-Boy); the widget
registers its build/select callbacks with that upstream menu.

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

### Channel tabs

The channel-tab row is one static text strip. It must not create HUDButton instances:
HUDButton labels share the same coordinates and would overlap the strip. Switch channels using
the configured control-map actions or slash commands. `SERVER` appears only after the relay
acknowledges the player's roster/world binding; observing nearby players alone never enables it.
While input is open, forwarded `NextPage` / `PrevPage` actions switch channels without closing
the input or clearing the draft; verify the active loader forwards those actions during the edit
lock in the in-game acceptance checklist.

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
`tabActiveColor`/`tabInactiveColor`/`promptColor`/`tabRowColor`/`timestampColor`; limits
`maxMessages`/`maxSendLen`; toggles `showChannelTag`/`showTimestamps`/`showHints`; keybinds
`openKey`/`channelNextKey`/`channelPrevKey`/`hideKey`. Colors accept `#RRGGBB`, `RRGGBB`, or
`0xRRGGBB`. Every value is validated + clamped — a bad edit falls back to its default, never
crashes, never goes off-screen. Edit, then reload via the F11 HUDModLoader menu. Full catalog with
ranges: the comments in `FCMChat.ini`. Design + decisions: `docs/roadmap/hud-widget-customization-spec.md`.

The F11 menu's **FCM → Customize → Reset all settings** action restores all user-facing values to
the `FcmConfig` defaults immediately and persists them with the other Customize actions in
vendor-scoped ZFE storage (`FCMChatWidget/settings.ini`). It retains the environment-owned
account-link URL so a hosted-dev build continues to link against dev rather than production.

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
