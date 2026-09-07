# FCM In-Game Chat — Channel, Identity & Input-Box Fixes (Plan)

**Status:** PLANNED — 2026-06-11 (see status update below)
**Context:** Two-way in-game chat (non-HUDModLoader / RABCDAsm HUDMenu patch + FCMBridge feed widget)
is now functional: send round-trips (`SEND … ok=true`) and the feed renders. Four issues remain,
surfaced during live testing. This plan captures the root causes (from logs + DB) and splits the
work into parallelizable workstreams for sub-agents.

> **Status update — 2026-06-26 (chat.v1 path).** Work since moved to the ZFE **`chat.v1`** widget
> (`FCMChatWidget`, a HUDModLoader child SWF) rather than the HUDMenu patch this plan was written for.
> Current state:
> - **Font rendering:** FIXED — the widget renders via the GFx engine aliases `$MAIN_Font_Light`
>   (body) / `$MAIN_Font_Bold` (headers/tabs); the earlier tofu/blank-text issue is resolved.
> - **Interactive UI:** DONE — the amber-themed scrolling chat UI with channel tabs is built into
>   `FCMChatWidget` (merged to dev, PR #330); it replaces the native green box this plan targeted.
> - **Send works on native Windows:** chat.v1 send round-trips end-to-end on ZFE 0.9.9+ with relay
>   fixes **#334** (attribute to the linked FCM user UUID, not the relay TEXT id) and **#335**
>   (persist `messages.relay_seq` so `poll`/history return relay sends).
> - **Native chat input decoded:** ZFE's top-level `setChatInputActive` / `isChatInputActive` /
>   `readChatInput` / `consumeChatInputSubmitted` / `clearChatInput` API (bare-value payloads,
>   `consumeChatInputSubmitted` returns a bool — read text from `readChatInput`) is understood and used;
>   a `SharedHUDTools` host-owned text-entry path is retained as the primary editor, with a no-lock
>   native ZFE buffer fallback.
> - **Remaining:** Proton/Wine is BLOCKED on an upstream Zig TLS bug (fix = ZFE on Zig >= 0.14.0),
>   tracked in **#326** — see
>   [../overlay/zfe/native-chat-relay/proton-status.md](../overlay/zfe/native-chat-relay/proton-status.md);
>   plus minor follow-ups (e.g. the #11 link-notice URL). The channel/identity backend work below
>   (WS-A / WS-D) still applies regardless of transport.

---

## Evidence gathered (logs + DB, 2026-06-11)

### Channel model is wrong (root cause of 3 of 4 issues)
- DB channel tree:
  | id | name | parent | role |
  |----|------|--------|------|
  | `…0001` | **Fallout 76** | (none) | ROOT / container |
  | `…0005` | **General** | …0001 | leaf tab |
  | `…0002` | Trading | …0001 | leaf tab |
  | `…0003` | Events | …0001 | leaf tab |
  | `…0004` | Raids | …0001 | leaf tab |
- Message distribution: **General = 3132**, Events = 19, Trading = 2, **Fallout 76 (root) = 2**, Raids = 0.
- **The HUD feed SQL filters `WHERE c.parent_id IS NULL`** (`hudFeedService.ts:75`) → it shows ONLY the
  near-empty ROOT channel, never the real chat in General. The screenshot's `[Fallout 76]`-tagged
  messages are the handful of root-channel test sends.
- **The patch hardcodes `_fcmChannelId = …0001` (root)** (`apply-patch.py` FIELDS block) → every in-game
  send lands in the root container channel. Confirmed: `SEND ch=00000000-…-000000000001 ok=true`.
- Backend SEND currently **accepts** root-channel sends (root is `parent_id IS NULL` → "eligible"),
  so there is no guard preventing posting to the container channel.

### Identity gets a hash suffix instead of pairing
- `hudIdentityService.ts` priority chain: (1) match by `identityHash`; (2) auto-pair an **unlinked**
  user whose `fo76CharacterName` equals the HELLO character name; (3) auto-provision.
- DB users:
  | username | fo76_character_name | identity_hash |
  |----------|---------------------|---------------|
  | `Devotek-` | (null) | none — **real Discord account** |
  | `Devotek` | Devotek | set — prior HUD provision (junk) |
  | `Devotek-cf73d7` | Devotek | set — current HUD provision (junk) |
- Game HELLO sends character `Devotek`. Priority 2 fails: the real account `Devotek-` has
  `fo76CharacterName = null` (≠ `Devotek`), and the only character-name match (`Devotek`) is already
  linked. Falls to priority 3 → username `Devotek` is taken → appends `-${identityHash.slice(0,6)}`
  = **`Devotek-cf73d7`** (`hudIdentityService.ts:123-130`).
- Net: account-name (`Devotek-`) ≠ FO76 character (`Devotek`); pairing can't bridge that gap, and
  test runs left duplicate junk users.

### Input box nests inside the FCMBridge faux bar
- zfe.log: `[style]: aligned to FCM input @global 13,213 size 397x26` — the patch's field aligns to
  the geometry of FCMBridge's faux input bar (`inp`, the `› Chat via…` bar). Both draw their own
  background/border → a **box inside a box**. The patch's field also doesn't fill the bar's width.

### Send contention (already mitigated, keep in mind)
- Earlier "socket not connected" send failures were the two SWFs (FCMBridge owner + patch writer)
  fighting over ZFE's single native socket, aggravated by `HUD_PUSH_BACKFILL_ENABLED=false` causing
  FCMBridge stale-nudge churn. Re-enabling backfill stabilized the socket and send now works.
  The architecture is still fragile — see WS-C optional hardening.

---

## Target behavior

1. HUD feed shows the **real community chat** (General + the other leaf tabs), not the empty root.
2. Default send channel = **General** (`…0005`), never the root container.
3. **No message may post to the root "Fallout 76" container** (HUD send guard + default fix).
4. In-game **channel switching** across General / Trading / Events / Raids, mirroring the dashboard tabs.
5. Identity **pairs to the player's real account** when the FO76 name matches; no hash-suffixed
   usernames for legit users; clean up junk users.
6. Single, correctly-sized input box (no nested border; fills the bar width).

---

## Workstreams (parallelizable)

### WS-A — Backend: channel eligibility, send guard, default (Sonnet)
**Files:** `backend/src/services/hudFeedService.ts`, `backend/src/services/hudPush.ts`
(`isHudEligibleChannel`), `backend/src/services/ingestMessage.ts` (or hudPushTcp SEND path),
`backend/src/config/environment.ts`, tests under `backend/tests/`, docs in `docs/overlay/zfe/` +
`docs/realtime/`.
- Change feed eligibility from "root only" (`parent_id IS NULL`) to **leaf channels** (the children of
  the root container): `fetchFeedRows` SQL and `isHudEligibleChannel` must select General/Trading/
  Events/Raids and EXCLUDE the root container. Keep the channel tag per record (already emitted).
- Add a **HUD send guard**: reject `SEND` whose channelId is a container (`parent_id IS NULL`) or not a
  known leaf tab — return `ok=false reason=invalid-channel`. (Do NOT silently accept root sends.)
- Introduce a `HUD_DEFAULT_CHANNEL_ID` (default General `…0005`) the SWF can fall back to; document it.
- Tests: feed returns leaf-channel rows; root-channel send rejected; General send accepted.
- **HARD RULE:** update `docs/overlay/zfe/` (wire format / eligibility) + `docs/realtime/` in the same change.

### WS-B — HUDMenu patch: send target + channel switching + input box (Sonnet)
**Files:** `game-mods/FCMBridge/hudmenu-chat/fcm-inject.as`,
`game-mods/FCMBridge/hudmenu-chat/apply-patch.py`, then RABCDAsm re-splice → repack `HUDModLoader.ba2`.
- Change default `_fcmChannelId` from `…0001` (root) to `…0005` (General).
- Implement **channel switching**: a key (proposed: a control-map action already routed through
  `ProcessUserEvent`, e.g. cycle on a Tab/PageUp-PageDown-style action — pick one that's dead in FO76
  like the Console family) that cycles General → Trading → Events → Raids. Maintain a name↔UUID map.
  On switch: update `_fcmChannelId`, update the input prompt/tag to show the active channel, and
  notify FCMBridge to filter the feed display (shared marker / method call — see WS-C).
- **Input box fix:** make the patch's field borderless (no own background/border) so it sits cleanly
  inside FCMBridge's bar AND fills its width (use the aligned `size 397x26`, set `width` to the bar
  width, `border=false`, `background=false`), OR have it fully replace the bar. Coordinate with WS-C
  so exactly ONE border shows.
- Keep all `apply-patch.py` anchors' `die()` assertions; re-verify QName-preservation after splice
  (0 Multiname/CompassWidget hits) and confirm all fcm methods present.

### WS-C — FCMBridge feed widget: tab filter + input-box border ownership (Sonnet, Haxe)
**Files:** `game-mods/FCMBridge/FCMBridge.hx` → rebuild via local Haxe
(`~/haxe-tc/haxe_20240807093059_760c0dd/haxe`, `--swf-version 32`, patch byte3→0x20) → repack
`FCMBridge.ba2` (currently delivered via HUDModLoader — confirm load path).
- **Display filter by active channel:** the feed receives all leaf-channel records (tagged). Add an
  `activeChannel` the widget filters render on; expose a method/marker the patch (WS-B) sets when the
  user switches tabs. Default General.
- **Input-box border ownership:** decide ONE owner of the visible box. Recommended: FCMBridge keeps the
  bar background/border; the patch's field is borderless and fills it (pairs with WS-B). Ensure the bar
  width matches the feed panel width (`PANEL_W`) so the field fills the space (user: "same width as
  the text input box").
- **Optional hardening (stretch):** expose `fcmExternalSend(line)` on FCMBridge so the patch can write
  over FCMBridge's *owned* connected socket instead of grabbing its own bridge instance — removes the
  send-contention fragility permanently. Discoverable via a stage/`name` marker.

### WS-D — Identity pairing + data cleanup (Sonnet)
**Files:** `backend/src/services/hudIdentityService.ts`, a one-off cleanup script/SQL, tests, docs.
- **Pairing:** make the real Discord account pairable to the FO76 name. Options to design + implement
  (pick after reading the auth/account model):
  (a) allow auto-pair to match on **account name** (HELLO `accountName`) against the Discord username
  in addition to `fo76CharacterName`; and/or
  (b) a maintainer/admin action (or self-serve) to set `fo76CharacterName` on the real account so
  priority-2 auto-pair fires; and/or
  (c) avoid the hash suffix for a single obvious owner.
- **Cleanup:** remove/merge the junk users `Devotek` (`00765446…`) and `Devotek-cf73d7`
  (`61ea65f2…906f`); reattach the current `identityHash` to the real `Devotek-` account
  (`78558c1b…`). Provide a reversible script; do NOT delete the real account.
- Tests for the new pairing path; doc the identity model changes in `docs/overlay/zfe/`.

---

## Sequencing & dependencies
- WS-A (backend eligibility + guard) is independent and unblocks meaningful feed content; do first/parallel.
- WS-B and WS-C are **coupled** on the channel-switch protocol and input-box border ownership — they
  must agree on the shared marker/method and which component draws the border. Coordinate via this doc.
- WS-D is independent of B/C; depends only on backend.
- Final integration: rebuild both SWFs, repack both BA2s, single in-game test pass (game must be CLOSED
  to repack — never touch the prod overlay or `Fallout76`).

## Verification (per HARD RULES)
- Unit tests for every backend change (WS-A, WS-D) run in CI (`.github/workflows/ci.yml`).
- Re-verify HUDMenu QName preservation after RABCDAsm splice.
- Docs updated in the SAME change (channel eligibility, env vars, identity model, keybinds).
- In-game: feed shows General history; default send = General; root send rejected; tab switch works;
  single correctly-sized input box; real username (no hash suffix).
