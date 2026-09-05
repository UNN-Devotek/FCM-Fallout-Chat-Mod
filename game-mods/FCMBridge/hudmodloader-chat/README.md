# FCMChatWidget

A HUDModLoader widget that adds interactive FCM community chat to Fallout 76's HUD.

> **Status (2026-09-04):** v2.10.50 — source, relay, and packaged BA2 are kept together. The
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
- Paints the player's own message before entering the synchronous native send RPC. The current
  relay's successful ACK carries the server-resolved tag/star and message ID, so the exact row is
  decorated immediately; if the live event wins the race, it completes that same row. A legacy
  Dev ACK without cosmetics preserves only an unambiguous historical own-cosmetics snapshot until
  the authoritative event arrives. Failed sends remove the temporary row.
- Supports a scrolling read-back mode: while the user scrolls up, a "N new messages below"
  indicator appears and auto-scroll is suppressed.
- Renders the server-resolved Overseer tag in the HUD when the relay negotiates widget capability.
  Self-authored messages use the same authoritative live event as Discord and other in-game
  messages, so the tag is not lost to the native send ACK boundary.
ZFE strips unknown event members before the SWF receives them, so v2.10.50 decodes the stable
  message ID and validated cosmetics from the `FCMHUD/1;...` envelope in the known empty
  `targetUserId` slot. Older widget
  builds receive no envelope. The HUD renders server-validated channel and identity tags plus a
  supporter marker as a five-point vector `Shape` in the same row `Sprite` as the channel and
  message fields. The row measures the channel field, reserves a marker slot, and places the
  marker immediately after the channel tag, centered on the first message line with a small
  right/down visual nudge. It
  never uses `getCharBoundaries()`, document indices, or global/local transforms. The marker uses
  the validated `starColor`; it never inserts U+2605, a bitmap, an HTML image, or a substitution
  token, so missing Scaleform font glyphs cannot become tofu blocks. Feed leading is zero to keep
  rows compact, and the feed clip rectangle reserves only a 4px safety gap above the top-level
  HUDTools input field. New content snaps to the end of the feed after each reflow.
  After creating one canonical local send row, the widget enters the synchronous send RPC on the
  next timer tick. The ACK decorates that row immediately when the relay provides cosmetics; a
  live event arriving first can complete the same row when it carries a stable ID. The echo
  reconciles by stable message ID, proven identity, or (for old Dev bridges) a unique
  ACK-accepted 15-second display-name/channel/body fallback. Ambiguous or stale candidates are
  never guessed, so one send produces exactly one feed row. The backend direct-fans out finalized
  events to same-process native subscribers and uses Redis for other instances, with a shared
  instance guard preventing a direct event from being sent twice.
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

The widget discovers a validated ZFE bridge or xScal's `chatInterface` under either
`__SFECodeObj` or `__SFCodeObj` on the parent HUDMenu frame. An explicit xScal
`chatInterface` is authoritative when both extenders are installed; ZFE is selected only when
that positive xScal marker is absent. Current xScal builds may also expose a
generic call-only `__SFCodeObj` on the movie root for unrelated callbacks. The widget never
treats that object as ZFE by name alone. ZFE is gated on
`zfe-chat-online-v1`; xScal is gated on the required `connect`, `pollEvents`, and `sendMessage`
methods plus its positive runtime response when `getRuntimeInfo` is available. Both providers use
the same relay payloads and cursor polling.

xScal's `connect` is asynchronous: `success:true,status:"connecting"` means the native worker
accepted the request, not that relay authentication is complete. v2.10.50 keeps the transport
polling, refreshes `getAuthState` on each xScal poll, and reconnects only for an explicit terminal
state. Its optional generic `__SFCodeObj.call` is retained only for FCM diagnostics (`log`); no
chat verb is ever routed through that callback.

Both providers receive the same complete bounded history from the long-lived relay subscription.
On a fresh cursor-zero subscription, the relay sends up to 15 recent rows for each static feed
(`global`, `trade`, `events`, `infests`, and `raids`) plus up to 50 rows from the current `server`
room: 125 events total. The native poll limit remains 64, so ZFE and xScal drain the ordered
snapshot over multiple polls. The widget drains xScal's asynchronous subscriber with a 250 ms
warm-up for at most 20 polls, and performs a short second ZFE drain only when the first native
batch is full, so the initial feed does not wait for the normal background interval. ZFE uses
the same subscription stream; only a recreated ZFE widget uses
`FCMCTL/1/RESYNC` recovery only when the first ZFE poll is empty or reports queue loss; the
fallback is delayed so a normal subscribe snapshot is not duplicated. xScal never receives that
ZFE control.
After a roster/world bind, the widget performs a separate 150 ms server-history drain through two
consecutive empty polls (hard-capped at eight attempts), which covers xScal's delayed publication
of the current room without waiting for the normal five-second poll.

The `SERVER` sub-tab is backed by the current in-game roster session. After subscribing to
`BSUIDataManager`, v2.10.50 also reads the cached values of `PlayerListData`, `TeamMarkers`,
`PartyMenuList`, and `VoiceChatAreaData`; `Subscribe()` itself only registers a change callback
and does not replay the cached value. Provider values are stored as replaceable snapshots. An
empty or completely disjoint snapshot triggers `LEAVE`, clears only local ephemeral server rows,
and causes a fresh roster bind on the next poll. Once that bind is acknowledged, the relay
replays the current room's bounded recent server history and the sub-tab becomes available again.
Static channel history remains durable; server history is intentionally ephemeral.

Input ownership is edge-based, not a persistent channel-selection mode. `INSERT` must successfully
open the editor before Arrow Up/Down and Home/End are consumed for feed navigation; while idle,
those keys remain Fallout controls. Page Up/Page Down are one-shot previous/next channel actions,
with matching key-up events latched and ignored. Escape, Control-Tab/social, and friends-menu
actions first close the FCM editor and then return `false` so the game can open its own modal.
Reload/removal calls the widget's idempotent `shutdown()` path, which stops every timer, removes
stage/scroll listeners, ends an active HUDTools edit, unregisters HUDTools, and detaches feed rows.

The native ZFE fallback auto-detects cumulative versus one-character input buffers per edit session
and handles control-character backspace. xScal never uses that fallback because xScal owns the
transport but does not expose ZFE's native edit buffer; it uses the host-domain SharedHUDTools
editor.

Player identity is read only from HUD-published `BSUIDataManager` data.
`AccountInfoData.name` is authoritative because it is the public Fallout/Bethesda handle other
players see. `PlayerListData` and `CharacterInfoData` are character-name sources and are not used
as relay identity fallbacks. HUD data can be late, so the widget waits for a usable account handle
before its first relay handshake and retries without opening a second native connection. An empty
read never overwrites a known name.

Text entry uses HUDModLoader's **SharedHUDTools editor first** when Insert opens the editor. This
is the host-domain implementation that owns Fallout's `StartEditText`/`EndEditText` lifecycle and
keeps movement/gameplay controls from leaking into the chat field. The v2.10.45 widget had
reintroduced a child-SWF `ControlMap` dispatch for ZFE native input; that produced repeated
`Error #1014` uncaught events and could leave the player-control lock active. v2.10.46 removes
that child dispatch. With xScal, the same SharedHUDTools path is always used because xScal does
not expose the ZFE editor commands. ZFE's native editor remains a no-lock fallback only when
SharedHUDTools is unavailable or cannot open.
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

The SharedHUDTools flow is **format → focus → lock game input → type → send/cancel → end edit**.
When that host editor is unavailable, the ZFE fallback flow is **activate → clear/verify → read →
consume → send → clear → deactivate** and deliberately does not dispatch `ControlMap` events from
the child widget:
`setChatInputActive("true")`,
immediately `clearChatInput` and verify `readChatInput` is empty, then poll `readChatInput` (show in-progress) + `consumeChatInputSubmitted` (Enter) + `isChatInputActive`
(Esc), on submit `chat.v1.sendMessage` the `readChatInput` text, then `clearChatInput("{}")` +
`setChatInputActive("false")`. The native path never tries to synthesize the engine's
`ControlMap::StartEditText` / `EndEditText` pair from the child SWF. The SharedHUDTools editor owns
the only visible text field; the widget never mirrors it into the prompt. `sendMessage` is the one command that stays `chat.v1.`-prefixed —
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

### SharedHUDTools.TextEdit / FormatTextEdit (primary)

```
SharedHUDTools.FormatTextEdit(x, y, w, h, font, size, color, bgColor, bgAlpha)
SharedHUDTools.TextEdit(callback, startText)
```

HUDModLoader's built-in text-entry machinery is the primary input path because its host-domain
`TextEdit` owns the engine's control-map lock. The widget never runs the startup activation probe because some
Windows/ZFE builds expose the bare payload `true` as literal text. On native activation, it clears
and verifies the buffer before making the session visible. Affected ZFE/Steam Input builds can
return only the newest character from `readChatInput`; the widget accumulates that stream while
still honoring an empty buffer or a shorter edit as a clear/backspace. `TextEdit` opens an input box and
handles the `ControlMap::StartEditText` / `EndEditText` engine cycle (which suspends
WASD and routes typed characters to the field); the callback fires with the text on ENTER, or
an empty string on cancel. `SharedHUDTools` is resolved at runtime via
`flash.utils.getDefinitionByName` so the widget needs no compile-time stub. If HUDModLoader is
absent or its editor cannot open, the widget may use ZFE native input as a no-lock fallback; it
does not attempt the unsafe child-domain ControlMap dispatch.

The native clear check is fail-closed: a bare `true` from `readChatInput` is accepted as an empty
status only when `clearChatInput` also returned success. A one-character observation is treated as
a delta and appended to the draft, including repeated characters; a multi-character observation
remains the cumulative buffer. The widget deliberately does not construct or dispatch a
`PlatformChangeEvent`: that event's constructor varies across HUDModLoader builds and caused the
observed `Error #1063`. Keyboard/controller selection remains HUDTools' responsibility.

### Channel tabs

The channel-tab row is one static text strip. It must not create HUDButton instances:
HUDButton labels share the same coordinates and would overlap the strip. Switch channels using
the configured control-map actions or slash commands. `SERVER` appears only after the relay
acknowledges the player's roster/world binding; observing nearby players alone never enables it.
Forwarded `NextPage` / `PrevPage` actions (plus PageUp/PageDown aliases) are stateless,
edge-deduplicated commands that switch channels whether the feed is idle or input is open; they
never enter a persistent channel-selection mode. After Insert opens the typing session,
ArrowUp/ArrowDown (plus Up/Down aliases) scroll the feed and Home/End return to the newest message;
before Insert they remain game controls. While input is open, the draft remains in place. Named external actions close the
active input owner before the game takes focus: `OpenSocial` (the in-game Ctrl+Tab social shortcut),
friend-list/quick-action aliases, and Escape/Cancel. Native ZFE input is deactivated directly; the
SharedHUDTools primary path uses its public `EndTextEdit()` API. The no-lock native fallback is
deactivated directly. This handoff must happen before
`HUDMenu.ProcessUserEvent` handles the modal action, preventing a stale editor or
`ControlMap::StartEditText` lock from trapping the social menu.

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
