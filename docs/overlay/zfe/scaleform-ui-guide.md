# FCM Scaleform/GFx engineering guide

This guide describes the current FCM HUD source and the evidence needed to change it. Fallout's
GFx runtime is not interchangeable with a Flash test harness. Generic Adobe/Haxe/Autodesk docs
explain formats and APIs; only the active game/provider/loader and fresh logs establish runtime
compatibility. The [HUD index](README.md) separates candidate and in-game status.

## Rendering

The modern widget retains bounded canonical records and renders one full-width multiline plain
native `TextField` per row. It applies `TextFormat` ranges after assigning text. Row-local vector
stars and bundled emoji sprites use measured layout slots. This supersedes the old single HTML
feed and BitmapData/image-substitution experiments described in historical notes.

Preserve a complete styled baseline before optional emoji work. Catch planning/layout/decoration
failures without discarding already-readable rows. If core row construction fails, cancel pending
work and build the plain-text fallback. Every delayed slice must check its render generation and
catch exceptions inside that callback; the scheduling stack's catch cannot handle later failures.
A stale failure must not replace a newer feed.

Layout changes on data, resize, scroll, or settings changes, not every frame. Measure the actual
rendered text after wrapping. `getCharBoundaries` is a layout/advance rectangle, not a tight glyph
outline. Use text-field offsets when marker and field share a proven row coordinate basis; use
`localToGlobal`/`globalToLocal` when crossing parents. Do not add guessed scroll-line offsets.
Account for wrapped names, reserved marker/emoji gaps, clipping, and reflow.

The widget uses Fallout font aliases such as `$MAIN_Font_Light` in embedded-font mode. This is
project/runtime evidence, not a universal GFx alias or proof of arbitrary glyph coverage. Avoid
introducing dynamic classes/interfaces on hot compatibility paths without target verification;
the historical Error #1014 failures did not establish a universal ban on those language features.

`appendHtml` is not the current feed's rendering recipe. If another surface requires HTML,
encode untrusted content for its context and check the target runtime/stylesheet behavior.
Do not infer from a legacy text sanitizer that modern native chat should strip punctuation.
Filters, shaders, bitmap caches, gradients, or other effects require measured support and cost;
do not declare all GFx implementations incapable based on one FCM experiment. Enable Scaleform
extensions before using extension calls and verify the actual version/availability.

## Input and HUDModLoader

Named `HUDMod::UserEvent` actions differ from raw character/physical key events. FCM reads
`EventName`/`IsKeyDown` through `FcmUserEvent` and preserves the loader's actual forwarding and
Boolean handled path. A bubbling non-cancelable event does not suppress gameplay because a child
listener calls `stopPropagation` or returns a value. Inspect the active host path.

SharedHUDTools' host-domain `TextEdit` is the primary editor for both extenders. It owns the
balanced lock. The child does not independently dispatch ControlMap start/end events. Close or
release the owned editor on send, cancel, relevant menu transitions, failure, and unload. Do not
end another UI's session. The legacy ZFE fallback has different guarantees from public
owner-scoped `input.v1.*`.

Page Up/Down channel switching is permitted while idle and typing. Feed scrolling requires the
visible editor owned by chat. Configured aliases and reversed directions resolve through the same
navigation policy. Existing edge guards key on normalized action names, not every canonical alias;
test simultaneous named/physical delivery before claiming a single action per physical press. Home/End have no default newest binding.
The provider guide distinguishes numeric `Input.*`, ZFE `hotkeys.v1.*`, and native text sessions;
none should be treated as interchangeable or as a universal gameplay-suppression API.

## Native calls and data

Use the shared [provider adapter](../../../game-mods/FCMBridge/FcmNativeApi.hx). ZFE commands
receive JSON strings; xScal chat methods receive ActionScript objects or no arguments, and its
physical key calls receive numbers. “All structured native data must be JSON strings” is false
for this integration. A generic callback named `__SFCodeObj` is not proof of provider identity.

Native sends can block the Scaleform frame. Build the pending row before deferring the call,
then reconcile authoritative identity/cosmetics in place. Defer does not mean concurrent or
nonblocking. Retry only under the negotiated receipt contract; transient queued and terminal
failure states differ.

General is an allowlisted view over six canonical source channels. Do not copy rows, rewrite
source slugs, filter ingestion by active tab, or rebroadcast messages to implement aggregation.
Apply world-room validation before admitting SERVER rows. Reject replay before matching pending
echoes; conflicting stable IDs never use body fallback. Retained rows remain a duplicate guard
when bounded caches evict IDs. Session cursors may reset during reconnect; durable message IDs
survive according to history lifetime. Read [recovery checks](../../testing/hud-recovery.md).

## Child widget versus HUDMenu patch

`FCMChatWidget.ba2` contains only the FCM child SWF. It does not need vanilla HUDMenu extraction
or a modified HUDModLoader base. Merge its loader line and archive entry without replacing the
user's configuration. Check coexistence with actual hotkeys/widgets, not just filenames.

The retained standalone build extracts a user-owned vanilla HUDMenu, checks its SHA-256, applies
FCM additions, and recompiles through FFDec. That route has additional namespace/linkage and
compiler risks. Prefer targeted structural/ABC changes when appropriate; an assembler roundtrip
is not byte-lossless. Never claim an unrun FFDec comparison or redistribute Bethesda source/assets.
The legacy build script can install into its configured game path; inspect it before running.

## SWF and BA2 gates

For this widget, build through `build.hxml` and `normalize_swf.py`, then validate FWS v32, declared
and actual length, frame rectangle, ABC/tag boundaries, and final End tag. FWS v32 is this
project's artifact contract, not a universal SWF/GFx format rule. The current widget's rectangle
is 400×300, not a hardcoded game viewport.

Fingerprint BA2 version/type/entry paths before using a reader/writer. The checked-in archive is
BTDX v1 GNRL with `interface/FCMChatWidget.swf`. The repository's tested `ba2tool.py` can preserve
metadata while swapping that payload. Compare the complete entry set, relevant header/index
metadata, and decoded SWF bytes; filename/version-string checks alone are insufficient. Keep
provider/target/distribution config stamps in the same verification pass.

Haxe, normalization, pure logic, and archive tests run on Linux CI. FFDec/Archive2/Wine are not
required for the modern build. See [BUILD.md](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md)
for commands and in-game acceptance; do not confuse offline checks with a live game test.

## Evidence references

- [Current provider contracts and author links](modder-guide.md).
- [HUDModLoader source](https://github.com/GitCrazy-wc/hudmodloader); compare the installed host revision.
- [Surface manifest](hud-surface-manifest.md), [compatibility](hud-mod-compatibility.md).
- [Styling/emoji observations](../../testing/hud-emoji-status.md) and
  [historical widget notes](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD-HISTORY.md).

The older Proton transport failure is historical, not a current blanket blocker. Record exact
provider/game/build evidence for new reports. Sanitize logs: status/counts/errors/timings are
preferred over raw tokens, content, names, and stable identities.
