# Legacy standalone HUDMenu build

This is the retained standalone path, not the maintained HUDModLoader widget. New widget builds
use [../hudmodloader-chat/BUILD.md](../hudmodloader-chat/BUILD.md). A standalone archive replaces
`interface/HUDMenu.swf` and competes with HUDModLoader or other replacements. It does not gain
loader compatibility merely because its feed self-loader detects another FCM instance.

## Inputs and output

The legacy build combines a user-owned vanilla HUDMenu patched with `fcm-inject.as` and
`FCMBridge.swf`, which uses the shared ZFE/xScal native adapter. It does not use the retired
HELLO/SEND socket transport. The legacy bridge still contains its older NUL/HMAC world-control
path; the modern widget instead sends printable authenticated controls. Do not copy the legacy
shared-secret pattern into new code.

Required inputs are the exact installed game's `SeventySix - Interface.ba2`, a freshly extracted
`interface/HUDMenu.swf` SHA-256, compatible FFDec/Java tooling, Haxe, Python 3, and a verified
v1 GNRL archive template. `../build.sh` currently expects
`<game>/Data/FCM-standalone.ba2.bak-fcmhud1` as that template; it does not construct the standalone
archive from a vanilla archive record automatically. Inspect the template's complete entry set.

No Bethesda HUDMenu SWF/decompile, extender DLL, credentials, or third-party tooling belongs in
a distributable source change. Keep user-owned inputs in the user's install or a temporary build
directory. Hashes identify inputs but do not prove compiler/QName/linkage compatibility.

## Script behavior

The script is `game-mods/FCMBridge/build.sh`, not `hudmenu-chat/build.sh`. It accepts
`--target dev|prod` and `--hudmenu-sha256 <64-hex-pin>`, with `GAME`, `HAXE`, `JAVA`, `FFDEC`, and
`BUILDTOOLS_ROOT` overrides. Defaults use repository-staged tools and a local Steam game path.

**This script also installs.** After compiling, patching, and packaging, it copies generated
artifacts to the source tree and, when its process check sees no running game, writes
`Data/FCM-standalone.ba2` and updates `Data/configuration/zfe.ini` in the configured game path.
There is no build-only flag. Its INI replacement searches `Endpoint=` across the file, so it is
not a safe general section-aware merge for arbitrary user configuration. Inspect and isolate the
script's inputs/output paths before use; do not run it as a routine modern-widget build check.

A hash/anchor failure stops patching; do not bypass it to apply an old base to a new game version.
FFDec's full class recompilation also needs artifact-level and in-game validation for that base.
No standalone build or game installation was performed in the 2026-09-12 documentation audit.

## Offline source and bridge checks

From `game-mods/FCMBridge/`:

```bash
haxe --class-path hudmodloader-chat --main FCMBridge --swf /tmp/FCMBridge.swf --swf-version 32
python3 hudmodloader-chat/normalize_swf.py /tmp/FCMBridge.swf
python3 tools/validate_swf.py /tmp/FCMBridge.swf --require-signature FWS --require-version 32
haxe test-native-api.hxml
haxe test-auth-flow.hxml
python3 hudmenu-chat/test_anchors.py
python3 hudmenu-chat/test_ba2tool.py
```

After a fresh user-owned export, `test_anchors.py <exported-HUDMenu.as>` also validates the
injection anchors. `apply-patch.py` requires the exported AS path, `--source-swf` pointing to the
exact source SWF, and `--expected-sha256` with that same fresh pin. Keep these inputs paired.
Normalizing and structurally validating the output is required; changing only a version byte
is insufficient. Do not treat “any BA2 packer” as equivalent to the verified v1 GNRL tool/profile.

## Configuration and manual validation

ZFE's legacy fragment is `Data/ZFE/TextChat/fragments/FCM.ini`. For a standalone setup without a
matching HUDModLoader registry entry, configure the effective global `[TextChat]` endpoint in
`Data/configuration/zfe.ini`; preserve unrelated settings. Use a target-specific `/relay` URL,
not the old loopback proxy endpoint. The modern fragment is separately named `FCMChatWidget.ini`.

xScal uses `[Chat] enabled=true` and `relayEndpoint` in `xscal.ini` beside the executable. The
modern packager generates an example; there is no checked-in `hudmodloader-chat/xscal.ini.example`
to copy. The shared adapter validates required xScal methods and optional runtime responses,
and never treats a generic callback name as sufficient ZFE identity.

Before manual installation, exit the game and inspect conflicting HUDMenu entries. Append the
standalone BA2 to the existing archive list only for an intentionally selected standalone setup;
never replace the user's list or install it alongside the modern FCM widget by default. Follow
[compatibility](../../../docs/overlay/zfe/hud-mod-compatibility.md).

In-game validation must confirm the exact host/source hash, provider capabilities, target,
configured open key (the fragment default is Insert), input ownership/release, authentication,
message delivery, and world-room transitions. Historical timing or an old numeric provider
minimum is not an acceptance result for the current installation.
