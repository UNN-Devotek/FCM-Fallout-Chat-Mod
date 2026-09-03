# SPEC — In-game HUD widget customization + rendering polish (FCMChatWidget)

**Status:** Implemented — CAP-001..015 shipped (see Implementation Status below)
**Version:** 0.6
**Date:** 2026-06-26
**Issues:** #303 (config customization), #304 (keybinds) · parent #302 · parity #311
**New:** relay `createdAt` #340, timestamps #341, channel-tag naming #342, blank input #343, tab restructure #344 (CAP-012..015)
**Target:** `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx` (v2.5.3, chat.v1)

> v0.6 changelog: marked implemented. The config customization (CAP-001..011), feed polish
> (CAP-012 proper-cased tags, CAP-013 timestamps off relay `createdAt`, CAP-014 blank idle
> prompt), and tab restructure (CAP-015) shipped in `FCMChatWidget.hx` + `FcmConfig.hx`;
> config now lives in `Data/FCMChat.ini` parsed by `FcmConfig.parse()` with the Haxe test
> harness `TestFcmConfig.hx` / `test-config.hxml`. See "Implementation Status" below. Decisions
> D-01..D-12 unchanged and intact.
> v0.5 changelog: added CAP-015 (mimic overlay tab structure — outlined main tab + visible
> subtab strip, #344, Appendix A.7). Locked D-11 (FALLOUT 76 only, drop PARTY) + D-12 (no window
> icons). All decisions locked.
> v0.4: timestamps locked to relay `createdAt` (D-08, no client-time fallback); filed
> issues #340 (relay), #341 (timestamps), #342 (tags), #343 (blank input).
> v0.3: added rendering polish — CAP-012 (proper-cased channel tags), CAP-013 (timestamps),
> CAP-014 (blank idle input prompt).
> v0.2: config home locked to `FCMChat.ini` (D-01). Keybinds locked (D-05): `INSERT` =
> open/restore, `PgUp`/`PgDn` = channels, `/hide` + F11 menu = hide, mouse-wheel = scroll. Added
> CAP-011 (hide/restore). Default open key `PAGE_DOWN` -> `INSERT` (D-07).

> Scope note: #303/#231 text references the OLD `FCMBridge.hx` (FCMHUD/1, `MAX_MSGS=8`,
> hardcoded). This spec retargets that intent at the LIVE widget `FCMChatWidget.hx`
> (chat.v1, `MAX_MSGS=100`), which already externalizes `x/y/width/height/fontSize/openKey`.

---

## Why

Player cannot tune in-game chat panel to fit screen, HUD layout, readability, or keybind
preference, and cannot get it out of the way. Position/size/openKey editable today; colors,
opacity, font size detail, message retention, and channel keys are hardcoded; no hide. The
feed also reads rough: channel tags are raw lowercase slugs, there are no timestamps, and the
input row is cluttered with hint text. Goal: make every realistically safe appearance + input
property user-editable via one config file (no rebuild), add hide/restore, and clean the feed
(proper-cased tags, timestamps, blank idle prompt). Defaults = today's look + behavior except
the three feed fixes, which default on.

---

## Capabilities

CAP-001 — Player can reposition + resize the chat panel via config.
  ↳ Test: set new x/y/width/height, reload, panel moves + resizes to those values.

CAP-002 — Player can recolor every panel surface (background, border, body text, sender name, channel tag, active/inactive tab) via config.
  ↳ Test: set each color key to a distinct value, reload, each surface renders that color.

CAP-003 — Player can set panel background opacity via config.
  ↳ Test: set opacity 0.0 → fully transparent panel; 1.0 → fully opaque; reload each.

CAP-004 — Player can set message font size via config.
  ↳ Test: set two sizes, reload each, rendered glyph height differs accordingly.

CAP-005 — Player can set how many messages the feed retains via config.
  ↳ Test: set retention N, post >N messages, only newest N remain.

CAP-006 — Player can open the chat panel with the open key, and rebind it via config.
  ↳ Test: open key opens input; set a different configured key, it opens, old key no longer does.

CAP-007 — Player can cycle to next + previous channel by key, each rebindable via config.
  ↳ Test: next-key advances channel; prev-key reverses; rebinding either changes the trigger.

CAP-008 — Player can scroll back through history and jump to newest.
  ↳ Test: scroll gesture moves history up; jump control returns the feed to the latest message.

CAP-009 — Invalid, out-of-range, or missing config value falls back to its default without crashing.
  ↳ Test: feed malformed/empty/extreme values, widget loads at defaults, game does not crash.

CAP-010 — Default config (or no config file) reproduces today's exact appearance + bindings.
  ↳ Test: ship defaults, compare against current build, visual + binding parity.

CAP-011 — Player can hide the chat panel and restore it.
  ↳ Test: hide command hides the panel (not visible); the restore key brings it back visible.

CAP-012 — Each message's channel tag shows the channel's proper-cased name, matching the tab the player is in.
  ↳ Test: in each channel, the tag on visible messages reads the friendly name (e.g. "General", "Server"), not a raw lowercase slug, and matches the active tab.

CAP-013 — Each message shows a timestamp.
  ↳ Test: a posted message renders a clock time beside it; with timestamps off, no time shows.

CAP-014 — The input prompt is blank when idle; while typing it shows only the in-progress text.
  ↳ Test: with no input open, the prompt row shows no hint/help text; during typing it shows the characters being entered.

CAP-015 — The tab area mirrors the overlay: the active main tab is shown outlined (boxed), with all channel subtabs visible in a row beneath it.
  ↳ Test: the active main tab renders with a drawn outline (not bracket text); all channel subtabs show simultaneously in a strip below; active subtab is highlighted.

---

## Implementation Status

Implemented in `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx` +
`FcmConfig.hx`; config in `Data/FCMChat.ini`; pure-function tests in `TestFcmConfig.hx`
(run `haxe test-config.hxml`). Build gate: `haxe build.hxml` (exit 0).

| Item | Status |
|------|--------|
| CAP-001..011 (geometry, colors, opacity, font size, retention, keybinds, hide/restore, fallbacks, parity) | Implemented — `FcmConfig` reads/validates/clamps every key; widget renders from `_cfg`. |
| CAP-012 (proper-cased channel tags, D-09) | Implemented — `chanLabel()` slug→label map (`server`→"Server", else title-cased). |
| CAP-013 (timestamps, D-08) | Implemented — `HH:MM` from relay `createdAt` (shipped #340); `showTimestamps` default on. |
| CAP-014 (blank idle prompt, D-10) | Implemented — `showHints=false` default; in-progress typed text still echoes. |
| CAP-015 (overlay tab structure, D-11/D-12) | Implemented — single outlined `FALLOUT 76` main tab, all subtabs in a strip; no PARTY, no window icons. |
| Plan steps 1–5 (Appendix B: const→`_cfg`, `parseIni` extend, clamp in `buildPanel`, keybinds+hide/restore, mouse-wheel + feed polish) | Implemented. |
| Step 8 (tests) | Haxe pure-function harness `TestFcmConfig.hx` / `test-config.hxml` in place. |
| Step 9 (docs sync) | Done — `keybinds.md` in-game section, `ingame-chat-appearance.md` config catalog, this spec. |

VM verification (VER-1 `INSERT` open key, VER-2 mouse-wheel) remains the only in-game
confirmation step; not a code blocker.

---

## Constraints

- Colors solid only. No glow, drop-shadow, gradient, or `filters` of any kind (Scaleform VM crash).
- A HUD-layer widget gets NO raw keyboard events. Input surface is exactly: (1) the ONE native open key via ZFE `isChatKeyPressed`; (2) named FO76 control-map ACTIONS forwarded as `HUDMod::UserEvent` (e.g. `NextPage`/`PrevPage`/`Console`/`TeamChat`/`DiagnosticSnapshot`); (3) mouse events (in-game availability unverified). Channel/hide keys must be chosen from the deliverable action set OR mapped key->action in FO76 controls.
- Font FAMILY fixed to loader engine aliases; only font SIZE is user-settable.
- Send + cancel stay native Enter / Esc — not rebindable (native input session owns them).
- Config parsed once at widget load. Changes apply on reload, not live.
- Panel geometry clamped to the 1920x1080 HUD viewport with enforced minimum size — never off-screen, never zero-size.
- No raw HTML entities in rendered text (numeric refs only).
- House style: ASCII-only config + docs, no emojis.

---

## Non-goals

- Custom/embedded fonts (TTF) — engine ignores child-SWF embeds.
- Rich cosmetics: glow, gradient, animated/GIF avatars — overlay-only by SWF limits.
- Per-user name color from the wire (#231 / #300) — separate, depends on a cosmetics field.
- In-game settings UI — config is file-based only.
- Live hot-apply of config without a widget reload.
- Editing the channel list / `AllowedChannels` (ZFE fragment territory — #299, #314).
- Raising the message length cap above the server-enforced maximum.
- Binding arbitrary physical keys directly (arrows, `\`, `DELETE`) — impossible for a HUD widget without a FO76 control remap (see Constraints). Only the open key is a true free key.
- Keyboard scroll-back — Arrow Up/Down scroll the idle feed; Home/End returns to newest. Mouse-wheel + menu remain available.

---

## Success Signal

SS-1: A user changes position, size, all listed colors, opacity, font size, message retention, and the open + channel keys by editing one config file and reloading — zero rebuild.
SS-2: 100% of malformed / out-of-range / missing values load at default with no crash and no off-screen or zero-size panel.
SS-3: With default config (or none present), appearance + every binding are byte-for-behavior identical to the pre-change build.
SS-4: User can hide the panel (`/hide` or the F11 menu) and restore it (open key) in-game without reload.
SS-5: Every visible message shows a proper-cased channel tag matching the active tab and (when timestamps on) a clock time; the idle input prompt shows no hint text.

---

## Decisions

- D-01 (locked 2026-06-25): single config file = extend existing `Data/FCMChat.ini` `[FCMChat]` section. Already loaded via `loadConfig()`/`parseIni()`. No second file.
- D-02 (locked 2026-06-25): color value format accepts `#RRGGBB`, `RRGGBB`, or `0xRRGGBB`; invalid → key default.
- D-03 (locked 2026-06-25): channel-key config values use the deliverable action-name set (`NextPage`, `PrevPage`, `Console`, `TeamChat`, `DiagnosticSnapshot`); invalid → key default.
- D-04 (locked 2026-06-25): v1 layout exposes geometry + font size + retention; row-heights + leading stay fixed (advanced, deferred to v2).
- D-05 (revised 2026-09-02): keymap — `INSERT` = open AND restore-from-hidden; `Page Down`/`Page Up` (`NextPage`/`PrevPage`) = channel next/prev; Arrow Up/Down = idle feed scroll; Home/End = newest; `/hide` + F11 = hide; mouse-wheel + auto-scroll remain available.
- D-06 (revised 2026-07-16): optional `hideKey=<action>` config (default UNSET) lets power users bind a key by remapping it to a free action in FO76 controls. Hide is always available via `/hide` + the F11 menu.
- D-07 (locked 2026-06-25): default open key changes `PAGE_DOWN` → `INSERT` (`FCMChatWidget.ini` `OpenChatKey`, `FCMChat.ini` `openKey`, `_cfgOpenKey`). VM-verify ZFE accepts `INSERT` (Text Chat mod default = INSERT, so expected); `PAGE_DOWN` is the known-good fallback.
- D-08 (locked 2026-06-25): timestamps come from the relay forwarding `createdAt` in the chat.v1 `chat.message` event (data already exists, `fcm-integration.md:358`; event omits it today, `protocol-spec.md:315`). Accurate for live AND history. NO client-receipt-time fallback — the widget renders the event `ts` only. Relay change tracked as its own backend issue (paired dependency, under #289/#288). Widget timestamps land once the relay ships `createdAt`.
- D-09 (locked 2026-06-25): channel tag renders the proper-cased name via a `slug -> label` map (`CHAN_SLUGS`->Title-Case of `CHAN_NAMES`, `server`->"Server"); unknown slug -> title-cased slug.
- D-10 (locked 2026-06-25): idle input prompt blank by default (`showHints=false`); in-progress typed text still shows during a native input session (it is the only echo of what the user types).

---

## Open Questions

None blocking — all locked (D-01..D-10).

Verify on the Windows VM during implementation (not design blockers):
- VER-1: ZFE accepts `OpenChatKey=INSERT` and `isChatKeyPressed` fires for it (D-07).
- VER-2: mouse-wheel events reach the widget during normal gameplay (no free cursor). If not,
  scroll falls back to F11 "Scroll to newest" + auto-scroll only (CAP-008 still met via menu).

Cross-cutting dependency (paired issue, not in this widget's scope): the relay/backend including
`createdAt` in the chat.v1 `chat.message` event (D-08). CAP-013 (widget timestamps) lands once
that ships. VER-3 (`Date` in SWF) is dropped — no client-side time is used.

---

## Appendix A — Customization Surface Map

Every realistically customizable property, current source, default, proposed config key, clamp.
`*` = already config-driven today. `+` = new in this spec. Source = `FCMChatWidget.hx` line.

### A.1 Geometry + font (`[FCMChat]`)

| Key | Source const | Default | Range / clamp |
|-----|--------------|---------|---------------|
| `x` * | `DEFAULT_X` :140 | 10 | 0 .. (1920-width) |
| `y` * | `DEFAULT_Y` :141 | 10 | 0 .. (1080-height) |
| `width` * | `DEFAULT_W` :142 | 480 | 200 .. 1920 |
| `height` * | `DEFAULT_H` :143 | 306 | 120 .. 1080 |
| `fontSize` * | `DEFAULT_FONT_SIZE` :144 | 14 | 8 .. 47 (GFx glyph cache <48) |
| `leading` + | `_fmt.leading` :381 | 3 | 0 .. 12 (deferred, OQ-3) |
| `rowHeightMain` + | `TAB_H` :146 | 22 | 14 .. 40 (deferred, OQ-3) |
| `rowHeightTabs` + | `SUB_H` :147 | 20 | 14 .. 40 (deferred, OQ-3) |
| `rowHeightInput` + | `INPUT_H` :145 | 28 | 18 .. 48 (deferred, OQ-3) |

> DRIFT BUG: shipped `FCMChat.ini` has `height=330`; `DEFAULT_H=306`. Reconcile to one
> source of truth as part of CAP-010.

### A.2 Colors + opacity (`[FCMChat]`) — all solid

| Key | Source const | Default | Drives |
|-----|--------------|---------|--------|
| `bgColor` + | `BG_COLOR` :150 | `#0A0907` | panel fill |
| `bgAlpha` + | `BG_ALPHA` :161 | 0.94 | panel opacity (CAP-003) |
| `borderColor` + | `PRIMARY` :152 | `#F5CB5B` | panel border + separators |
| `textColor` + | `TEXT_HEX` :157 | `#FAF4DA` | message body |
| `senderColor` + | per-rec col / `PRIMARY_HEX` :153 | `#F5CB5B` | sender name default |
| `channelTagColor` + | `CHANNEL_HEX` :160 | `#8FBC8F` | `[channel]` tag |
| `tabActiveColor` + | `PRIMARY_HEX` :153 | `#F5CB5B` | active tab + active-tab accent |
| `tabInactiveColor` + | `INACTIVE_HEX` :158 | `#B49544` | inactive tab text |
| `promptColor` + | `DIM_HEX` :159 | `#AC9043` | idle prompt hint |
| `tabRowColor` + | inline `0x080705` :337,341 | `#080705` | tab-row backgrounds |

Recommended v1 color subset (rest deferred): `bgColor`, `bgAlpha`, `borderColor`,
`textColor`, `senderColor`, `channelTagColor`, `tabActiveColor`, `tabInactiveColor`.
Note: `tabActiveColor` + `borderColor` + `senderColor` all = `PRIMARY` today; splitting
them = independent keys (more usage sites to thread).
`CHROME_COLOR` :151 is defined but unused (tab rows use inline `0x080705`) — fold into `tabRowColor`.

### A.3 Limits (`[FCMChat]`)

| Key | Source const | Default | Range / clamp |
|-----|--------------|---------|---------------|
| `maxMessages` + | `MAX_MSGS` :128 | 100 | 10 .. 500 |
| `maxSendLen` + | `MAX_SEND_LEN` :129 | 225 | 1 .. server max (never above; Non-goal) |

### A.4 Keybinds (`[FCMChat]`)

| Key | Behavior | Physical key | Source | Default |
|-----|----------|-------------|--------|---------|
| `openKey` * | open input; **restore if hidden** | `INSERT` (native ZFE key) | `_cfgOpenKey` :175, `onUserEvent` :560, `pollOpenKey` :1304 | `INSERT` (D-07) |
| `channelNextKey` + | next channel | `Page Down` | `NextPage`→`cycleChannel` :569 | `NextPage` |
| `channelPrevKey` + | prev channel (NEW `cyclePrev`) | `Page Up` | none yet (cycle forward-only :652) | `PrevPage` |
| `hideKey` + | hide panel (optional) | user-mapped action | none yet | UNSET (use `/hide` + F11 menu) |

**Deliverable action set** (the only values `channelNextKey`/`channelPrevKey`/`hideKey` accept):
`NextPage` (Page Down), `PrevPage` (Page Up), `Console` (`~`, dead-safe), `TeamChat` (`T`,
overrides team chat), `DiagnosticSnapshot` (F12). Everything else
is gameplay-critical and not bindable. For any other physical key, the user maps key→action in
FO76 controls, then sets the matching action here.

- **Scroll:** Arrow Up/Down actions and mouse-wheel move through feed history; Home/End and F11
  "Scroll to newest" return to the latest message. `Page Up` remains `channelPrevKey`.
- **Hide / restore:** `/hide` (slash command) or F11 "Hide chat" hides (`this.visible=false`,
  timers + listeners keep running so the feed stays current). `openKey` (`INSERT`) restores +
  opens — guaranteed, it is the one natively-polled key.
- **Two open-key bindings must agree:** `FCMChatWidget.ini` `OpenChatKey` + `zfe.ini [TextChat]`
  override (authoritative for native `isChatKeyPressed`) AND `FCMChat.ini` `openKey` (the
  `HUDMod::UserEvent` path). Both default `INSERT`.

### A.5 Commands (input text) — extends existing `/g /t /e /i /r`

| Command | Action | Source |
|---------|--------|--------|
| `/g /t /e /i /r` * | switch channel (General/Trade/Events/Infests/Raids) | `switchChannelBySlash` :661 |
| `/hide` + | hide the panel (restore with `INSERT`) | `handleSubmittedText` :984 (NEW branch) |

### A.6 Rendering / feed polish (`[FCMChat]`)

| Key | Behavior | Default | Source / touchpoint |
|-----|----------|---------|---------------------|
| `showChannelTag` + | show the `[Channel]` tag | true | `renderRecords` tag span :1560 |
| (no key) | tag is proper-cased via `slug->label` (D-09) | always | `renderRecords` :1560 (NEW `chanLabel()`) |
| `showTimestamps` + | show a clock time per message | true | `renderRecords` :1558 (NEW), record `ts` |
| `timestampColor` + | timestamp text color | `#AC9043` (dim) | `renderRecords` :1558 |
| `showHints` + | show idle prompt hint text | **false** (blank idle) | `idlePrompt` :431 / `setPrompt` :446 |

- **Record refactor (enables CAP-013 + clean #231):** today `_records:Array<String>` packs
  `"#color~channel~user~body"` (`body = f.slice(3).join("~")`, so no field can follow body). To
  carry a timestamp (and later a name color), change `_records` to typed objects
  `{color, channel, user, body, ts}` and update the 3 push/parse sites (`parseAndRenderEvents`
  :1422, optimistic echo :1050, `renderRecords` split :1550). Removes the `~`-delimiter fragility.
- **Timestamp source (D-08):** prefer `ts` from the event (relay must forward `createdAt`);
  interim = stamp on receipt in `parseAndRenderEvents`. History (`cursor:0`) is only accurate
  with the relay change. Format `HH:MM` (24h) v1.
- **Tag = active channel:** the feed already filters to active slug + `server` (:1419), so tags
  inherently match the tab; this only fixes the label casing/name (CAP-012).

### A.7 Tab structure — mimic the overlay (CAP-015, issue #344)

Reference: overlay screenshot — active main tab `FALLOUT 76` drawn with a thin OUTLINE box,
inactive `PARTY` dimmed; all channel subtabs visible in a strip beneath; window-control icons
(status dot / refresh / gear / minimize / close) at the right.

| Element | Today (`FCMChatWidget.hx`) | Target |
|---------|----------------------------|--------|
| Main tab | `renderMainTabs` :411 prints `[ FALLOUT 76 ]  PARTY` as bracket text | `FALLOUT 76` ONLY, drawn with a rectangle OUTLINE (replace `[ ]`); no `PARTY` (D-11) |
| Subtabs | HUDButtons (`buildChannelTabs` :590) or text strip (`renderSubTabs` :418) | keep all-visible strip, restyle to match the overlay |
| Window icons | none | none — omitted (D-12) |

- **Outline box (crash-safe):** draw via `_bg.graphics.lineStyle(...).drawRect(...)` (the panel
  border already uses this :344-350) around the `FALLOUT 76` label; size from `TextField.textWidth`
  or a fixed cell. NO filters.
- **Rip + replace** the bracket-text main tab + the current subtab build in `buildPanel` :322 /
  `renderMainTabs` :411. Single main tab (`FALLOUT 76`) drawn outlined as the header; redraw on
  nothing (it is the only main tab) — active state lives on the subtab row.
- Uses the configurable colors (A.2: `borderColor`/`tabActiveColor`/`tabInactiveColor`).
- **D-11 (locked 2026-06-25):** `FALLOUT 76` is the only main tab. `PARTY` dropped — parties are
  an overlay/auth feature with no in-game surface.
- **D-12 (locked 2026-06-25):** no window-control icons (refresh/gear/min/close). No window
  in-game: hide = `/hide`, settings = config file.

---

## Appendix B — Implementation plan (FCMChatWidget.hx)

Order minimizes risk; each step independently testable.

1. **Constants → instance config fields.** Convert `static inline var` color/layout/limit
   constants (A.1–A.3) to `_cfg*` instance vars seeded to current defaults (mirror existing
   `_cfgX` pattern :169-175). Derive `#`/no-`#` hex variants once from each `_cfg*Color`
   (no-`#` forms feed `setColors`/`FormatTextEdit` :609,936). Update all usage sites:
   `buildPanel` :322, `makeChromeTf` :395, `renderMainTabs` :411, `renderSubTabs` :418,
   prompts :431-439, `setLogText` :441, `buildChannelTabs` :590, `openInputSharedHudTools`
   :909, `renderRecords` :1533. Bulk but mechanical.

2. **Extend `parseIni`** :283 switch with new keys. Add pure helpers:
   `parseHexColor(s) -> Int` (accept `#RRGGBB`/`RRGGBB`/`0xRRGGBB`, regex-validated, else
   sentinel), `parseFloat01`, `clampInt(v,lo,hi)`. Keys lowercased (parser already lowercases).

3. **Apply + clamp in `buildPanel`.** Use `_cfg*` for `Shape` fills/alpha/line, row heights,
   `_fmt`. Clamp geometry to viewport with min size BEFORE draw (CAP-009, Constraint).

4. **Keybinds + hide/restore.** Read `channelNextKey`/`channelPrevKey`/`hideKey` (validate vs
   deliverable action set, else default). Add `cyclePrev()` (reverse of `cycleChannel` :652).
   Rewrite `onUserEvent` :553 to dispatch by matching the event action against each configured
   action (not hardcoded `NextPage`/`PrevPage` literals); `PrevPage` no longer scroll-binds
   (now channel-prev). Add hide state:
   - `_hidden:Bool`; `hide()` sets `this.visible=false`; `show()` sets `true`. Timers/listeners
     keep running while hidden (feed stays current).
   - `/hide` branch in `handleSubmittedText` :984 (consume, do not send).
   - F11 "Hide chat" entry in `onBuildMenu` :519 / `onSelectMenu` :538.
   - `openInput()` :783 + `onUserEvent`/`pollOpenKey` open path: if `_hidden`, `show()` first,
     then open — so `INSERT` restores. Optional `hideKey` action also toggles hide.

5. **Mouse-wheel scroll (VER-2).** Add `MouseEvent.MOUSE_WHEEL` listener on the panel/`_logTf`
   (flip `_logTf.mouseEnabled` :375) → `scrollUp`/`scrollDown`. Guard: if wheel never fires
   in-game, scroll stays on F11 + auto (CAP-008 still met). HUDButton already proves
   `MouseEvent.CLICK` is wired (:613) — wheel is the unknown.

   **Feed polish (CAP-012..014) — group with the above:**
   - 5a. **Channel tag (CAP-012, D-09).** Add `chanLabel(slug)` (Title-Case `CHAN_NAMES` /
     `server`->"Server" / fallback title-cased slug). Use it in the `renderRecords` tag span
     :1560; gate render on `showChannelTag`.
   - 5b. **Record refactor + timestamps (CAP-013, D-08).** Change `_records` to typed objects
     (A.6); read event `createdAt` in `parseAndRenderEvents` :1422 (paired relay issue must ship
     it); render `HH:MM` in `renderRecords` :1558 when `showTimestamps`. Update echo push :1050
     (use the send time for the optimistic echo). No client-receipt-time fallback (D-08).
   - 5c. **Blank idle prompt (CAP-014, D-10).** `idlePrompt()` :431 returns "" unless
     `showHints`; keep `typingPrompt`/in-progress echo :854 during native input. SharedHUDTools
     path prompt stays blank (its own box shows text).

6. **Validation pass.** Every `_cfg*` clamped/defaulted at parse or apply. Fuzz fixtures for
   CAP-009 (empty file, missing keys, bad hex, alpha 9, width -5, fontSize 999, bad action name).

7. **Version + build + defaults.** Bump `VERSION` :103 `2.5.3 -> 2.6.0`; `BUILD=...` :1133.
   Change defaults to `INSERT`: `_cfgOpenKey` :175, `FCMChat.ini openKey`, `FCMChatWidget.ini
   OpenChatKey` (D-07). Reconcile `DEFAULT_H` / `FCMChat.ini height` drift. Rebuild SWF
   (`haxe build.hxml`) + repack `.ba2` per `BUILD.md`.

8. **Tests (HARD RULE).** No Haxe test harness exists today (CI `gamemod-anchors` runs only
   Python `game-mods/FCMBridge/hudmenu-chat/test_anchors.py`). Plan:
   - Primary: extract `parseHexColor`/`clampInt`/`parseFloat01`/`parseIni`-core + the
     action-name validator as pure static fns; add a Haxe `--interp` assert script
     (`game-mods/FCMBridge/hudmodloader-chat/test_config.hxml`) covering A.1–A.4 parse + clamp
     + fallback (CAP-009) + slash-command parse (`/hide`, `/g`) + `chanLabel()` mapping (CAP-012)
     + `HH:MM` timestamp format (CAP-013). Wire a CI step that installs Haxe + runs it (new —
     `gamemod-anchors` is Python-only).
   - Cheap guard: Python test asserting shipped `FCMChat.ini` keys ⊆ documented keys + defaults
     in range + `openKey`/`OpenChatKey` agree (catches the height drift + open-key-mismatch
     classes), runnable inside existing `gamemod-anchors`.
   - Promote to `CI Summary` gate once stable.

9. **Docs sync (HARD RULE).** Update `hudmodloader-chat/README.md` (Position/Files +
   new Customization + Keybinds + `/hide` + feed-polish sections), `FCMChat.ini` (commented key
   catalog + defaults + `INSERT` + `showTimestamps`/`showChannelTag`/`showHints`),
   `FCMChatWidget.ini` (`OpenChatKey=INSERT`),
   `docs/overlay/zfe/ingame-chat-appearance.md`, `docs/overlay/zfe/api-reference.md`,
   `docs/overlay/keybinds.md` (cross-link in-game binds + the deliverable-action set + `/hide`).
   Update issues #303/#304/#311 on close.

---

## Appendix C — Risks

- **Usage-site sprawl (step 1):** color constants threaded through ~10 render fns; a missed site
  = mixed default/custom color. Mitigate: grep each constant, convert all, CAP-010 parity check.
- **`INSERT` open key (VER-1):** changing default `PAGE_DOWN`->`INSERT` (D-07) assumes ZFE
  accepts `INSERT` (Text Chat mod default = INSERT, so expected). VM-verify; `PAGE_DOWN` is the
  fallback if not.
- **Mouse-wheel in gameplay (VER-2):** no free cursor in normal play — wheel may not reach the
  widget. Fallback = F11 "Scroll to newest" + auto-scroll (CAP-008 still met). VM-verify.
- **F11 menu:** HUDModLoader owns the F11 menu; do not depend on `DiagnosticSnapshot`/F12 to open it.
- **Native vs HUDMod open-key duality:** `openKey` (HUDMod path) must stay in sync with
  `OpenChatKey` (ZFE `isChatKeyPressed` path) — both `INSERT`. A `gamemod-anchors` test asserts agreement.
- **Proton/Wine:** widget send is blocked under Wine (#326); customization is render/parse only,
  testable on Linux for appearance, but full send-path QA needs the native Windows rig (`msi`).
- **No live reload:** config applies on widget reload (F11 `isReloadable`) — set expectation in docs.
- **Timestamp dependency (D-08):** CAP-013 (widget timestamps) is BLOCKED on the paired relay
  `createdAt` issue. Sequence: ship the relay change first (or together), else the widget has no
  time to render. No client-side fallback by decision.
- **Record refactor blast radius:** changing `_records` string->object touches 3 push/parse
  sites + render; a missed site = dropped/garbled messages. CAP-010 parity + the Haxe test guard it.

---

## Spec Quality Gate — HUD widget customization

Before: 8/8 passing

Findings: none. Kernel sections (Why / Capabilities / Constraints / Non-goals / Success Signal)
are technology-agnostic; all tech/key detail isolated to Decisions + Appendices A–C. 0 NEEDS
CLARIFICATION markers (all locked D-01..D-12). Every CAP (001–015) has an implementation-free
Test line. SS-1..5 measurable + agnostic. Non-goals + hard-limit constraints present.

After: 8/8 passing

Status: PASS — all decisions locked, ready for planning. CAP-013 sequenced behind the paired
relay `createdAt` issue (#340). VER-1/VER-2 confirmed during build on the Windows VM.
