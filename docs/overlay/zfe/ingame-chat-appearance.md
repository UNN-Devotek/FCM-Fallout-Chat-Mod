# HUD appearance and customization

This guide describes the current **FCMChatWidget 2.10.78 local candidate**. It covers source and
packaged behavior, not the installed or publicly released version. See the
[HUD index](README.md) for verification status and [styling history](../../testing/hud-emoji-status.md)
for the earlier desktop ZFE confirmation.

## Message layout

Rows use a native multiline plain-text `TextField` across the full feed width, with formatting
ranges for source channel, sender, message body, and staff reference. Wrapping and height follow
GFx layout. Resizing rebuilds the rows. The supporter star and known emoji are vector display
objects placed in measured row-local slots; the star does not depend on a font's U+2605 glyph.

The relay supplies validated name color, supporter marker/color, and identity tag. The widget
preserves these across own-send reconciliation. A local default sender color applies only when
no server-resolved color is present. Channel tags retain each message's source even in General's
combined view. Channel colors are compiled defaults; they are not fetched from dashboard theme
settings or controlled by the retired per-channel INI overrides.

Known Unicode sequences and bundled custom emoji render as static sprites. Unknown custom emoji
use readable names. The HUD does not download Discord CDN images or play animated emoji/GIFs.
Optional decoration failures keep the styled baseline where possible; the emergency plain-text
feed remains available if row construction fails. Deferred callbacks cannot mutate a newer render
generation. Emoji fallback is not evidence of artwork corruption without diagnostics.

## F11 menu

Open **F11 → FCM → Customize**. Settings apply to this HUD, not other players.

| Setting | Behavior |
| --- | --- |
| Width/height; move up/down/left/right | Independent panel size and position |
| Feed text size | Message font size |
| Input height and text size | Size the actual host editor; small panels constrain effective size |
| Opacity | Panel, tab-box, and input backgrounds |
| Colors submenu | Panel/tab/input backgrounds, border, message/input/default-name text, tab text, hints |
| Color theme | Cycle basic palette, then adjust individual colors |
| Auto-hide ON/OFF and delay | Separate enabled state and remembered delay; delay changes do not enable it |
| Reset all settings | Restore packaged defaults |

Input width and alignment always follow the widget input rectangle. Auto-hide OFF cancels the
timer and reveals the panel; manual Hide remains available. Delay steps are five seconds and
values are clamped to 1–600 seconds. `autoHideSec=0` remains a legacy disable value; enabling it
supplies a positive default delay.

## INI configuration

Edit the existing `[FCMChat]` section in `Data/FCMChat.ini`. Do not duplicate keys/sections.
[Packaged CUSTOMIZATION.txt](../../../game-mods/FCMBridge/hudmodloader-chat/CUSTOMIZATION.txt)
is the user-facing reference; `FcmConfig.hx` defines parsing, clamping, and serialization.

| Keys | Meaning |
| --- | --- |
| `x`, `y`, `width`, `height` | Panel geometry |
| `fontSize`, `inputHeight`, `inputFontSize` | Feed font; input height 28–120; input font 8–47 or 0 for provider sizing |
| `bgAlpha` | Background opacity 0–1 |
| `bgColor`, `tabRowColor`, `inputBgColor`, `borderColor` | Background and border `#RRGGBB` colors |
| `textColor`, `inputTextColor`, `senderColor` | Body/input/default-name colors |
| `tabActiveColor`, `tabInactiveColor`, `promptColor` | Tab and hint colors |
| `autoHideEnabled`, `autoHideSec` | Enabled state and delay |

Timestamps are not displayed. Old `showTimestamps`/`timestampColor`, `showChannelTag`,
`channelTagColor`, and `colorGeneral`/`colorTrading`/`colorEvents`/`colorInfests`/`colorRaids`/
`colorServer` appearance overrides are ignored. Badges, emoji, channel visibility/colors,
available channels, and default channel are not customization toggles. Channel switching remains
available normally. There are no input-width or input-alignment settings.

Open/chat/scroll keys are separate controls, documented in
[KEYBINDS.txt](../../../game-mods/FCMBridge/hudmodloader-chat/KEYBINDS.txt). Page Up/Down can switch
channels while idle; feed scrolling requires a visible owned input session.

## Persistence and precedence

ZFE saves F11 settings through vendor-scoped `FCMChatWidget/settings.ini`. Saved values take
priority over packaged `Data/FCMChat.ini`; the package's environment link URL is retained.
xScal uses per-linked-device relay storage, gated by `canSaveHudLayout`. The matching backend
must accept the requested appearance fields; old geometry-only implementations cannot save new
appearance payloads. Relinking with a new device identity starts a new saved-layout scope.
Unsupported/unavailable storage leaves changes live for the session without claiming persistence.

Use F11 for subsequent changes when a saved override exists, or update the corresponding saved
settings through the supported storage path before reloading. The HUD never edits extender
credential files. Reload the widget to reread UI settings; restart Fallout 76 after native
extender config or BA2 changes. This audit did not establish live backend deployment state.

## Input ownership and validation

Both providers prefer SharedHUDTools' host-domain editor, which owns the balanced text-edit
lock. Input height/font/colors are applied to that editor, not only to a hidden widget fallback.
The child does not dispatch ControlMap lock events itself. A legacy ZFE native-input fallback
is separate from the public `input.v1.*` owner-scoped API.

Validate short/wrapped names, adjacent emoji, localized text, narrow/wide panels, scroll clipping,
all independent colors, and cancel/send/reload behavior in the game for each provider. A passing
compiler, emoji catalog test, or SWF preview does not establish Fallout GFx compatibility.
