# HUD mod compatibility

FCM's modern package is a **HUDModLoader child widget**. It contains
`interface/FCMChatWidget.swf` and does not replace or patch `interface/HUDMenu.swf`.
The legacy standalone build is a different installation option and does replace HUDMenu.

The separate [FCMServerBridge 0.1.0 background candidate](background-server-bridge.md) uses
HUDModLoader and contains no HUDMenu replacement or chat widget. It uses the extender's single
native queue, so enable it separately from visible FCMChatWidget and legacy FCMBridge installs.
Local package validation is complete; in-game compatibility acceptance remains pending.

## Choose one FCM renderer

| Installation | HUDMenu owner | FCM content | Compatibility boundary |
| --- | --- | --- | --- |
| Background `FCMServerBridge.ba2` with HUDModLoader | HUDModLoader | Invisible child; desktop Server chat | Separate native queue consumer; disable other FCM mods |
| Modern `FCMChatWidget.ba2` with HUDModLoader | HUDModLoader | Child widget only | Requires a functioning loader; preserve other widget registrations |
| Legacy `FCM-standalone.ba2` | FCM's patched vanilla HUDMenu | Patched HUDMenu plus legacy bridge | Competes with any other archive providing the same HUDMenu path |

Use the modern widget for the maintained HUD path. Do not coinstall two FCM renderers or add the
widget registry line twice. Legacy self-load checks reduce accidental coexistence but are not a
substitute for inspecting the active archive/loader configuration.

The old instructions to patch a `HUDModLoader.ba2.fcmbak` base described a superseded experiment.
They are not how the modern widget is built. No Bethesda or third-party HUDMenu is included in
`FCMChatWidget.ba2`.

## Coexistence and load order

HUDModLoader loads children listed in `Data/hudmodloader.ini`. Separate child SWFs avoid a direct
HUDMenu file collision, but that does not prove compatibility with every widget: hotkeys, focus,
layout, shared tools, and lifecycle can still conflict. Follow the
[loader author's instructions](https://github.com/GitCrazy-wc/hudmodloader) for the installed
version and verify FCM together with the user's actual mod set.

An archive containing another `interface/HUDMenu.swf` can replace the loader's host and prevent
all children from loading. Inspect the active mod-manager profile, loose overrides, BA2 entry
paths, and effective archive order. Do not infer the winning file solely from a mod's display
name, an old compatibility table, or a filename-only archive check. Loading one replacement last
does not merge two HUDMenu implementations.

## Safe manual setup

1. Exit the game before changing a BA2 or native extender config.
2. Install HUDModLoader and one selected native chat provider following their authors' instructions.
3. Use the target/provider-specific package's `INSTALL.txt`.
4. Append the supplied FCM loader line exactly once to the existing `Data/hudmodloader.ini`.
5. Append `FCMChatWidget.ba2` to the existing `[Archive] sResourceArchive2List`; preserve other entries.
6. Merge only the chosen provider's configuration. ZFE's global `[TextChat]` override can win over
   `FCMChatWidget.ini`; xScal uses its own `[Chat]` section beside the executable.
7. Restart and verify the expected FCM build, provider, target endpoint, F11 menu, input, and feed.

A missing FCM menu suggests loader/registry/archive issues before it suggests relay failure.
Two simultaneous build-instance logs may indicate duplicate loads; one instance marker does not
rule out a legacy renderer that lacks that diagnostic. Test arrows outside and inside chat,
Page Up/Down, cancel, Pip-Boy transitions, and reload with the rest of the mod set enabled.

See [surface manifest](hud-surface-manifest.md), [build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md),
and [recovery checks](../../testing/hud-recovery.md). Historical named-mod surveys are not a
current tested compatibility matrix and should not be used to promise universal coexistence.
