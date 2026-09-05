# FCM HUD surface manifest

This is the source-of-truth map for the optional in-game HUD-mod track. The desktop overlay is a
separate EULA-safe product and is not installed by these steps. No Bethesda SWF, BA2, extender DLL,
or credential file belongs in this repository.

## Runtime surfaces

| Surface | Runtime location | Repository owner | Notes |
|---|---|---|---|
| HUDModLoader widget source | `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx` | FCM | Feed, history, input ownership, channel navigation, row layout |
| Widget SWF/BA2 | `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.swf` and `FCMChatWidget.ba2` | Generated FCM artifacts | `interface/FCMChatWidget.swf`; normalize to FWS v32 before packing |
| HUDModLoader registry | `game-mods/FCMBridge/hudmodloader-chat/hudmodloader.ini` | FCM | Explicit opt-in loader entry |
| ZFE config fragment | `game-mods/FCMBridge/Data/ZFE/TextChat/fragments/FCM.ini` | FCM | Endpoint, channel list, and `OpenChatKey`; installed under the game's `Data/` |
| Standalone bridge source | `game-mods/FCMBridge/FCMBridge.hx` | FCM | Legacy/standalone feed client; shares provider adapter |
| Standalone HUDMenu patch source | `game-mods/FCMBridge/hudmenu-chat/fcm-inject.as` | FCM | Only FCM additions; applied to a user-owned fresh HUDMenu export |
| Patch/build tools | `game-mods/FCMBridge/hudmenu-chat/apply-patch.py`, `build.sh`, `tools/validate_swf.py` | FCM | Anchor checks, vanilla hash pin, SWF structural gate |

The `game-mods/FCMBridge/game-mods/Data/` path is the package source tree used by the widget
installer. The standalone build writes the target-specific fragment into its generated BA2 and
installs `Data/configuration/zfe.ini` separately.

## Script-extender discovery paths

FCM does not inspect DLLs or files to choose a provider. `FcmNativeApi.discover()` walks the widget,
its parent chain, the main stage, and the root movie for already-exposed Scaleform objects:

| Provider | Positive marker | Calls made by FCM |
|---|---|---|
| xScal | `__SFECodeObj.chatInterface` or `__SFCodeObj.chatInterface` with the required methods | `chatInterface.<method>(object)`; `getRuntimeInfo`, `disconnect`, `logout`, and `clearChatAuth` receive no arguments |
| ZFE | `__ZFE.call` / `ZFECodeObj.call` passing `chat.v1.getRuntimeInfo`; legacy `__SFCodeObj.call`/`BRG_OBJ.call` only after a positive ZFE probe | `__ZFE.call("chat.v1.*", jsonString)`; physical navigation uses `Input.RegisterKey`/`Input.IsKeyPressed`/`Input.UnregisterKey` on the generic callback when present, otherwise on `__ZFE.call` itself |
| xScal diagnostics/input | separate call-only `__SFCodeObj.call` | `log` and documented `Input.*` physical-key calls only; never chat transport |

If both providers are present, the explicit xScal `chatInterface` marker wins. A generic
`__SFCodeObj.call` is never enough to classify xScal or ZFE. The child widget is the caller, but its
discovery walk reaches the main-stage object; the patched HUDMenu can also pass the host object down
explicitly.

## User-owned game paths

These are inputs/outputs, not checked-in assets:

```text
<Fallout76>/dxgi.dll                         # ZFE or xScal loader, user-owned
<Fallout76>/xscal.ini                        # xScal [Chat] settings, beside the game executable
<Fallout76>/Data/SeventySix - Interface.ba2  # vanilla source archive for HUDMenu.swf
<Fallout76>/Data/FCMChatWidget.ba2           # optional widget install
<Fallout76>/Data/FCM-standalone.ba2          # optional standalone install
<Fallout76>/Data/configuration/zfe.ini       # ZFE [TextChat] endpoint override
<Fallout76>/Data/ZFE/chat-auth.bin           # ZFE credential container; never touched by FCM
<Fallout76>/Data/XSCAL/chat-auth.bin          # xScal credential container; never touched by FCM
```

The standalone build extracts `interface/HUDMenu.swf` from the vanilla BA2, decompiles it with a
user-provided FFDec/JPEXS tool, applies `fcm-inject.as`, recompiles it, and blob-swaps the generated
SWF into a new BA2. It now requires `--hudmenu-sha256` for the exact extracted vanilla SWF before
the patch can run. This prevents silently patching a stale or unsupported game build.

## Verification ledger

Confirmed by source/tests:

- provider selection is marker-first and xScal `chatInterface` is not routed through the generic
  callback;
- xScal asynchronous `connecting` is kept pending until auth reaches `authenticated`;
- static history is partitioned at 15 rows per durable channel and server history at 50 rows,
  for a bounded 125-event cursor-zero snapshot;
- initial live frames are ordered behind the snapshot with frame and byte limits;
- timer callbacks, input teardown, and HUDTools registration have symmetric shutdown paths;
- generated FWS v32 artifacts have valid frame/tag boundaries and an End tag.

Confirmed by live smoke test:

- `FCMChatWidget` v2.10.54 switches channels with ZFE Page Up/Page Down through the accepted
  physical `Input.*` dispatcher, including the `__ZFE` fallback when a separate generic callback
  is not available.

Unknown until a live game smoke test:

- the active Fallout 76 runtime build and vanilla `HUDMenu.swf` SHA-256;
- the exact xScal/ZFE object placement exposed by that install;
- FFDec recompilation behavior for that specific vanilla HUDMenu;
- whether third-party loader permissions/load order allow the optional HUD track.

## Do not commit

Never add the following to Git: `dxgi.dll`, `xscal.ini` containing user settings, either extender's
`chat-auth.bin`, Bethesda's extracted/decompiled `HUDMenu.swf`/AS source, a copied `SeventySix -
Interface.ba2`, or an FFDec/JPEXS redistribution. Keep those in a temporary build directory or the
user's game installation and record only the SHA-256/build metadata needed to reproduce a test.

## Test matrix

```bash
python3 game-mods/FCMBridge/hudmenu-chat/test_anchors.py
python3 game-mods/FCMBridge/hudmenu-chat/test_ba2tool.py
python3 game-mods/FCMBridge/tools/test_validate_swf.py
```

Then run the Haxe unit suites, the backend relay tests, and—when the user-owned game is available—a
real launch test with one provider at a time and with both providers installed. The acceptance log
must show exactly one provider selection, no `dispatch failed` probe, authenticated history in every
static channel, a fresh server tab after a world hop, one local row per send, and no uncaught
Scaleform error flood.
