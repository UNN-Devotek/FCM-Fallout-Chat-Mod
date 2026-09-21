# HUD 2.10.117 CONTROLLER-TEST Manifest

Status: private, native-unverified, unpublished, and locally installed for xScal acceptance.

## Identity and scope

- Base commit: `e9144c75`
- Source branch: `test/controller-input`, reconciled into local `dev` after commit `8314b50f`
- Worktree: `/home/devotek/Documents/Projects/Unnamed/FCM`
- Package target/provider: PROD relay, xScal-only configuration package
- Package: `dist/FCM-HUD-2.10.117-CONTROLLER-TEST-PROD-xScal.zip`
- Desktop overlay source changes: none
- Background bridge storage changes from `8314b50f` are retained; the installed background bridge
  was removed before installing the visible widget because those two HUD mods must not coexist.

The source change is limited to the visible HUD native adapter, widget/input helpers, tests,
simulator mocks/scenarios, package notices, and their owning documentation. The included changed
files are:

```text
docs/overlay/keybinds.md
docs/overlay/zfe/README.md
docs/testing/hud-automation-plan.md
game-mods/FCMBridge/FcmNativeApi.hx
game-mods/FCMBridge/TestFcmNativeApi.hx
game-mods/FCMBridge/hudmenu-chat/test_anchors.py
game-mods/FCMBridge/hudmodloader-chat/BUILD.md
game-mods/FCMBridge/hudmodloader-chat/CONTROLLER-TEST-ACCEPTANCE.md
game-mods/FCMBridge/hudmodloader-chat/CONTROLLER-TEST-MANIFEST.md
game-mods/FCMBridge/hudmodloader-chat/CONTROLLER-TEST-NOTICE.txt
game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.ba2
game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx
game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.swf
game-mods/FCMBridge/hudmodloader-chat/FcmInputRoute.hx
game-mods/FCMBridge/hudmodloader-chat/FcmZfeHotkeys.hx
game-mods/FCMBridge/hudmodloader-chat/FcmZfeInput.hx
game-mods/FCMBridge/hudmodloader-chat/README.md
game-mods/FCMBridge/hudmodloader-chat/TestFcmInputRoute.hx
game-mods/FCMBridge/hudmodloader-chat/TestFcmZfeHotkeys.hx
game-mods/FCMBridge/hudmodloader-chat/TestFcmZfeInput.hx
game-mods/FCMBridge/hudmodloader-chat/package.py
game-mods/FCMBridge/hudmodloader-chat/simulator/haxe/FCMHarness.hx
game-mods/FCMBridge/hudmodloader-chat/simulator/haxe/MockZfe.hx
game-mods/FCMBridge/hudmodloader-chat/simulator/haxe/OwnedInputScenario.hx
game-mods/FCMBridge/hudmodloader-chat/simulator/haxe/RosterScenario.hx
game-mods/FCMBridge/hudmodloader-chat/simulator/tests/smoke.spec.ts
game-mods/FCMBridge/hudmodloader-chat/test-zfe-hotkeys.hxml
game-mods/FCMBridge/hudmodloader-chat/test-zfe-input.hxml
game-mods/FCMBridge/hudmodloader-chat/test_package.py
```

## Provider requirements and claims

- ZFE requires positively advertised `input.v1` and `hotkeys.v1` capabilities for owner-scoped
  text input and registered action hotkeys. Older builds and unsupported tokens keep the existing
  SharedHUDTools/physical-key fallback.
- xScal uses the documented `Input.RegisterKey` and `Input.IsKeyPressed` contract for every
  supported configured action. SharedHUDTools text input remains best-effort. xScal 0.2.16 does
  not document keyboard capture/suppression, so this build does not claim text-entry parity.
- Native acceptance requirements and the separate, non-mutating overlay checklist are in
  `CONTROLLER-TEST-ACCEPTANCE.md`.

## Verification results

All results below were rerun on the reconciled local `dev` tree on 2026-09-21.

- All `test-*.hxml` HUD suites: pass, including input routing, owned-input validation, hotkey
  token/response validation, rotated profiles, overlap precedence, latching, recovery, and cleanup.
- Haxe compiler diagnostics: pass (`[]`).
- Native adapter and auth Haxe suites: pass.
- Emoji generation/catalog/layout/command suites: pass.
- Source anchors, package tests, BA2 tool tests, and SWF validator tests: pass.
- Production SWF validation: pass (`FWS`, version 32, 12,178 tags, terminal tag present).
- Full Playwright/Ruffle matrix: 65 passed in 5.3 minutes. The first run had one pre-scenario,
  five-second xScal harness-start timeout; the focused rerun passed in 3.1 seconds and the complete
  clean rerun passed. This includes three new ZFE owned-input
  release/busy/expiry scenarios and the existing provider, rebound-profile, held-key, modal,
  travel, reload, and shutdown coverage.
- Backend relay contract: 135 passed.
- Overlay widget/key logic (no overlay source changes): 196 passed.
- Final archive inspection: 17 entries; notice present; embedded BA2 byte-identical; PROD endpoint
  present in the xScal example; no ZFE fragment bundled.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,193,126 | `587fc0bbec77c990a7240d19acfbcbabc5a296a250e5021beebfa0abe4cfdcd7` |
| `FCMChatWidget.ba2` | 7,193,215 | `91ab8d6b7770ae7d11fa2821bb6ed756cf6af60aa656b8df2c6ebfc0718ab422` |
| `dist/FCM-HUD-2.10.117-CONTROLLER-TEST-PROD-xScal.zip` | 6,004,270 | `97276700b7607e30d6b1f2f9e8defb304b63550694af0e6262ecb4db0db6e254` |

## Local xScal installation

The game was confirmed closed immediately before installation. The tested BA2 was copied to
`Data/FCMChatWidget.ba2` and compared byte-for-byte. `FCMChatWidget.version.txt` is `2.10.117`.
The loader registry is exactly `FCMChatWidget` plus the pre-existing `ImprovedBars`. Existing
`Data/FCMChat.ini` and `xscal.ini` are byte-identical to their backups; xScal remains enabled on
`wss://falloutchatmod.com/relay`. The installed xScal `dxgi.dll` was not changed.

The active `Data/FCMServerBridge.ba2`, its cached `Data/modsdata/fcmserverbridge-prod.json`, and
three inactive bridge BA2 backups formerly under `Data/` were removed from the install and retained
under `.extender-backups/before-fcm-hud-2.10.117-controller-xscal-20260921T190238Z/`. No desktop
overlay or game process was started, stopped, or modified.

## Rollback and promotion

For a manual test rollback, remove only the candidate BA2 and restore the tester's backed-up HUD
and provider files as described in `CONTROLLER-TEST-ACCEPTANCE.md`. Do not touch either desktop
overlay or the Fallout 76 process.

The controller work is reconciled into the local `dev` merge. Publication and release registration
remain separate, explicitly authorized operations after native acceptance.
