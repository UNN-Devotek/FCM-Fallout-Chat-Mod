# FCM Server Bridge 0.1.0

Separate invisible HUDModLoader child for Server chat in the FCM desktop overlay. Requires
HUDModLoader plus ZFE `chat.v1` or xScal `chatInterface`. It has no chat widget or chat editor;
HUDModLoader's menu shows connection status, a one-time link code and a reconnect action.

This is a local test candidate. The matching backend and shared overlay changes must be deployed
to the same environment before hosted end-to-end use. No in-game acceptance or publication is
claimed. See the [architecture, protocol and acceptance guide](../../../docs/overlay/zfe/background-server-bridge.md).

## Build and verify

Requires Haxe 4.3+ and Python 3. From this directory:

```bash
haxe test-state.hxml
python3 test_package.py
python3 package.py --target dev --output ../../../_dev-test-builds/server-bridge-0.1.0/FCM-Server-Bridge-0.1.0-DEV.zip
```

The package helper compiles the selected target, normalizes to FWS v32, builds a BTDX v1 GNRL
archive, validates the sole `Interface/FCMServerBridge.swf` entry and exact decoded SWF bytes,
and writes the ZIP with its manifest and instructions. `--target prod` changes the compiled
link URL and both native endpoint examples; it does not publish or install anything.
`haxe build.hxml` is a compile-only production-link build; add `-D bridge_dev` for a DEV link URL.
Do not use the visible widget's emoji-embedding normalizer on this small background SWF.

## Install

Every ZIP includes a complete `INSTALL.txt` generated from the maintained
[installation guide template](INSTALL.template.txt), with its version, environment, relay
endpoints and linking URL filled in. It covers prerequisites, exact destinations, preserving
existing INI entries, switching from the visible widget, both provider choices, account linking,
expected Server-tab behavior, troubleshooting, updating and uninstalling. Start with that file
after extracting the download; the `.example` files are references for manual edits.

Follow the instructions with the game closed. Append `FCMServerBridge` to the existing
HUDModLoader registry and `FCMServerBridge.ba2` to the existing archive list; preserve other
entries. Install only the selected extender's configuration example. ZFE global overrides take
precedence over the fragment. The ZIP contains no automatic installer or native executables.

Disable the visible FCMChatWidget and legacy FCMBridge entries before enabling this mod; they
share a native queue. Open F11 / HUDModLoader → **FCM Server Bridge** and redeem the code at the
specified `/link` page using the same account as the desktop overlay. Join a world and allow the
roster/lease to confirm. General and Server then show the same canonical server records.

The mod reads only real, ready HUD providers. Mutual sightings infer rooms; they are not an
authoritative world identifier. Incomplete HUD data can split same-world players. Two-client
in-game testing under each native provider remains required.
