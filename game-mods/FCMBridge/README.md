# FCM in-game HUD sources

The maintained in-game package is [FCMChatWidget](hudmodloader-chat/README.md), a HUDModLoader
child widget using native ZFE `chat.v1` or xScal `chatInterface`. Start with its
[build/install guide](hudmodloader-chat/BUILD.md) and the [HUD documentation index](../../docs/overlay/zfe/README.md).

The separate [FCMServerBridge 0.1.0 background candidate](hudmodloader-bridge/README.md) also
uses HUDModLoader. It has no chat widget; the loader menu supplies linking/status and the
desktop overlay renders its confirmed room. The matching backend/renderer are implemented
locally; hosted deployment and two-provider in-game acceptance remain pending.

This directory also retains the **legacy standalone bridge and HUDMenu patch**. Do not treat
`FCMBridge.hx` as the modern widget renderer or apply its transport/rendering assumptions to
`FCMChatWidget.hx`. Both belong to the explicit opt-in mod track, separate from the default
desktop overlay. They do not add game-memory reads, code injection, or port scanning.

## Source ownership

| Path | Role |
| --- | --- |
| `hudmodloader-bridge/` | Invisible background child, observation policy/tests and validated package builder |
| `hudmodloader-chat/` | Modern child widget, pure Haxe logic/tests, config, emoji, package tools |
| `FcmNativeApi.hx`, `FcmAuthFlow.hx` | Shared provider adapter and native auth lifecycle |
| `FCMBridge.hx` | Legacy feed client used by the standalone HUDMenu integration |
| `Data/ZFE/TextChat/fragments/FCM.ini` | Legacy standalone ZFE fragment, not the modern widget fragment |
| `hudmenu-chat/` | Legacy HUDMenu injection source, hash-pinned build, BA2 tool, source anchors |
| `tools/validate_swf.py` | Structural SWF validation |
| `SocketProbe.hx` | Historical generic-bridge diagnostic, not a shipped widget |

## Shared provider contract

Discovery inspects only objects already exposed to the movie. An explicit xScal `chatInterface`
with the required methods has priority; ZFE dispatchers require a positive chat capability
probe. A generic `__SFCodeObj.call` alone is ambiguous. ZFE takes JSON strings, while xScal
chat methods take ActionScript objects or no arguments according to the method. Generic logging
and numeric physical-key callbacks remain separate from chat transport.

A successful asynchronous xScal connect can still mean `connecting`; the client polls until
auth completes instead of repeatedly connecting. Native credentials stay provider-owned.
Linked-account permission is enforced by the relay in addition to local UI gates. The modern widget’s world/roster
controls use HUD-published data and authenticated relay membership; its printable `FCMCTL/1/*`
controls do not embed a shared HMAC secret. The retained legacy FCMBridge still contains its
older HMAC/NUL control path and must not be used as the modern control recipe.

The active modern path uses `/relay`. Generic socket/remote-data docs describe retired clients.
The legacy line-feed name `FCMHUD/1` must not be confused with the modern `FCMHUD/1;...` metadata
carrier. See [native integration](../../docs/overlay/zfe/native-chat-relay/fcm-integration.md).

## Build and validation

Haxe and Python checks run on Linux CI; compilation is not Windows-only. From this directory,
the legacy bridge compile smoke used in CI is:

```bash
haxe --class-path hudmodloader-chat --main FCMBridge --swf /tmp/FCMBridge.swf --swf-version 32
python3 hudmodloader-chat/normalize_swf.py /tmp/FCMBridge.swf
python3 tools/validate_swf.py /tmp/FCMBridge.swf --require-signature FWS --require-version 32
haxe test-native-api.hxml
haxe test-auth-flow.hxml
python3 hudmenu-chat/test_anchors.py
python3 hudmenu-chat/test_ba2tool.py
python3 tools/test_validate_swf.py
```

Use the [modern build guide](hudmodloader-chat/BUILD.md) to compile/embed emoji and package the
widget. Normalization decompresses/validates the SWF as needed; changing one header byte is not
an adequate format check. Repository `ba2tool.py` supports the tested v1 GNRL profile; it is not
a universal writer for arbitrary BA2 formats.

The [standalone guide](hudmenu-chat/BUILD.md) requires a user-owned vanilla HUDMenu extraction,
its exact SHA-256, and compatible FFDec tooling. Those inputs are not redistributable project
assets. Standalone HUDMenu replacements compete with HUDModLoader; use the
[compatibility guide](../../docs/overlay/zfe/hud-mod-compatibility.md) before any installation.
