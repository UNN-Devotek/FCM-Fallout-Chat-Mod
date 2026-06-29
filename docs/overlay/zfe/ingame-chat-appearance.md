# In-Game Chat Appearance — Current State, Gaps, and Improvement Roadmap

Review of the FCMBridge HUD panel against the `ChatOverlay.tsx` reference design.
Sources: `game-mods/FCMBridge/FCMBridge.hx` (all lines), `admin-dashboard/src/features/chat/ChatOverlay.tsx`
(lines 56–145 theme block; 5711–7150 render path), `docs/overlay/zfe/scaleform-ui-guide.md`.

> **Live widget config (`FCMChatWidget`, chat.v1).** The roadmap below was written against the
> older `FCMBridge.hx` (FCMHUD/1, hardcoded constants). The shipping in-game chat is the
> HUDModLoader widget `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx`, whose appearance
> is now **fully user-editable** without a rebuild via `Data/FCMChat.ini` (`[FCMChat]` section,
> parsed + clamped by `FcmConfig.parse()`). The full key catalog — **colors**
> (`bgColor`, `borderColor`, `textColor`, `senderColor`, `channelTagColor`, `tabActiveColor`,
> `tabInactiveColor`, `promptColor`, `tabRowColor`, `timestampColor`), **opacity** (`bgAlpha`),
> **geometry** (`x`, `y`, `width`, `height`, `fontSize`), **limits** (`maxMessages`,
> `maxSendLen`, `pollMs`), **toggles** (`showChannelTag`, `showTimestamps`, `showHints`), and **keybinds**
> (`openKey`, `channelNextKey`, `channelPrevKey`, `hideKey`) — lives in the commented
> `Data/FCMChat.ini` (every value validated/clamped, invalid falls back to default).
> Keybinds: [../keybinds.md](../keybinds.md) (in-game HUD section). Two feed-polish defaults
> that differ from the table below: each message now carries an `HH:MM` **timestamp** (sourced
> from the relay's `createdAt`, `showTimestamps` on by default) and the channel tag renders the
> channel's **proper-cased name** (e.g. `[General]`, `[Server]`) instead of a raw lowercase slug.
>
> **Per-channel colors — `[Channel]` message tags only (v2.6.3, scoped to tags in v2.6.5).**
> Each `[Channel]` **message tag** renders in that channel's **own color**, mirroring the
> website's `chat_rooms.color` (pulled from PROD 2026-06-28): General `#1ABAFF`, Trading
> `#008F37`, Events `#C88A51`, Infests `#5ABD0A`, Raids `#CE0909`, Server `#ECBB51`. Override
> per channel in `FCMChat.ini` (`colorGeneral` / `colorTrading` / `colorEvents` /
> `colorInfests` / `colorRaids` / `colorServer`), read via `FcmConfig.channelColor(slug)`.
> **The sub-tab ROW does NOT use per-channel colors** — it uses the **header text colors**
> (active = `tabActiveColor`, inactive = `tabInactiveColor`, matching the "FALLOUT 76" main
> tab). (v2.6.4 briefly colored the sub-tab row per-channel; **reverted in v2.6.5** by request.)
> This is the static mirror (**Option B**); **Option A** — the relay feeding live
> `chat_rooms.color` over chat.v1 so tags auto-track dashboard edits — is planned for later
> (`channelColor()` is the override point). Also: the sub-tab first-letter brackets
> (`[G]ENERAL` → `GENERAL`) and the dim divider line under the active main tab were removed.
>
> **Poll cadence / game-lag knob (v2.6.4).** The event-poll interval is now configurable via
> `pollMs` (default **5000**ms, was a hard-coded 2000ms; clamped 1000..60000). Each poll opens
> a **fresh wss connection** = a full TLS handshake (~120ms under Wine/Proton), so at 2s it
> stuttered the game. Raising `pollMs` trades message-refresh speed for smoothness; lowering it
> is snappier but laggier. The real fix is ZFE **reusing its persistent connection** for polls
> instead of a new handshake per call (flagged to the ZFE author).
>
> **Onboarding + tab chrome (v2.6.6).**
> - **Unlinked = link screen only.** On first load (or any time the identity is not linked),
>   the widget shows ONLY the link prompt — it no longer renders chat history to an unlinked
>   user (`renderRecords` returns the link screen when `_authState != "authenticated"`).
> - **Configurable link URL.** `FcmConfig.linkUrl` (FCMChat.ini `linkUrl`, URL-safe charset,
>   default `falloutchatmod.com/link`) sets the link-prompt URL; **dev builds use
>   `dev.falloutchatmod.com/link`**. (The relay's link-code notice is already env-correct; this
>   is the pre-notice fallback text.)
> - **Single yellow main→sub separator.** The two tab-row background fills were merged into one
>   (no more dim alpha seam between the main tab and the sub-tabs); the only line on that
>   boundary is a yellow (`tabActiveColor`) separator at `y=TAB_H`, cut out under the active tab
>   so the tab outline + separator form one continuous line that wraps the active "FALLOUT 76" tab.
>
> **Link prompt + send errors (v2.6.7).**
> - **Numbered link prompt (Flow A).** When unlinked, the widget shows numbered steps —
>   `1) Open <linkUrl> in a web browser  2) Sign in with Discord or Nexus  3) Enter this code: <CODE>`
>   — with the code pulled from the relay's pinned notice (`extractLinkCode`) and shown bold/larger.
>   (The code is shown IN-GAME; you enter it on the web `/link` page. Signing into `/link` only
>   logs into your FCM account — the identity isn't linked until the code is redeemed.)
> - **Send errors no longer mislabel.** The relay now returns `message_blocked` (automod) and
>   `slash_ignored` (a `/command` typed in-game) instead of collapsing them into `permission_denied`
>   — so a filtered/slash message from a LINKED user no longer wrongly says "link your account."
>   The widget shows "Message blocked by the chat filter." / "Slash commands work in the dashboard,
>   not in-game." `permission_denied` now means genuinely not-linked only.
> - **Smaller default size:** `width`/`height` defaults are now `400 x 260` (were `480 x 306`).

---

## 1. Current State Inventory

All numeric measurements are from `FCMBridge.hx` constants (lines 52–58) unless noted.

| Element | In-Game Today (FCMBridge.hx) | Dashboard Reference (ChatOverlay.tsx fo76-wasteland) | Gap |
|---|---|---|---|
| **Panel dimensions** | 360 × 248 px (`PANEL_W`/`PANEL_H`) | Fluid/resizable | Fixed size; no user resize |
| **Panel position** | x=5, y=5 (hard-coded, `buildPanel` line 241) | Draggable / persisted | Never user-repositionable |
| **Background** | `#0A0907` at alpha 0.72 (`BG_COLOR`, line 141) | `#0A0907` at alpha 0.941 | Significantly more transparent in-game; can feel washed out over bright scenes |
| **Chrome strip (tab row)** | `#0C0A08` at alpha 0.92 (line 146) | `#0C0A08` at alpha 0.980 | Slightly lighter in-game; close |
| **Chrome/feed divider** | 1px `#F5CB5B` at alpha 0.45 (line 151) | 1px `primaryColor` border | Match |
| **Input bar divider** | 1px `#F5CB5B` at alpha 0.25 (line 153) | Visual separation present | Match in intent |
| **Primary color (gold)** | `#F5CB5B` (`PRIMARY`, line 76) | `#F5CB5B` | Exact match |
| **Text color** | `#FAF4DA` (`TEXT_HEX`, line 78) | `#FAF4DA` | Exact match |
| **Inactive tab color** | `#B49544` (`INACTIVE_HEX`, line 79) | `secondaryColor` `#C9A84E` → dimmed | Close; in-game is slightly darker/dimmer |
| **Active main tab style** | 3-sided `#F5CB5B` bracket (top+left+right), open bottom, no fill | 3-sided bordered outline, transparent fill, primary-color text (lines 5749–5752) | Match in concept; dashboard has pixel-precise measured cutout in divider, in-game uses `tabRight` measured value — functionally equivalent |
| **Active main tab gradient fill** | Not present (outline only) | `activeTabGradientTop: #F5CB5B` → `#6A4808` (`filledActiveTab: true`) | Gap: dashboard reference has a gradient fill on the active tab; in-game has none |
| **PARTY tab** | Plain text `#B49544` dim, no fill (line 190) | Equivalent inactive styling | Match |
| **Sub-tab row** | 5 tabs: GENERAL TRADING EVENTS INFESTS RAIDS; active = `#F5CB5B`, inactive = `#B49544`, size 13 (lines 258–265) | Same tab names + active/inactive color pattern | Match |
| **Sub-tab active highlight style** | Color only — no underline, background, or fill | Color only | Match |
| **Font** | `$$MAIN_Font` (game-embedded, lines 164, 190, 263, 709) | `Segoe UI, system-ui, sans-serif` | Different typeface; `$$MAIN_Font` is the Pip-Boy serif font in-game which is arguably more thematic |
| **Font size (body)** | 14px (`FONT_SIZE`, line 58) | `fontSize: 14` default | Match |
| **Font size (sub-tabs)** | 13px (line 263) | `fontSize - 1` = 13 | Match |
| **Leading / line spacing** | `leading = 4` (TextFormat, line 217); single `<br/>` separates messages | `lineHeight` CSS (1.3–1.4 effective) | In-game leading is explicit 4px; dashboard uses CSS leading — visual result is close but in-game is tighter |
| **Message format** | `[channel] username: content` with 3 `<font>` spans (lines 706–710) | `[tag] username: content` (lines 7097–7144) | Near-identical structure |
| **Channel tag color** | Per-record color field from backend (`col`, line 701) | `tagColor` per channel (lines 7097–7099) | Match — backend sends same color token |
| **Username color** | Always `#F5CB5B` primary (line 709) | Always `primaryText` = `#F5CB5B` (line 7131); no per-user randomisation active in fo76-wasteland | Match |
| **Message body color** | `#FAF4DA` (line 710) | `contentColor` = `textRgba` ≈ `#FAF4DA` | Match |
| **Timestamps** | Not rendered | Not shown in fo76-wasteland (timestamp field exists, not displayed by default) | Match (both omit them) |
| **Unread badge** | Not present | `UnreadBadge` pill per tab (lines 5544–5558) | Gap |
| **Mention highlight** | Not present | `borderLeft: 2px solid primaryColor` + faint background (line 7083) | Gap |
| **Scroll indicator** | `_tf.scrollV = _tf.maxScrollV` auto-scrolls (line 716) | `messagesEndRef` scroll-to-bottom | Both auto-scroll; no manual scroll or back-scroll indicator in-game |
| **Hover states** | No mouse interaction (`mouseEnabled = false`) | Hover tint on messages + tag hover | Gap (partially by design — HUD is read-only) |
| **Input bar** | Visible box `#0C0A08` bg + `#F5CB5B` border, 22px tall, full-width (lines 224–239); placeholder text invisible (rendered in bg color) | Styled input with caret, placeholder text, emoji/GIF buttons | Gap: in-game bar is a visual stub; real input is the game's native chat entry (patched HUDMenu) |
| **Ring size** | 8 messages (`MAX_MSGS`, line 59) | No fixed ring in React (retains session history) | In-game shows 8 lines max |
| **Channel filtering** | Server-driven via `ACTIVECHAN` control line (lines 543–554) | Client tab switching + server fetch | Functional match for the read path |

---

## 2. Feasible Improvements

Ranked by impact-to-effort ratio. All must stay within the `FCMBridge.hx` crash hard-rules (lines 38–44)
and the full list in `scaleform-ui-guide.md` section 11.

### A. Gradient fill on the active main tab — HIGH impact, MEDIUM effort

**Confidence: HIGH** — `graphics.beginGradientFill` is the drawing-API gradient path, not the banned
filter/CSS path. GFx supports `GradientType.LINEAR` with `beginGradientFill` (the Scaleform
rendering engine handles vector drawing-API fills natively). This is distinct from `GlowFilter` /
`DropShadow` (which are **filter objects** attached to display objects — those crash). The guide's ban
on "gradient masks" refers to `BlendMode.SHADER` gradient masks, not drawing-API fills.

Implementation: in `buildPanel()`, after drawing the chrome strip, add a second `Shape` drawn only
under the active-tab bracket region. Use `graphics.beginGradientFill(GradientType.LINEAR,
[0xF5CB5B, 0x6A4808], [0.6, 0.9], [0, 255], matrix)` where `matrix` is a vertical gradient Matrix.
Clip to the measured `tabRight` width. This matches `activeTabGradientTop: #F5CB5B` →
`activeTabGradientBottom: #6A4808` from ChatOverlay.tsx line 71.

> Caveat: if the game's Scaleform build predates GFx 4.0, `beginGradientFill` may silently no-op
> (it would not crash). Validate in-game; the bracket outline remains if the fill does not render.

---

### B. Per-user deterministic username color — HIGH impact, LOW effort

The dashboard renders all usernames as flat `primaryColor`. FCMBridge already does the same. However,
the backend's wire format includes a `color` field per record (line 701, `f[0]`), currently used for
the channel tag. The server could additionally encode a second color for the username (e.g. a 6th
tilde field, or reuse the existing color for the username span instead of the tag).

A simpler in-bridge alternative that requires NO backend change: derive a color from the username
string in Haxe. A simple djb2 hash mod over a small palette of warm amber variants (`#F5CB5B`,
`#E8A83A`, `#D4923F`, `#C9A84E`, `#B8853C`) assigns a consistent but distinct color per sender.
This mirrors the intent behind ChatOverlay's `enableRandomNameColors` concept referenced in the
code comments.

File/function to touch: `renderRecords()` (line 695). Replace the hard-coded `PRIMARY_HEX` on line
709 with a `hashUserColor(user)` helper that returns one of 5 palette entries.

---

### C. Switch to `TextFieldEx.appendHtml` for the message feed — MEDIUM impact, LOW effort

`scaleform-ui-guide.md` section 4 documents that `tf.htmlText = fullHtml` **reparses the entire
document** on every message, while `TextFieldEx.appendHtml(tf, line)` is incremental. Currently
`renderRecords` rebuilds the full `htmlText` string on every update (line 713). With `appendHtml`:
maintain the ring array for eviction, call `tf.htmlText = ""` only when a message falls off the
ring, then `appendHtml` each remaining entry. On new messages just `appendHtml` the new line.

This reduces parse cost for a full-ring update from O(N messages) to O(1) appends.

**Prerequisite:** `Extensions.enabled = true` must be called once before the first `appendHtml`
call (guide section 7). Add it to `buildPanel()` or `onStage()`.

File/function to touch: `buildPanel()` (add `Extensions.enabled = true`) and `renderRecords()`
(lines 695–717) to switch to the append pattern.

---

### D. Configurable panel position via `Data/FCMBridge.ini` — HIGH impact, MEDIUM effort

`scaleform-ui-guide.md` section 9 documents the per-widget INI convention: a `Data/<Widget>.ini`
file read via `URLLoader("../X.ini")`. Since `URLLoader` is blocked in GFx (guide section 2), use
ZFE's `readRemoteData` with a dedicated config key (e.g. `vendor=FCMBridge`, `key=hud-position`)
or use the ZFE `readLocalFile` if available. Alternatively expose position as a backend-served
config blob fetched at startup.

The simplest approach without any new infrastructure: add two `static inline var` constants
`PANEL_X:Int = 5` and `PANEL_Y:Int = 5` (replacing the literals on line 241), and document that
advanced users can recompile with custom values. Long-term: ZFE storage key for position (see
[ZFE Storage API](api-reference.md#storage)).

File/function to touch: `buildPanel()` line 241.

---

### E. `setAutoSize` / `setVerticalAlign` on the sub-tab TextField — LOW impact, LOW effort

`TextFieldEx.setVerticalAlign(tf, "center")` vertically centers sub-tab text within the 22px
`SUB_H` row, preventing single-pixel drift if the font metrics shift across game versions. Similarly
`TextFieldEx.setTextAutoSize(tf, "shrink")` prevents sub-tab labels clipping if the player uses a
non-default system DPI. Both are guide section 7 items that require `Extensions.enabled = true`.

File/function to touch: `buildPanel()` after `addChild(_subTf)` (line 199) and after `addChild(_tf)`
(line 221).

---

## 3. Banned / Impossible List

Do not re-attempt these. Each has either crashed the game in production or is documented as
unsupported by the GFx runtime.

| Feature | Why banned | Source |
|---|---|---|
| `GlowFilter`, `DropShadowFilter`, `BlurFilter` on any MovieClip/Sprite | Crash/blank in production | `FCMBridge.hx` line 41; `scaleform-ui-guide.md` §2 |
| CSS-style text shadows via `StyleSheet` | `StyleSheet` disables `appendHtml`; no CSS text-shadow in AS3 | Guide §3 |
| Web fonts / custom embedded fonts (beyond `$$MAIN_Font`) | Require font embed with `embedAsCFF=false` + narrow unicode range; adds SWF size and glyph cache pressure; mixing with `$$MAIN_Font` in the same field causes blank text | Guide §3 |
| Animated GIFs / sprite-sheet animations inside the feed | GFx does not decode GIF streams; `BitmapData` can hold a static frame at best; no timer-driven GIF player exists in the AS3 stdlib | Guide §2 |
| `URLLoader` / `Socket` / `XMLSocket` for direct network calls | Disabled; all network I/O must go through ZFE / `__SFCodeObj` bridge | Guide §2 |
| `fl.motion.*` (AnimatorFactory3D etc.) | Flash-only classes; `ReferenceError` in GFx | Guide §2 |
| `BitmapData.paletteMap`, `beginShaderFill`, `drawTriangles` | Not implemented in GFx | Guide §2 |
| Mouse hover states on the feed panel | `mouseEnabled = false` on `_tf` (line 211) is intentional — enabling mouse on a HUD layer clip interferes with game input routing; reliable hover-hit-test on a HUD layer is undocumented and risky | Guide §5 |
| `scrollV = maxScrollV` as reliable scroll-to-bottom | Text Chat source documents this as a known no-op bug; use `tf.setSelection(tf.length, tf.length)` instead | Guide §4 |
| HTML entities (`&amp;` `&lt;` etc.) in `htmlText` | Crash in Scaleform — the XML parser chokes | `FCMBridge.hx` line 42; Guide §3 |
| Inline emoji as Unicode codepoints rendered via `$$MAIN_Font` | `$$MAIN_Font` does not include emoji glyphs — renders as missing glyph boxes | Guide §3 |

---

## 4. Recommendation Shortlist

Top 5 concrete changes ranked by value, each with the exact file and function to touch.

| # | Change | File | Function / Lines |
|---|---|---|---|
| 1 | **Gradient fill on active main tab** — close the most visible gap between in-game and dashboard reference; gold→dark amber fill under the bracket | `game-mods/FCMBridge/FCMBridge.hx` | `buildPanel()` — after the bracket drawing block ending line 183; add a new `Shape` with `beginGradientFill` |
| 2 | **Switch feed to `TextFieldEx.appendHtml`** + add `Extensions.enabled = true` — reduces per-message reparse cost from full rebuild to O(1) append; prerequisite for item 5 | `game-mods/FCMBridge/FCMBridge.hx` | `buildPanel()` (add `Extensions.enabled = true`); `renderRecords()` lines 695–717 |
| 3 | **Per-user deterministic username color** — 5-entry warm amber palette hashed from username string; zero backend changes required | `game-mods/FCMBridge/FCMBridge.hx` | `renderRecords()` line 709; add `hashUserColor(user:String):String` static helper |
| 4 | **Configurable panel position** — expose `PANEL_X`/`PANEL_Y` as named constants (immediate) or ZFE storage key (follow-up); prevents the hardcoded x=5/y=5 blocking user HUD layouts | `game-mods/FCMBridge/FCMBridge.hx` | Constants block lines 52–59 (add `PANEL_X`/`PANEL_Y`); `buildPanel()` line 241 |
| 5 | **`TextFieldEx.setVerticalAlign` on sub-tab and body TextFields** — centers sub-tab labels in the 22px row; prevents single-pixel drift; requires `Extensions.enabled` from item 2 | `game-mods/FCMBridge/FCMBridge.hx` | `buildPanel()` after `addChild(_subTf)` line 199 and after `addChild(_tf)` line 221 |
