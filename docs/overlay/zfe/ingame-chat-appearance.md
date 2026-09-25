# HUD appearance and customization

This guide describes the current FCMChatWidget source, including the unreleased ultrawide
positioning changes. It does not establish installed or publicly released behavior. See the
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

Customize now groups controls into **Position**, **Panel size**, **Text and input**,
**Appearance**, **Auto-hide**, and **Colors**, with Reset all settings at the Customize root.
Customize and the position, sizing, appearance and auto-hide branches contain at most seven
entries, avoiding the previous tall control list. Colors and its palettes retain their existing
options and depth (the host supports four submenu levels).
While the loader menu is active, FCM measures the visible columns of its selected subtree,
clamps them inside the stage viewport with eight units of padding, and fits an oversized column
to a very small viewport. It converts displacement through parent transforms and excludes hidden
submenus from measurements. Menu placement is independent of the chat panel's ultrawide offset;
other mods' menu columns and the loader root are untouched. The frame listener is removed on unload.
This uses the public display-tree contract of [HUDToolsMenu](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/HUDTools/scripts/HUDToolsMenu.as)
(`getSelectedModName`, `HUDToolsMenu`/`HUDButton` classes). Different host implementations need
native verification; the guard does not patch or replace HUDModLoader assets.

Position accepts manual horizontal offsets from `-960` to `2880 - width` in the
centered 1920×1080 authored coordinate system. For example, `x=-330` is preserved
through INI parsing, local persistence and relay layout restore/save. This bounded
32:9 envelope is not automatic monitor detection: narrower screens can hide the panel
if moved too far. **Position → Reset position** restores `x=10, y=10` while preserving
other settings. Vertical limits and panel maximum dimensions are unchanged.
The relay must deploy the matching layout validator before xScal can save these offsets.
Native 21:9/32:9 placement, menu visibility and editor alignment still require in-game
acceptance on both providers; Ruffle only proves the movement/menu/persistence contract.

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

ZFE uses SharedHUDTools' host-domain editor, which owns the balanced text-edit lock;
xScal uses its native session when available and SharedHUDTools otherwise. Input
height/font/colors are applied to the host editor. The child does not dispatch ControlMap
lock events itself. ZFE's legacy buffer and public `input.v1.*` contract are retained only
for explicit diagnostics, not automatic visible-editor fallbacks.

Validate short/wrapped names, adjacent emoji, localized text, narrow/wide panels, scroll clipping,
all independent colors, and cancel/send/reload behavior in the game for each provider. A passing
compiler, emoji catalog test, or SWF preview does not establish Fallout GFx compatibility.
