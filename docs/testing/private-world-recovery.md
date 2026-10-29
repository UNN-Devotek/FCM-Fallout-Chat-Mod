# Private-world recovery: automated testing and acceptance

Status: implementation candidate, unpublished. Native private-world acceptance is pending.
Automation models the relevant observations; it does not certify Fallout's private-world data
contract. There is no authoritative private/public flag or unique game-world ID in these inputs.

## Reproduced defects and scope

- **Confirmed in the regression:** changing the bridge's self label without changing roster names
  or source timestamp reused the previous observation sequence. The desktop/backend reject mutated
  evidence under that sequence. The fixed exporter advances the sequence while preserving the
  original observation deadline, and holding preserves the complete previous observation.
- **Confirmed in the regression:** a valid WebSocket upgrade reaching `completeUpgrade` with an
  aborted TCP stream reserved a slot that was never released, because no WebSocket connection
  event was emitted. The fixed reservation follows the TCP stream's close event exactly once.
- **Confirmed protocol gap:** native HUD roster controls support self aliases; desktop exports
  did not. The candidate carries bounded UI-observed aliases through file validation, authenticated
  observation ingestion and the existing coordinator. Reciprocal self-label corroboration within
  an unchanged generation preserves the session. Names remain matching evidence, never account auth.

These regressions identify concrete defects. They do not prove which caused the supplied users'
October 23–24 reports. Do not attribute every production split or cap rejection to these bugs.
No shared-population threshold, freshness deadline or connection limit was increased.

## Automated matrix

Reuse the existing suites and fixtures; no new test framework or production data is required.

| Boundary | Cases and expected result | Existing runner / CI gate |
| --- | --- | --- |
| Copied game observations → export | Account/character label switch advances evidence sequence but retains age; selected source and sanitized self aliases are exported; loading holds name/aliases/generation; blocked old-world self labels are discarded | `TestFcmBridgeState.hx`, `TestFcmBridgeExport.hx`; `gamemod-anchors` |
| Scoped file → desktop | Accept legacy schema 1 and optional aliases/source; reject excess, malformed or unrecognized fields; alias/source mutation under an unchanged observation fails; expiry is not extended | `local-bridge-files.test.js`; overlay `unit-vitest` |
| Authenticated observation → room | A two-player group with different account/character labels converges, switches self labels without a new session, loses authority immediately on timeout and recovers the surviving room/history from fresh reciprocal evidence | `localExportBridge.test.js`; `backend-jest` |
| Isolation | One-sided aliases cannot preserve identity; new generation, account/logout, expired evidence, stale confirmations and real hops reject previous authority/history; unchanged heartbeats cannot add aliases or renew evidence | `worldRoomContinuity.test.js`, `localExportBridge.test.js`, existing socket-authorization suites; `backend-jest` |
| Room → chat | Equal canonical room, bidirectional exactly-once delivery, common history, delayed discovery, repeated leave/rejoin and isolated provisional-room history | Existing compatibility cases in `localExportBridge.test.js`; `backend-jest` |
| Room → blue names | Fresh same-room peers only; observed aliases match; unlinked/banned/stale/other-room peers receive no cosmetic grant; TTL stays bounded | `nameplatePresence.test.js`; `backend-jest` |
| Native relay → socket budget | Five accepted, sixth rejected; aborted upgrade releases its reservation; RPC idle-close frees a slot; oversized frames fail; proxy-aware keyed IP references remain stable within a process | `relayHandler.test.js`, `upgradeRouter.test.js`; `backend-jest` |
| Diagnostics | Correlate account/actor/movie/request/source using references and counts; exclude raw credentials, account IDs, local/peer names and arbitrary build text; suppress ordinary heartbeat noise | `localExportBridge.test.js`; `backend-jest` |
| Actual compiled bridge SWF | Both providers: selected self-label changes, reciprocal aliases, alternate primary source, loading hold, real hop and teardown through sealed/accessor-backed provider fixtures | `packaged-bridge.spec.ts`; `hud-ruffle` |

The room/provider compatibility matrix is HUD/ZFE ↔ bridge/ZFE, HUD/ZFE ↔ bridge/xScal,
HUD/xScal ↔ bridge/ZFE and HUD/xScal ↔ bridge/xScal, plus HUD↔HUD and bridge↔bridge.
Backend fixtures exercise shared coordinator/history/delivery invariants; provider labels in a
backend fixture do not execute native extender code. Ruffle separately exercises both adapters
and actual packaged SWF bytes. Run the complete suites to retain expiry, redraw and teardown coverage.

## Execution order

1. Focused regressions, from the named workspace directories:

   ```bash
   # backend/
   npm test -- --runTestsByPath tests/localExportBridge.test.js tests/worldRoomContinuity.test.js tests/nameplatePresence.test.js tests/relayHandler.test.js tests/upgradeRouter.test.js
   # cross-platform-overlay/
   npm run test:unit -- __tests__/local-bridge-files.test.js __tests__/local-bridge-relay.test.js
   # game-mods/FCMBridge/hudmodloader-bridge/
   haxe test-state.hxml
   haxe test-export.hxml
   ```

2. Run all pure Haxe suites and the source/package/SWF validation checks in the existing
   `gamemod-anchors` CI job. Build/normalize the production widget and run the **complete**
   simulator suite, rather than selecting only the new cases:

   ```bash
   # game-mods/FCMBridge/hudmodloader-chat/
   haxe build.hxml
   python3 normalize_swf.py FCMChatWidget.swf
   cd simulator
   npm test
   ```

3. Run backend Jest, backend `npm run test:unit`, overlay and dashboard `npm run test:unit`,
   plus the workspace build/typecheck gates. Existing CI discovers these changed tests; no new
   opt-in job is needed. CI authorization must cover the final reviewed commit and a fresh
   `ci-approved` label. A local green run is not a hosted CI result.

The simulator binds only loopback, blocks unexpected external requests and tears down owned
movies/listeners/browser/server resources. Use condition-based waits; modeled time advancement
must never be reported as elapsed native-game acceptance. Save failures with source revision,
build/provider, scenario, expected/observed room references and structured diagnostics.

## Native acceptance after automation

Prepare matching backend/desktop/bridge candidates: older desktop versions reject the additional
export fields. Do not coinstall the visible HUD and background bridge on one client. Keep each
machine on its designated provider and install only with the game closed.

For each supported pairing, use two authorized clients and record fresh evidence:

1. Join a two-player private world and remain nearby with overhead names visible. Require equal
   canonical room, appropriate blue names and a unique test message in each direction exactly once.
2. Stand still beyond the 30-second observation bound while receiving genuine fresh game updates.
   Capture selected source, actual observation age and cosmetic replies when a grant disappears.
3. Repeat fast travel and enter/leave interiors. Require recovery of the surviving canonical room
   and common history once fresh reciprocal sightings return; no duplicate delivery.
4. Exercise a HUD reload and reconnect, then interrupt observations beyond expiry. Authority must
   stop at its existing deadline; only fresh observations can restore eligibility.
5. Move one player to another world, return to MainMenu and change account/session. Require
   isolation, no old-generation cosmetic grants and rejection of stale room confirmations/sends.
6. Repeat on a public world as a control. Retain component-level failure reasons; population size
   alone is not proof of a private world or an unwanted split.

Report automation and native outcomes separately. Do not stop Fallout76 or the user's production
overlay to drive this plan. A test package remains native-unverified until its own fresh capture
passes; promotion/publication is a separate authorized action.
