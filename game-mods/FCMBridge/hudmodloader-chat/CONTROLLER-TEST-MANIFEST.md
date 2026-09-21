# HUD 2.10.117 CONTROLLER-TEST Manifest

Status: private, native-unverified, unpublished, and not installed.

## Identity and scope

- Base commit: `e9144c75`
- Experimental branch: `test/controller-input`
- Worktree: `/home/devotek/Documents/Projects/Unnamed/FCM-controller-input-test`
- Package target/provider: hosted DEV, unified ZFE/xScal package
- Package: `dist/FCM-HUD-2.10.117-CONTROLLER-TEST-DEV.zip`
- Desktop overlay source changes: none
- Background bridge source changes: none

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

All results below were produced in the experimental worktree on 2026-09-21.

- All `test-*.hxml` HUD suites: pass, including input routing, owned-input validation, hotkey
  token/response validation, rotated profiles, overlap precedence, latching, recovery, and cleanup.
- Haxe compiler diagnostics: pass (`[]`).
- Native adapter and auth Haxe suites: pass.
- Emoji generation/catalog/layout/command suites: pass.
- Source anchors, package tests, BA2 tool tests, and SWF validator tests: pass.
- Production SWF validation: pass (`FWS`, version 32, 12,178 tags, terminal tag present).
- Full Playwright/Ruffle matrix: 63 passed in 5.0 minutes. This includes three new ZFE owned-input
  release/busy/expiry scenarios and the existing provider, rebound-profile, held-key, modal,
  travel, reload, and shutdown coverage.
- Backend relay contract: 135 passed.
- Overlay widget/key logic (no overlay source changes): 196 passed.
- Final archive inspection: 19 entries; notice present; embedded BA2 byte-identical; DEV endpoints
  present for both provider examples; no provider-specific ZFE fragment bundled in the unified ZIP.

`npm ci` for the simulator could not authenticate to the configured private registry (`E401`). The
already-installed dependency tree from the untouched primary worktree was copied into this isolated
worktree for the test run. No source or generated artifact was copied back to the primary worktree.

## Artifact hashes

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,192,861 | `819adc53714081fd22349e819c2426187230cf0316286d55989045ed2ccb9266` |
| `FCMChatWidget.ba2` | 7,192,950 | `8000ed8e52d359c542a89c787ffe55ad2b40909602479320d08d4d84a8b7ffc3` |
| `dist/FCM-HUD-2.10.117-CONTROLLER-TEST-DEV.zip` | 6,006,487 | `66772ed615ba4dabdafedbfae74e870fedd06cba57b8a23f54ed2f6fb53d7281` |

## Rollback and promotion

For a manual test rollback, remove only the candidate BA2 and restore the tester's backed-up HUD
and provider files as described in `CONTROLLER-TEST-ACCEPTANCE.md`. Do not touch either desktop
overlay or the Fallout 76 process.

Promotion requires explicit approval after native acceptance. Review and transplant the test-branch
commits to `dev`, reconcile source/docs, and rerun every gate on the promoted tree. Publication and
release registration remain separate, explicitly authorized operations.
