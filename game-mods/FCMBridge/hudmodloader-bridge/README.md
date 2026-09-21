# FCM Server Bridge 0.2.7

Invisible, optional HUDModLoader child. Sign into the desktop overlay only.
No bridge login/code/pairing, chat connection, input editor or helper service.

Requires official ZFE scoped storage or xScal 0.2.17+ named modStorage plus HUDModLoader.
Install BA2 and merge loader/archive configs with the game closed; preserve unrelated
mods and recoverable backups. Never coinstall visible FCMChatWidget or legacy FCMBridge.
See [INSTALL.template.txt](INSTALL.template.txt) and the maintained
[architecture/protocol guide](../../../docs/overlay/zfe/background-server-bridge.md).

## Contract

- `FCMServerBridge`: bounded native UI observations and subscriptions,
  deferred refresh and lifecycle disposal. No native chat APIs.
- `FcmBridgeState`: copied observations, source precedence, world generation,
  fast-travel continuity and 30-second expiry.
- `FcmBridgeExport`: schema-1 bounded snapshot, maximum one write/sec and five-second
  heartbeat. Separate observation sequence/age prevents stale heartbeat renewal.
- `FcmBridgeStorage`: xScal 0.2.17+ named `load(name)` / `save(name, document)`, or validated ZFE
  `zfe-storage-v1` + `writeStorage`. Independent of native chat authentication.
  Modern aliases win before the legacy `BRG_OBJ` fallback; every route must pass
  the same storage capability check. The bridge registers no menu or input listener.

Export contains no credentials. Environment is compiled into the SWF.
The overlay validates advancing local snapshots and forwards them through its
authenticated socket. Backend confirmation enables Server. HUD and bridge users
must share the same canonical room/history/publication across all provider pairings.
Roster names supply mutual-discovery evidence, not account authentication or an
authoritative world ID.

## Build and verify

Requires Haxe 4.3+, Python 3 and simulator dependencies. From this directory:

```bash
haxe test-state.hxml
haxe test-export.hxml
python3 test_package.py
cd ../hudmodloader-chat
for suite in test-*.hxml; do haxe "$suite" || exit 1; done
npm test --prefix simulator
cd ../hudmodloader-bridge
python3 package.py --target dev --output ../../../_dev-test-builds/server-bridge-0.2.7/FCM-Server-Bridge-0.2.7-DEV.zip
```

Also run parent native-adapter/auth/source checks and affected backend, overlay and
dashboard suites. Both package targets require normalized FWS v32, one BTDX v1 GNRL
entry `Interface/FCMServerBridge.swf`, decoded-byte equality and no native-chat,
login, harness, renderer or input symbols. Packaging during tests is an owned test
fixture, not install approval.

`haxe build.hxml -D bridge_dev` compiles Dev; omitting the define compiles Prod.
Neither command installs or publishes. Do not apply the widget emoji normalizer.

The complete Ruffle suite includes storage-based combined lifecycle tests and an
isolated host loading the exact packaged child without production helpers. It
cannot prove native storage timing, GFx verification or game stability. Mark new
artifacts native-unverified until fresh two-client manual acceptance passes. No game
input automation.

0.2.1 restores the compatibility-dispatcher lookup omitted from 0.2.0's storage
adapter. Pure tests cover scope/parent/root lookup, provider priority, bad responses
and failed probes; isolated Ruffle cases cover fallback exports and capability
absence/recovery. This does not prove the installed ZFE fallback supports storage:
native acceptance requires a fresh export and confirmed overlay Server room.

0.2.2 adds diagnostic-only cached `Storage probe` and `Last failure` rows. Probe labels
separate discovery, native-call, parse, rejected-success and missing-capability failures;
outer lifecycle labels identify failures before storage discovery. Only fixed labels and
validated numeric error IDs are exposed, never replies, exception messages or roster data.
`Last failure` retains the last caught lifecycle error until movie reload; it is not current
health. Probes keep their existing five-second cadence and capability requirements.
The public read-only diagnostic method is observed by the isolated Ruffle host without
production helper linkage.

0.2.3 replaces runtime-info and write-acknowledgement decoding with the existing HUD's
bounded `FcmJson` reader. The 0.2.2 laptop screenshot confirmed `__SFCodeObj parse E1014`
while the roster was fresh; the exact missing class was not reported. Package validation
now rejects `JsonParser` linkage. Capability and successful-save checks stay mandatory,
and the visible HUD is unchanged. Pure and isolated Ruffle tests cover malformed/oversized
replies and recovery. The 2026-09-17 laptop check verified active, advancing ZFE exports;
the user reported it working. Full mixed-client room/message/travel acceptance remains
pending; see the dated evidence linked from the architecture guide.

0.2.4 prefers the fresh local-player name exposed by the same accepted roster source over
`AccountInfoData` when writing `ownName`, with the account name retained as a fallback. This
aligns bridge evidence with the name peers actually observe without treating either value as
authentication. Freshness, generation, mutual-sighting and bounded-export rules are unchanged.

0.2.7 uses xScal 0.2.17's stateless named storage calls for the bridge export. It does not
claim the legacy HUDMenu-wide registration slot, so Improved HUD can continue using its own
`improvedbars` document while FCM writes only `fcmserverbridge-dev` or
`fcmserverbridge-prod`. Older xScal builds retain the legacy adapter for standalone
compatibility, but 0.2.17+ is required when another HUD child also uses modStorage.

Prior native-network implementation and E1014 investigations:
[NATIVE-NETWORK-HISTORY.md](NATIVE-NETWORK-HISTORY.md). Previous acceptance never
certifies this storage-based candidate.
