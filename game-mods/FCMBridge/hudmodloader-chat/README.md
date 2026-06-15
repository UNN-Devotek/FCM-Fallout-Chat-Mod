# FCMChatWidget

A HUDModLoader widget that adds interactive FCM community chat to Fallout 76's HUD.

## What it does

- Displays the FCM community feed (General / Trading / Events / Raids) as a scrolling
  amber-themed message log, using the same ZFE legacy socket and FCMHUD/1 line protocol
  as `FCMBridge.hx` (the receive-only feed widget).
- Lets the player send messages. Press the configured open key (default: `~` / Console)
  to open the chat input, type a message, and press Enter to send.
- Echos the player's own message immediately as a dim pending record before the server
  round-trip confirms it.
- Supports a scrolling read-back mode: while the user scrolls up, a "N new messages
  below" indicator appears and auto-scroll is suppressed.

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

### SharedHUDTools.TextEdit / FormatTextEdit

```
SharedHUDTools.FormatTextEdit(x, y, w, h, font, size, color, bgColor, bgAlpha)
SharedHUDTools.TextEdit(callback, startText)
```

HUDModLoader's built-in text-entry machinery. `TextEdit` opens an input box and
handles the `ControlMap::StartEditText` / `EndEditText` engine cycle (which suspends
WASD and routes typed characters to the field). When the user submits (ENTER) or
cancels (ESC), the callback fires with the text (empty string = cancel).

This is a cleaner path than re-implementing our own input field with `stage.focus`
management, and it supports gamepad OSK automatically.

`SharedHUDTools` is resolved at runtime via `flash.utils.getDefinitionByName` so the
widget does not need a compile-time stub for the class (which lives in HUDModLoader's
`ApplicationDomain`). If HUDModLoader is absent, the widget degrades to receive-only
and shows an explanatory prompt.

### isReloadable

`public var isReloadable:Bool = true` — HUDModLoader checks this field on the widget's
main class and exposes a hot-reload button in the F12 HUDTools menu when it is `true`.
This lets you iterate on the SWF without restarting the game.

## ZFE socket

The widget discovers the legacy `__SFCodeObj` bridge via the same parent-chain walk and
`__zfe_probe` discriminator as `FCMBridge.hx`. Both widgets can coexist in the same HUD
because they register separate anonymous socket objects — the native bridge supports
multiple registered listeners on the same TCP connection.

## Position

Coordinate space is always 1920×1080 (HUDModLoader's fixed HUD viewport). Defaults
to `x=10, y=10`. Edit `Data/FCMChat.ini` to reposition.

## Files

| File | Purpose |
|------|---------|
| `FCMChatWidget.hx` | Main widget source (Haxe → AS3 SWF) |
| `build.hxml` | Haxe build file |
| `FCMChat.ini` | Default per-user config (position, font size, open key, channel) |
| `hudmodloader.ini` | Entry to append to the game's `Data/hudmodloader.ini` |
| `BUILD.md` | Full build + install + verification steps |
| `README.md` | This file |
