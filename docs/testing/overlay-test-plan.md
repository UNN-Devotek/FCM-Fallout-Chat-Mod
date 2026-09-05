# Overlay Test Plan

> **Status (updated 2026-06-06):** Phase 0 and the majority of Phase 1 P0 are **complete**. Both
> `cross-platform-overlay` and `admin-dashboard` have Vitest wired with jsdom + RTL (`test:unit`).
> Phase 1 P1 stateful/IPC, Phase 2 component/layout, and Phase 3 E2E remain on backlog.
> See the table below for per-unit status.
>
> **What's done:** overlay-core.js extraction (Group 1 pure helpers + `cmpVersions`), update-notification
> trigger + once-per-session guard, `no-autoupdate` absence guard, all ChatOverlay.tsx P0 pure helpers,
> public-mode lockdown RTL, bridge+onboarding core logic, shell-core helpers.
> **What's next:** P1 main-process IPC handlers (register/relay/discord/keybinds/visibility),
> stateful shell helpers (applyScale, tickIdle, navChannel), and E2E once the mock relay exists.
>
> **In-game HUD chat (chat.v1) — 2026-06-26:** the `FCMChatWidget.hx` pure-logic suite
> (`fcm-chat-widget-logic.test.js`) is ✅ Done and runs in the `unit-vitest` matrix (see the table
> below). Live in-game validation is **PASS on native Windows** (ZFE 0.9.9+, relay fixes #334/#335 —
> send round-trips end-to-end) and **BLOCKED on Proton/Wine** by an upstream Zig TLS bug (#326), so
> in-game send is validated manually on the Windows VM only. The SWF/transport layer remains
> manual-test (no automated in-game harness); see
> [../overlay/zfe/native-chat-relay/proton-status.md](../overlay/zfe/native-chat-relay/proton-status.md).

This plan covers the four overlay-related modules:

| Group | Source | Lines | Testability today |
| ----- | ------ | ----- | ----------------- |
| **main-process** | `cross-platform-overlay/main.js`, `preload.js` | ~2807 | LOW — exports nothing; eager `require('electron')` + side effects at import |
| **renderer-shell** | `cross-platform-overlay/src/shell.ts`, `main.tsx` | ~2204 | MIXED — DOM/IPC-coupled; a few pure helpers locked in closures |
| **onboarding-bridge** | `cross-platform-overlay/src/onboarding.ts`, `src/bridge.ts` | — | ~30% as-is / ~80% after refactor; global `fetch`/`WebSocket` patched at import |
| **chatoverlay-ui** | `admin-dashboard/src/features/chat/ChatOverlay.tsx` | 8399 | Pure helpers trivially testable once exported; component needs RTL harness |

## Completion status at a glance

| Area | Status | Test file(s) |
|------|--------|-------------|
| **Phase 0 — tooling** | ✅ Done | `vitest.config.ts` in both packages |
| Group 1 — `overlay-core.js` pure helpers | ✅ Done | `__tests__/overlay-core.test.js`, `overlay-core-visibility.test.js` |
| Group 1 — `no-autoupdate.test.js` (absence guard) | ✅ Done | `__tests__/no-autoupdate.test.js` |
| Group 2 — `shell-core.ts` helpers | ✅ Done | `src/__tests__/shell-core.test.ts` |
| Group 1 — `cmpVersions` + `showUpdateNotification` | ✅ Done | `__tests__/overlay-core.test.js` (cmpVersions), `__tests__/update-notification.test.js` (trigger/guard) |
| Group 3 — `bridge-core.ts` fetch/WS shim | ✅ Done | `src/__tests__/bridge.test.ts` |
| Group 3 — `onboarding-core.ts` state machine | ✅ Done | `src/__tests__/onboarding-core.test.ts` |
| Group 4 — `ChatOverlay.tsx` P0 pure helpers | ✅ Done | `src/features/chat/__tests__/chatOverlayHelpers.test.ts` |
| Group 4 — `ChatOverlay.tsx` public-mode lockdown | ✅ Done | `src/features/chat/__tests__/publicModeLockdown.test.tsx` |
| In-game HUD widget — `FCMChatWidget.hx` pure logic (normChannel, optimistic-echo dedup/expiry, send-error→message map, slash parse/consume, empty-feed notice priority) | ✅ Done | `__tests__/fcm-chat-widget-logic.test.js` (+ ported `fcm-chat-widget-logic.js`) — runs in the `cross-platform-overlay` leg of the `unit-vitest` CI matrix |
| Group 1 P1 — main.js IPC handlers (register/relay/discord/keybinds/visibility) | ⏳ Backlog | — |
| Group 2 P1 — shell.ts stateful (applyScale, tickIdle, navChannel, auth machine) | ⏳ Backlog | — |
| Group 3 P1 — `ProxiedWebSocket` lifecycle, onboarding IPC/UI | ⏳ Backlog | — |
| Group 4 P1 — `computePickerAnchor` zoom (partially done), mod-action lockdown | ⏳ Backlog | — |
| Group 2/4 P2 — component/layout (collapse, resize, chipField, Avatar, BlockManager) | ⏳ Backlog | — |
| Phase 3 — E2E (Playwright `_electron` + dashboard browser vs mock relay) | ⏳ Blocked (no mock relay) | — |

---

**Runner decision:** Vitest + jsdom + @testing-library for `cross-platform-overlay` and
`admin-dashboard` (both already run Vite 6 + `@vitejs/plugin-react` — Vitest reuses the exact transform
pipeline with zero extra config). Backend keeps Jest. Electron + browser E2E use Playwright
(`_electron` API for the desktop app) against a **hermetic mock relay** (never prod).

---

## Priority legend

- **P0** — Pure/near-pure logic that gates correctness or security (visibility, public-mode lockdown,
  hysteresis, settings persistence). Cheap to test once exported; highest value per hour.
- **P1** — Stateful/IPC logic with mockable deps (HTTP register/retry, IPC handlers, collapse/expand,
  updater wiring, auth state machine). Needs mocks + fake timers.
- **P2** — DOM/layout-sensitive or platform-specific behavior best covered by E2E, or lower-frequency
  paths (tray menu, drag/resize math, chip fields).

---

## Group 1 — main-process (`main.js` / `preload.js` / `updater.js`)

### P0 — pure helpers + core gating logic (extract first)

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `stateHasRealData` branch table | main.js:713 | pure | Extract to `overlay-core.js`; table-drive discordLinked / non-default username / non-empty settings vs null/empty/default | P0 |
| `isCfChallenge` status+header matrix | main.js:823 | pure | 503→true; 403 cf-mitigated/text-html/cf-browser-verification→true; 403 JSON→false; 200/429→false | P0 |
| `isSinglePrintableChar` | main.js:1941 | pure | Named keys/modifier-prefixed/multi-char→false; single printable→true; empty/non-string→false | P0 |
| `resolveAppClientKey` precedence | main.js:632 | stateful | `vi.stubEnv` + `vi.mock('fs')`; env > backend/.env > ../.env > default; trimming | P0 |
| `resolveAppVersion` (extract from IIFE) | main.js:256 | stateful | Extract `resolveAppVersion(fs,dir)`; csproj `<Version>` → package.json → '0.0.0' | P0 |
| `canShowOverlay` / `isPrivileged` cartesian | main.js:435 | stateful | Make pure `canShowOverlay(state)`; exhaustive 4-input table (forceVisible/role/gameRunning/chatActive) | P0 |
| ~~`onGamePresenceChanged` hysteresis~~ ✅ DONE | overlay-core `nextPresenceState` | pure | Extracted to pure `nextPresenceState({found,gameRunning,candidate,stableCount,appearScans,disappearScans})`; tested in `overlay-core-visibility.test.js` (asymmetric on/off thresholds, failed-scan=null keeps state, consecutive-reset). | — |
| `clampToWorkArea` clamping | main.js:795 | pure | Inject `screen`-like stub w/ fixed workArea; width/height MIN clamp, x/y defaults, edges never exceed | P0 |
| `loadState`/`saveState` self-heal | main.js:644 | stateful | `vi.mock('fs')` + inject STATE_FILE; generates installToken+username, tolerates corrupt JSON→{}, merge-on-patch | P0 |
| `migrateLegacyUserData` decision matrix | main.js:721 | stateful | Mock fs + synthetic 'Fallout Chat Mod' userData; legacy-real × current(missing/pristine/real); never overwrite real | P0 |

### P1 — visibility, keybinds, HTTP/relay, IPC

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `reevaluateVisibility` userHidden semantics | main.js:1848 | stateful | Mock BrowserWindow spies; show only when canShow && !userHidden; per (canShow,userHidden) combo | P1 |
| `emitVisibility` 20s hide grace | main.js:337 | stateful | `vi.useFakeTimers`; visible=true immediate+cancels pending; false schedules 20s; double-false ignored | P1 |
| `registerHotkeys` + accelToAction map | main.js:1985 | stateful | Mock globalShortcut; defaults for missing keys, goFo76 honors '', party blank→unregistered, isChar flags, presets | P1 |
| `refreshShortcuts` idempotent gating | main.js:1965 | stateful | Mock globalShortcut + isFocused; stateKey memo no-op, unregister when inactive, char binds skipped while focused; platform branch | P1 |
| `applyFocusClickThrough`/`desiredTopmost`/`setMouseIgnore` | main.js:2080 | stateful | Extract `desiredTopmost`+ignore-decision pure; fake timers for FOCUS_GUARD_MS; toggle platform | P1 |
| `registerForToken` response handling | main.js:836 | electron-coupled | Mock http/https req via injectable httpModule; 429→cfTransient, 403 provider `auth_required` (legacy `discord_auth_required` accepted) before CF, Steam link state mapping, success field mapping, 15s timeout | P1 |
| `startRelay` retry/backoff classification | main.js:1677 | electron-coupled | Stub registerForToken rejecting tagged errors; fake timers; assert relay:status payloads + backoff per error shape | P1 |
| `proxy:http` IPC handler | main.js:932 | ipc | Capture handler via mocked ipcMain; ws-ticket short-circuit, header forwarding, cf mapping, req error→599 | P1 |
| `proxy:ws:*` lifecycle + `app:update-available` intercept | main.js:976 | ipc | Mock `ws` EventEmitter; 4001 without token, forward open/msg/close/error, intercept `app:update-available`→`showUpdateNotification` (only when latestVersion > APP_VERSION, once-per-session guard) | P1 |
| `identity:set-name` handler | main.js:1538 | ipc | Capture handler; empty/no-key/no-token reasons, 409→taken soft-fail, success re-register+rebuildTray | P1 |
| `refreshDiscordStatus` / `refreshSteamStatus` retry + post-link re-register | main.js:1429 | ipc | Mock http + fake timers; backoff up to MAX_STATUS_ATTEMPTS=4, newly linked provider adopts identity + re-register, recovery via startRelay | P1 |

### P2 — window chrome / tray

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `collapseToHeader`/`expandFromHeader`/`animateHeightTo` | main.js:2249 | electron-coupled | Fake timers + mock window; collapse snapshots exact height, expand restores height only (keeps w/x/y), 240ms ease | P2 |
| `rebuildTrayMenu` role/state template | main.js:2356 | electron-coupled | Extract `buildTrayTemplate(state)`; assert items per role+platform, invoke click() fns | P2 |

---

## Group 2 — renderer-shell (`shell.ts` / `main.tsx` / `updater-ui.ts`)

### P0 — pure helpers (extract/export first)

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `accelFromEvent` DOM→accelerator | shell.ts:1038 | pure | **Export.** modifier ordering, modifier-only→null, ' '→Space, char upper-cased, named keys passthrough | P0 |
| `prettyAccel` formatting | shell.ts:1655 | pure | **Export.** CommandOrControl→Cmd/Ctrl by platform, '+'→' + ', empty handled | P0 |
| `collectChannels` normalization | shell.ts:796 | pure | **Export.** always General/Trading/Events/Raids, UPPER→Title, sort+dedupe | P0 |
| `resolveAvatarUrl` | main.tsx:81 | pure | **Export.** absolute passthrough, relative prefixed w/ relayBase (slash dedupe), empty→undefined | P0 |
| `applyShellChromeTheme` CSS vars | shell.ts:189 | pure | jsdom; per theme id sets --shell-primary/text/primary-dim, unknown→green, dim=primary+'2E' | P0 |
| `computeResizeBounds` (extract from closure) | shell.ts:1929 | pure | **Refactor** `computeResizeBounds(edges,start,dx,dy,MIN_W,MIN_H)`; per-edge deltas, MIN clamp + re-anchor on w/n | P0 |
| `isDragTarget` (hoist out of closure) | shell.ts:2038 | pure | **Refactor/export.** false for rz/btn/inputs/contentEditable/backdrops; true for #shell-bar + appRegion drag ancestors | P0 |
| `loadShellSettings` merge/reset/preset-fill | shell.ts:201 | stateful | Stub localStorage + `__FCM_SAVED_SETTINGS__`; deep-merge, one-time keybind reset stamps version, always 8 presets, corrupt→defaults | P0 |

### P1 — stateful UI + state machines

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `applyScale` CSS zoom | shell.ts:318 | stateful | **Export.** jsdom #root; fontSize clamp 0.5..2.5, zoom unset within 0.005 of 1.0, stale cleared | P1 |
| `applyWindowVisual` opacity vars + IPC | shell.ts:299 | electron-coupled | **Export.** mock relayBridge.setWindowOpacity; clamp alphas, panel/backdrop bg cleared | P1 |
| `persistLocal` WEB mirror | shell.ts:242 | stateful | **Export.** WEB mirror forces windowOpacity:1 + fontSize:14, carries theme/textOpacity/showHints | P1 |
| `tickIdle` guards | shell.ts:614 | stateful | **Export.** fake timers; no collapse while fade off / panels open / `__fcmMenuOpen` / input focused; collapse after IDLE_FADE_MS=25000 | P1 |
| `markMessageActivity` debounce | shell.ts:598 | stateful | **Export.** fake timers; burst within 1500ms → one markActivity | P1 |
| `navChannel`/activeTabIndex cycling | shell.ts:755 | stateful | jsdom fixture spans; active by fontWeight bold, next/prev wrap, no-op when zero | P1 |
| Shell auth state machine (onStatus) | main.tsx:185 | ui-component | RTL render `<Shell>`; capture onStatus cb; authenticated/discord_required/error(429)/authStuck-25s; remount only on identity change | P1 |
| `wireShellInputBehaviour` /hide intercept | main.tsx:146 | stateful | **Export.** mock relayBridge; Enter on editable '/hide'→preventDefault+hideViaSlash; focus-input prefers contenteditable | P1 |
| `cmpVersions` helper | overlay-core.js | pure | newer/older/equal semver, multi-digit (`1.3.9` vs `1.3.10`), malformed input → P0 |
| `showUpdateNotification` trigger logic | main.js | stateful | fires when latestVersion > APP_VERSION; not when equal/older; once-per-session guard (`updateNotifiedThisSession`) suppresses reconnect toasts; click calls `shell.openExternal(NEXUS_MOD_URL)` | P1 |

### P2 — DOM/layout (E2E preferred)

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `headerStripHeight` collapse calc | shell.ts:385 | stateful | playwright-electron via `__fcmHeaderStripHeight()` hook (real layout); jsdom can't compute rects | P2 |
| `setCollapsed`/`applyCollapsedHidden`/`reassertCollapsed` | shell.ts:489 | stateful | playwright-electron via `__fcmForceCollapse/__fcmForceExpand`; class toggles in jsdom only | P2 |
| `chipField` behavior | shell.ts:811 | ui-component | **Export** + jsdom/RTL; filter/add/dup-reject/backspace/Esc; stub rects for popover flip | P2 |
| `accountBlockField` block list | shell.ts:920 | ipc | **Export** + mock fetch ({data} envelope); GET populate, debounced search 220ms, optimistic add/remove + rollback | P2 |
| Slider `valueFromFraction` (extract) | shell.ts:1198 | stateful | **Refactor** pure `valueFromFraction(clientX,rect,min,max,step)`; e2e for real pointer | P2 |
| `setInteractive` hover reporting | shell.ts:2158 | stateful | Extract predicate; mock setInteractive; fires only on transition | P2 |

---

## Group 3 — onboarding-bridge (`onboarding.ts` / `bridge.ts`)

### P0 — extractable decision logic

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `deriveInitialOnboardingState` | onboarding.ts:120 | pure | **Extract.** fo76Name fallback chain, discord:*/Overlay* treated empty, theme default, display-name precedence | P0 |
| `finish()` decision tree | onboarding.ts:505 | stateful | **Inject deps** (applyOnboardingSettings, bridge); patch shape, wantName gate, setIdentityName only when bridge+wantName, {nameTaken} only on reason==='taken', notify fallback chain | P0 |
| `computeNavView` step/progress (extract) | onboarding.ts:188 | pure | **Extract.** pct=((idx+1)/3)*100, back hidden at 0, GET STARTED at last, clamp | P0 |
| name-taken reducer (extract) | onboarding.ts:215 | stateful | **Extract** `(state,result)→{note,disabled,skipNameOnNextFinish,dismiss}`; first press shows warn+skip, second proceeds | P0 |
| `applyRelayBase`/relayBase derivation | bridge.ts:165 | pure | **Export.** loopback→http, else https, empty host/missing hook→no-op; sync preferred, async fallback | P0 |
| fetch shim relay-path routing | bridge.ts:180 | ipc | **Export `installFetchShim(bridge,nativeFetch)`.** only /api,/auth,prod intercepted; string/URL/Request extraction; Response wrap | P0 |

### P1 — IPC + lifecycle

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `ProxiedWebSocket` lifecycle | bridge.ts:219 | ipc | **Export class + install fn.** id alloc, liveSockets register, wsOpen/Send/Close proxy, _fire* update readyState + handlers, map cleanup | P1 |
| `showOnboarding`/`hideOnboarding` _completed guard | onboarding.ts:95 | stateful | jsdom + mock bridge; `vi.resetModules` between cases; show early-returns when completed, setModalInteractive toggles | P1 |
| discord status render + onDiscordStatus | onboarding.ts:440 | ipc | jsdom + capture onDiscordStatus cb; linked/unlinked UI, @handle only when name≠display, avatar gating, fo76 default on linked | P1 |
| identity prefill rules | onboarding.ts:286 | ui-component | jsdom; `__fcmPrefill` no-ops if typed/no-default, else fills+enables; toggle prefill only on enable+empty | P1 |
| discord button IPC wiring | onboarding.ts:402 | ipc | jsdom + fake bridge spies + fake timers; join URL, link, refresh transient state restore 3s | P1 |
| `__FCM_OVERLAY_SHELL__` shell-hook actions | bridge.ts:154 | ipc | **Wrap install in exported fn.** onRefresh/onSettings CustomEvents, onMinimize/onClose bridge calls | P1 |

---

## Group 4 — chatoverlay-ui (`admin-dashboard/.../ChatOverlay.tsx`)

### P0 — pure helpers (add named exports; zero refactor otherwise)

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `findTheme` | ChatOverlay.tsx:142 | pure | **Export.** match by id, unknown→THEMES[0] | P0 |
| `hexToRgba` / `hexAlpha` | ChatOverlay.tsx:289,297 | pure | **Export.** parse #RRGGBB→rgba, alpha 3-dp rounding, # stripped | P0 |
| `menuBgColor` readability floor | ChatOverlay.tsx:306 | pure | **Export.** alpha floored to ≥0.9, capped 1, regardless of chromeBgAlpha | P0 |
| `truncateUrl` | ChatOverlay.tsx:889 | pure | **Export.** strip trailing punct, drop www, append /… on path, 32-char cap, garbage fallback | P0 |
| `classifyMedia` | ChatOverlay.tsx:917 | pure | **Export.** image/video ext sets, tenor/discord host fallback w/ path.length>1, tolerate ?query/#hash | P0 |
| `splitParts` | ChatOverlay.tsx:938 | pure | **Export.** plain/mention/url/emoji spans sorted, overlap drop, emoji CDN url animated vs png, trailing plain | P0 |
| `splitMentions` adapter | ChatOverlay.tsx:977 | pure | **Export.** thin over splitParts→{text,mention} | P0 |
| `contentMentionsName` | ChatOverlay.tsx:982 | pure | **Export.** case-insensitive word-boundary, name<2→false, repeats | P0 |
| `loadSettings`/`saveSettings` | ChatOverlay.tsx:273,283 | stateful | **Export.** merge defaults, corrupt→defaults, round-trip 'fcm_web_overlay_settings', swallow quota | P0 |
| `getOverlayShell` mock seam | ChatOverlay.tsx:166 | electron-coupled | **Export.** returns global or null, never throws — THE surface-selection seam | P0 |
| `resolveAvatarUrl`/`resolveMediaUrl` | ChatOverlay.tsx:182,204 | electron-coupled | **Export.** null passthrough, absolute as-is, relayBase prefix (slash dedupe), no-shell passthrough | P0 |
| `backoffDelay` full-jitter (extract from line 2938) | ChatOverlay.tsx:2938 | ipc | **Extract** `backoffDelay(attempt,rand)`; cap 16s, exponential, jittered; seed random | P0 |
| `channelTag` Trading→Trade (extract from line 5549) | ChatOverlay.tsx:5530 | ui-component | **Extract** `channelTag(msg,channels,parties)`; Discord/Server/party/channel tag+color, Trading→Trade, system→none | P0 |

### P1 — public-mode lockdown + computePickerAnchor

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| `computePickerAnchor` zoom + clamp | ChatOverlay.tsx:1012 | pure | jsdom; mock innerW/H + getComputedStyle().zoom; zoom=1 no-op, zoom=1.14 scale, viewport clamp | P1 |
| `isPublicMode` derivation | ChatOverlay.tsx:1618 | ui-component | RTL; toggle user (Outlet ctx) × shell global; validate via observable UI | P1 |
| Public-mode input lockdown | ChatOverlay.tsx:5674,5873 | ui-component | RTL; composer/emoji row absent in public, present authed | P1 |
| Public-mode WS/party lockdown | ChatOverlay.tsx:2882,2618 | ipc | RTL + WebSocket constructor spy; never called in public; party queries disabled | P1 |
| Public-mode mod-action lockdown | ChatOverlay.tsx:6498 | ui-component | RTL contextMenu; mod/admin items only when isMod/isAdmin && !public, across 4 role cases | P1 |

### P2 — component rendering (RTL, heavier)

| Test | Target (file:line) | Kind | Approach | Priority |
| ---- | ------------------ | ---- | -------- | -------- |
| Combined-feed channel-tag render | ChatOverlay.tsx:5530 | ui-component | RTL seeded messages; assert tag text per source; Trading→Trade | P2 |
| Combined-feed filtering | ChatOverlay.tsx:4094 | ui-component | RTL seeded messages+blockedIds; blocked hidden, others present | P2 |
| Two-row Pip-Boy tab bar | ChatOverlay.tsx:4701,5012 | ui-component | RTL; both rows render, members tab gated by shell+party+!public | P2 |
| `Avatar` | ChatOverlay.tsx:220 | ui-component | **Export.** img on resolved src, letter fallback on null/onError | P2 |
| `BlockManagerBody` | ChatOverlay.tsx:328 | ui-component | **Export** + mock api + fake timers; load/search-debounce/add/remove/onBlockChange | P2 |
| `SettingsModal` | ChatOverlay.tsx:477 | ui-component | **Export** + mock api; slider/toggle onChange payloads, hideShellSliders gating | P2 |

---

## Source refactors needed for testability

These unblock the P0/P1 tests above. Ordered by leverage. **Do the extractions before writing the
tests they enable** — otherwise the test depends on an electron mock or a full DOM mount.

### main.js (the single biggest blocker)

| Refactor | Unblocks | Risk |
| -------- | -------- | ---- |
| **`main.js` exports nothing** — extract pure logic into a new side-effect-free `overlay-core.js`; have `main.js` import it | Every main-process unit test | HIGH — large surface; must not change runtime wiring. Mitigate: move functions verbatim, re-import. |
| **Move top-level side effects behind `init()`** (process.on handlers, `app.commandLine` switches, `STATE_FILE=app.getPath(...)`, APP_VERSION IIFE, ipcMain registrations, `app.whenReady`) | Importing the module under vitest without firing timers/handlers | HIGH — easy to drop a switch and change prod behavior. Guard with `if (require.main===module) init()`. |
| Extract deps-free helpers: `stateHasRealData`, `isCfChallenge`, `isSinglePrintableChar`, `resolveAppVersion(fs,dir)`, `resolveAppClientKey(env,fs,dir)` | 5× P0 pure tests, zero electron mock | LOW |
| Make `clampToWorkArea`, `desiredTopmost`, `canShowOverlay`, ignore-decision, `refreshShortcuts` active/overlayFocused calc **pure** (take state args, not module lets) | P0 gating tests | MED — must thread state through callers. |
| ~~Convert game-presence hysteresis to a state-machine object~~ ✅ DONE — extracted the decision to the pure `overlayCore.nextPresenceState()` reducer (module `let`s stay in `onGamePresenceChanged`, which is now a thin wrapper) | — | — |
| Inject `http` module + `sendToRenderer` + `loadState/saveState` into `registerForToken`/`startRelay`/`refreshDiscordStatus`/`identity:set-name` | All HTTP/IPC P1 tests with fakes | MED — they close over module globals + the `httpModule()` switch. |
| Expose `mainWindow`, `relaySockets`, `currentKeybinds`, `_allBinds`, visibility flags via accessors/injection | window-driven tests against mock BrowserWindow | MED |
| Factor `buildTrayTemplate(state)` pure builder | tray menu test | LOW |
| Add shared electron mock (vitest setup): app/BrowserWindow/globalShortcut/Tray/Menu/screen/Notification/ipcMain/nativeImage/shell/clipboard as `vi.fn()` + event-capturing ipcMain | every integration-style main test | LOW (one-time fixture) |

### shell.ts / main.tsx

| Refactor | Unblocks | Risk |
| -------- | -------- | ---- |
| Export private pure fns: `accelFromEvent`, `prettyAccel`, `collectChannels`, `resolveAvatarUrl` | 4× P0 tests | LOW |
| Extract `computeResizeBounds(edges,start,dx,dy,MIN_W,MIN_H)` from pointermove closure | resize math P0 | LOW |
| Extract `valueFromFraction(clientX,rect,min,max,step)` from slider closure | slider P2 | LOW |
| Hoist `isDragTarget` to module scope + export | drag P0 | LOW |
| Export visual/idle helpers (`applyScale`, `applyWindowVisual`, `persistLocal`, `tickIdle`, `markMessageActivity`, `setCollapsed`) or thin wrappers | P1 shell tests | LOW |
| Inject `window.relayBridge` as a seam / mock factory instead of reading global | clean IPC assertions | MED — used throughout; provide a factory rather than rewiring every call. |
| Factor Shell auth/identity remount decision into a pure reducer (main.tsx:277) | remount-on-identity test | MED |
| Make idle/collapse timing constants injectable | deterministic timer tests | LOW |
| Split entry-module side effects (mountShellBar, React root, initShell) so logic imports without firing chrome | importing under vitest | MED |

### onboarding.ts / bridge.ts

| Refactor | Unblocks | Risk |
| -------- | -------- | ---- |
| Extract `deriveInitialOnboardingState(settings,passedName)` | P0 state derivation | LOW |
| Make `finish()` injectable (deps: `applyOnboardingSettings`, `bridge`) instead of hard `./shell` import + global `relayBridge` | P0 finish tree — **biggest onboarding blocker** | MED |
| Extract `computeNavView` + name-taken reducer | P0 nav/retry tests | LOW |
| Move `_completed`/`_backdropEl` singletons behind a factory/reset hook | order-independent tests | MED — or rely on `vi.resetModules` (flaky if forgotten). |
| Convert bridge.ts import-time side effects into `installShellHook`/`installFetchShim`/`installWebSocketShim`; export `ProxiedWebSocket` + `applyRelayBase` | all bridge tests | HIGH — bridge patches **global** `window.fetch`/`WebSocket` at import; can poison the shared jsdom env. Must be install/teardown per test. |
| Add a shared constants module so channel-name IPC contract can be cross-checked vs preload | contract test main↔preload↔bridge | MED — channel strings live in main.js/preload, NOT bridge.ts; interface-only tests drift from the wire. |

### ChatOverlay.tsx

| Refactor | Unblocks | Risk |
| -------- | -------- | ---- |
| Add named exports for all pure helpers (or move to `chatOverlay.helpers.ts` re-imported by the component) | 13× P0 helper tests — **highest value per hour in the whole plan** | LOW |
| Extract `backoffDelay(attempt,rand)` from inline ws.onclose (line 2938) | deterministic backoff test | LOW |
| Extract `channelTag(msg,channels,parties)` + source→color (5530-5552) | tag logic without full render | LOW |
| Export `Avatar`/`BlockManagerBody`/`SettingsModal`/`BlockManagerModal` | focused RTL P2 tests | LOW |
| Provide RTL harness: `QueryClientProvider` + `MemoryRouter` with Outlet ctx `{user}` | any component mount | MED — component reads `useOutletContext`/`useQueryClient` at top level; mount throws without both. |

### Cross-cutting tooling

- Add **Vitest + jsdom + @testing-library/(react|dom) + user-event** to **both** `cross-platform-overlay`
  and `admin-dashboard`. Neither has a runner today.
- `admin-dashboard` `package.json` `test` is **already** Playwright — add a **separate** `test:unit`=`vitest run`;
  do NOT clobber `test`. `vitest.config.ts` must `test.exclude` the `./tests` (playwright) dir.
- Reuse each package's existing vite plugins (react, tailwind) in `vitest.config.ts`; `environment:'jsdom'`,
  `globals:true`, setup file for `@testing-library/jest-dom` matchers.

---

## E2E scenario catalog

E2E tier uses Playwright `_electron.launch({ args:['.'] })` (desktop) and `vite preview` (dashboard),
both against the **hermetic mock relay** (next section). On Linux CI wrap with `xvfb-run -a`. These
start **non-required** in branch protection; promote once green-stable (~20 runs).

### Desktop overlay (`_electron`)

1. **Cold start, no game, fresh install** — window hidden until onboarding reachable (chatActive=false bypass) → onboarding visible → complete with FO76 not running → drops to tray + system notification → launch FO76 (mock `scanForGame`) → overlay auto-appears (userHidden stayed false).
2. **Game-scan hysteresis under flaky tasklist** — alternate found/not-found; `gameRunning` does NOT flip until PRESENCE_FLIP_SCANS consecutive agreeing scans; assert no z-order/visibility churn (call counts).
3. **Explicit hide then game relaunch** — Delete (userHidden=true) → stays hidden though game running, until not-running→running clears userHidden and restores.
4. **Keybind focus-gating** — overlay focused: '/' and '\\' NOT registered (typeable); game foreground + overlay blurred: registered; other app foreground: all unregistered.
5. **Provider OAuth link flows** — `discord:link` or `steam:link` → callback nav → window closes + matching status refresh → poll linked=true → re-register → authenticated relay:status; load failure falls back to `shell.openExternal`.
6. **Update notification happy path** — relay WS `{type:'app:update-available', payload:{latestVersion:'X.Y.Z'}}` with latestVersion > APP_VERSION → OS notification fires (title `Update! vX.Y.Z`, click opens Nexus URL); equal/older version → no notification; second `app:update-available` in same session → once-per-session guard suppresses duplicate toast.
7. **productName migration** — legacy `Fallout ChatMod/overlay-state.json` (discordLinked, current pristine) → migrate copies; current real never overwritten.
8. **Relay register resilience** — CF 503→cfTransient + retry 5s; 429→10s; ECONNREFUSED→exp backoff to 8 tries; provider `auth_required` (and legacy `discord_auth_required`) 403→login wall, no retry.
9. **Idle collapse/expand preserving width** — narrow window, idle-collapse to header, hover-expand → restores height only, keeps narrower width.
10. **Onboarding-without-game handoff (primary)** — fresh install, FO76 not running, complete 3 steps with free name → `setIdentityName` ok, `applyOnboardingSettings` persists, `notifyOnboardingComplete` engages game-gate, tray drop + notification; then start FO76 → auto-appears.
11. **Onboarding on older main lacking `notifyOnboardingComplete`** — same flow, assert fallback to `notifyChatActive(true)` still engages gate (no crash).
12. **FO76 name taken** — first GET STARTED shows warn, keeps open, skipNameOnNextFinish; second completes keeping generated name + same handoff.
13. **Collapse height correctness across scales** — `?fontsize=16/22`, force collapse → `__fcmHeaderStripHeight` stays in [24,160] DIP, input never reveals; both FO76 and Party sub-tab rows.
14. **Resize-while-collapsed re-assert** — force collapse, fire resize → input never peeks, scrollTop reset to 0, re-anchored.
15. **Linux drag-move / edge-resize** — pointerdown on #shell-bar/header fires move IPC; on .shell-btn/input does NOT; 8 resize zones send correctly-signed deltas + MIN clamp; zones disabled while collapsed/modal/click-through.
16. **Collapsed overlay pops out on incoming message** — regression guard for commit `efddfad`.
17. **Network bridge integration (packaged)** — real ChatOverlay `fetch('/api/channels')` + WS proxied through `bridge.http`/`bridge.wsOpen` to mock relay; avatar `<img src='/avatars/..'>` resolves against relayBase.

### Dashboard / shared ChatOverlay (browser)

18. **Public website lockdown** — no auth + no shell → no composer/member panel/party browser/mod actions; authed WS never opened (no `ws://` upgrade).
19. **Authed dashboard happy path** — login as member → WS connects, channels load, send in General, appears with correct [Trade]/[Discord]/[Server] tags.
20. **Mod actions visible only to mods** — moderator right-click shows mute/delete; member does not.
21. **Self-edit ownership and Discord sync** — an authenticated user can right-click and edit their own channel, party, and PM message; another user's message, bot/system/server message, and public mode do not show Edit. A bridged channel edit mirrors the bot copy in Discord, and a human Discord `messageUpdate` patches the overlay row.
22. **Reconnect resilience** — kill WS → retries with growing (≤16s) jittered backoff, resubscribes party chat without dup (ID dedup).
23. **Block flow** — Settings → block via search → messages disappear; unblock → reappear after refresh.
24. **Auth state machine via mocked IPC** — authenticated/discord_required/error(429)/stuck-25s → correct screen; second authenticated same identity does NOT remount, changed identity DOES.
25. **No auto-update artifacts** — packaged build contains no `updater.js`, no `updater-ui.ts`, no `electron-updater` dep, no `app-update.yml`, no `latest*.yml` (asserted by `no-autoupdate.test.js`).
26. **chat-smoke repointed to mock** — `/api/health` 200, `/api/channels`→`{data:[]}`, `/api/users` requires `X-App-Client-Key` (403), unknown discord token→`linked:false`.

---

## Hermetic mock-relay design

**Goal:** tests NEVER hit prod. The current `tests/e2e/chat-smoke.spec.ts` defaults `BASE_URL` to
`https://falloutchatmod.com` — this **must** be repointed at the mock in CI (keep prod only behind an
explicit `workflow_dispatch` "prod-smoke").

### Shape

> **Removed.** The `tests/mock-relay/` directory was deleted when the auto-update E2E it served
> was retired. `overlay-launch-smoke-linux` runs `scripts/ci-launch-smoke.mjs` with no relay
> fixture; the Windows artifact check moved to `.github/scripts/win-artifacts-check.mjs`. The
> design below is preserved as historical context — a future Playwright `_electron` or
> `dashboard-playwright` suite would need a fresh fixture rather than restoring this one.

A tiny in-process fixture under **`tests/mock-relay/`** (historical), intended for `overlay-launch-smoke-linux` and
`overlay-build-windows-nsis` (artifact check); to be extended for future Playwright `_electron` and
`dashboard-playwright` suites:

- **REST (Express)** stubs:
  - `GET /api/health` → 200 `{ status:'ok' }`
  - `GET /api/channels` → `{ data: [ General, Trading, Events, Raids ] }`
  - `GET /api/users` → **403** unless `X-App-Client-Key` header present (mirrors prod auth gate)
  - `GET /api/messages` → `{ data: [...seeded] }`
  - `POST /auth/discord/*` → configurable `{ linked:false }` / `{ linked:true, role, avatarUrl }`
  - `GET /api/block` + `/api/block/search`, `POST`/`DELETE /api/block` for block-flow tests
  - `POST /api/register` (overlay token) → `{ data:{ token, userId, userRole, discord*, steamLinked } }`; can be
    scripted to return 429 / 503-CF / 403-auth_required for resilience scenarios
- **WebSocket (`ws` server on an ephemeral port)**:
  - accepts the authed handshake (asserts `X-Auth-Token`); a connection **without** a token is the
    public-mode regression signal (assert it never arrives)
  - emits `chat:message`, `presence:update`, and `{type:'app:update-available', payload:{latestVersion}}` on command
  - **records** received frames (presence heartbeats, subscribes) so tests assert client behavior
- **Injection:** via the overlay's already-parameterized `RELAY_HTTP` / `RELAY_WS` env vars (and
  `TEST_URL` for the smoke spec). Dashboard: `vite preview --port 7075` wired to the same mock.

### Determinism rules

- Mock relay is launched as a Playwright `webServer`/fixture on an **ephemeral port** (no fixed-port
  collisions); the port is passed to the app via env.
- Scriptable response queue per endpoint (e.g. "next `/api/register` returns 503-CF") so retry/backoff
  scenarios are deterministic without real network failures.
- Heartbeat/timer assertions use the recorded-frames log + fake timers where possible, not wall-clock.
- `_electron.launch` on ubuntu+xvfb likely needs `--no-sandbox --disable-gpu` plus the existing
  QUIC-disable flags from recent commits.

---

## Effort estimates & phase sequencing

Estimates are rough engineer-days assuming the listed refactors land alongside the tests.

### Phase 0 — tooling foundation (~2–3 days)

- Add Vitest + jsdom + RTL to `cross-platform-overlay` and `admin-dashboard` (separate `test:unit`
  scripts; exclude playwright dir). Shared electron-mock fixture for main.js.
- **CI:** ✅ Done — `authorize`, `lint-typecheck`, `backend-jest`, `unit-vitest` (matrix),
  `overlay-launch-smoke-linux`, `overlay-build-windows-nsis` all wired into `ci-summary`; label-triggered
  PRs + push to prod/dev.

### Phase 1 — P0 pure helpers (~3–4 days) — **highest ROI, start here**

- ChatOverlay.tsx helper exports + tests (findTheme, hex*, menuBgColor, truncateUrl, classifyMedia,
  splitParts/splitMentions, contentMentionsName, loadSettings/saveSettings, resolveAvatar/Media,
  getOverlayShell, backoffDelay, channelTag) — **13 cheap, high-value units.**
- main.js extract `overlay-core.js` + pure helpers (stateHasRealData, isCfChallenge,
  isSinglePrintableChar, resolveAppClientKey, resolveAppVersion, canShowOverlay, clampToWorkArea).
- shell.ts/onboarding/bridge pure extracts (accelFromEvent, prettyAccel, collectChannels,
  resolveAvatarUrl, computeResizeBounds, isDragTarget, deriveInitialOnboardingState, computeNavView,
  applyRelayBase).
- **The single hardest P0:** game-presence hysteresis state machine (extract + flip-timing test).

### Phase 2 — P1 stateful + IPC + public-mode lockdown (~5–7 days)

- main.js: register/relay/discord/identity HTTP+IPC handlers (injected http + fake timers),
  reevaluateVisibility, emitVisibility, registerHotkeys/refreshShortcuts, `app:update-available` handler.
- shell.ts/main.tsx: applyScale/applyWindowVisual/persistLocal, tickIdle/markMessageActivity, navChannel,
  auth state machine reducer, /hide intercept.
- onboarding/bridge: finish() tree, ProxiedWebSocket, fetch shim, discord status/prefill/buttons.
- ChatOverlay public-mode lockdown RTL (input, WS/party, mod-actions) + computePickerAnchor — the
  **hard lockdown** rule, security-critical.

### Phase 3 — P2 component/layout + E2E (~5–8 days)

- RTL component tests (feed tag render/filter, tab bar, Avatar, BlockManagerBody, SettingsModal),
  chipField, accountBlockField, slider math, tray menu, collapse/expand, drag/resize.
- Stand up a proper Playwright `_electron` test suite (extending `overlay-launch-smoke-linux`) + a
  `dashboard-playwright` browser E2E job with a fresh relay fixture; repoint chat-smoke off prod.
  Both non-required until ~20 stable runs. (`overlay-launch-smoke-linux` — renamed from the former
  `overlay-e2e-linux` — already exists and is required for the packaged-launch smoke; the Playwright
  `_electron` test suite is the next addition to that job.)
- Flip coverage thresholds to enforced (~2 weeks after baselines settle): backend 60% lines,
  ChatOverlay-critical 50%, overlay shell/main 40%. Promote E2E jobs to required when stable.

### Sequencing rationale

Phase 1 is deliberately front-loaded with pure-helper exports because they are the cheapest tests with
the highest correctness leverage (media classification, mention parsing, settings persistence, backoff,
visibility gating) and require almost no refactor beyond `export`. The two structural refactors that
gate everything downstream — `overlay-core.js` extraction (main.js) and `install*`/export of bridge.ts
side effects — should land early in Phase 1 so Phase 2's stateful/IPC tests have clean seams to inject
into.

> **Cross-cutting risk reminders:** main.js module-load side effects are the #1 blocker (guard behind
> `init()`); bridge.ts patches global `window.fetch`/`WebSocket` (install/teardown per test or poison the
> shared jsdom env); everything timer-heavy needs disciplined `vi.useFakeTimers`; never let a test hit
> `falloutchatmod.com` — always route through the mock relay.
