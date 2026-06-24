# Two-Way In-Game Chat — IMPLEMENTED & WORKING

> ℹ️ **ACTIVE (re-sequenced 2026-06-24).** This **FCMHUD/1** two-way input (custom `FCMBridge.swf` +
> M7) is the **shipping in-game path now** — the HUD feature push (epic #302) builds on it. ZFE
> **`chat.v1`** ([native-chat-relay/](native-chat-relay/README.md)) is a **later transport swap**, not
> a current replacement. This pattern stays the in-game-input reference until chat.v1 ships AND is
> validated (#291, post-launch).

**Status: functional.** A message typed in-game reaches the backend, is ingested with full governance,
and broadcasts back to every surface (dashboard, overlay, in-game feed). This documents the **exact
working pattern** discovered through a long debugging session so we can recover from regressions.
Last validated 2026-06-11 (in-game `SEND ok=true`, message round-tripped and displayed).

> The UI is currently the **native FO76 chat box** (green, bottom, no scroll). Replacing it with our
> amber-themed scrolling UI is the next phase — see [§8 UI rebuild plan](#8-ui-rebuild-plan). Everything
> below is the proven transport/capture/ingest core; do not regress it.

---

## 1. Architecture at a glance

```
~ key → FO76 control map → "Console" action
   → HUDMenu.ProcessUserEvent("Console", isDown)   [engine delivers it — ONLY input channel that works]
      → fcmEvent → enterChatMode()                  [native: stage.focus = ChatEntryText_tf + StartEditText]
         → user types into the native field         [KEY_UP handled by native chatEntryKeyUp]
            → ENTER → sendChatMessage(text)          [native]
               → fcmForward(text)                    [OUR injected hook]
                  → __SFCodeObj.writeUTFBytes("HELLO~acct~char\n" then "SEND~channelId~text\n")
                     → backend hudPushTcp inbound parser → ingestMessage → broadcast + persist + Discord
                        → message appears in the live feed (incl. in-game)
```

The mod is a **patched `HUDMenu.swf`** (Bethesda's HUD, with our AS3 injected) shipped inside
`HUDModLoader.ba2`. We do NOT recompile from scratch or add a separate SWF — we surgically edit the
already-present native chat chain and tap the socket FCMBridge already uses.

---

## 2. The hard-won FACTS (these cost us hours — do not re-discover)

1. **ZFE's native bridge exposes ONLY 5 socket verbs:** `register`, `connect`, `readByte`,
   `readUTFBytes`, `writeUTFBytes`. There is **NO** `isChatKeyPressed` / `updateChatHotkey` /
   `isEmergencyClosePressed`. The old Text Chat mod's key-detection used its **own native DLL**
   (SFE `dxgi.dll`, `GetAsyncKeyState`); ZFE does not provide that. The `zfe.log` line "Text Chat bridge
   hotkey default: INSERT" is a logged default, **not** a callable. → We cannot poll the native for a key.
2. **A stage `KeyboardEvent.KEY_DOWN` listener does NOT fire on the HUD layer.** Our first build relied
   on it and got zero events. Dead channel. Don't use it.
3. **The engine delivers input to `HUDMenu.ProcessUserEvent(actionName, isDown)` as NAMED control-map
   actions** (`"Forward"`, `"Melee"`, `"Console"`, `"Map"`, …) — NOT raw keys, NOT typed chars. This is
   the only input channel that works for a HUD-layer SWF. (Typed characters only reach a **focused
   INPUT TextField**, see §4.)
4. **The `~` (tilde/backtick) key fires the `"Console"` action** (and occasionally `"ConsoleToggles"`).
   FO76's console is disabled, so `"Console"` is a dead action we claim as our chat-open hotkey. INSERT
   maps to **no** action (does nothing). We hook `Console`, `ConsoleToggles`, and `TeamChat`.
5. **The live FO76 HUDMenu already contains a full native chat chain** — `enterChatMode()`,
   `resetChatMode()`, `chatEntryKeyUp()`, `sendChatMessage()`, and a focusable `ChatEntryText_tf`
   (under `HUDChatBase_mc.HUDChatEntryWidget_mc`). Typing into it WORKS (FO76 has native text chat
   infra). We reuse it; we do not build input from scratch (yet).
6. **HUDMenu and FCMBridge share ONE native socket.** Our HUDMenu does NOT register/connect its own —
   it finds the `__SFCodeObj`/`BRG_OBJ` bridge (same walk as FCMBridge) and just `writeUTFBytes` on the
   connection FCMBridge already opened. The backend reads HELLO/SEND inbound on that same feed socket.
7. **`ffdec -replace` CAN recompile the 1.6 MB HUDMenu safely** — it loads and runs in Scaleform. The
   earlier "crash" was the dead stage-listener / blind boot, not the recompile.

---

## 3. Input capture (the open key)

Injected `fcmEvent(action, pressed)` is called at the TOP of `HUDMenu.ProcessUserEvent`. On key-UP of
`Console` / `ConsoleToggles` / `TeamChat` it calls the native `enterChatMode()` and clears the field
(strips any stray backtick the open key leaked in). All high-frequency actions (movement/combat) are
suppressed so they don't flood the socket. See `game-mods/FCMBridge/hudmenu-chat/fcm-inject.as`
(`fcmEvent`).

> Why open on key-UP: the field isn't focused until `enterChatMode`, so holding the key before open
> doesn't type into it. Tap `~` → opens clean.

## 4. Typing + submit (native, unchanged)

`enterChatMode()` does `stage.focus = ChatEntryText_tf` + dispatches `BSUIDataManager`
`"ControlMap::StartEditText"` — that focus + event is what makes the engine route typed characters to
the field (and suspends WASD). The native `chatEntryKeyUp` handles ESC (close) and ENTER (submit →
`sendChatMessage`). We changed none of this.

## 5. Outbound (our injection)

In `sendChatMessage(text)` we inject `this.fcmForward(text)`. `fcmForward`:
- lazily finds the `__SFCodeObj`/`BRG_OBJ` bridge (parent-chain + stage-children walk, ported from
  `FCMBridge.hx findLegacyBridge`; discriminator: `call("__zfe_probe")` returns Boolean `false` on the
  real bridge, a string containing `unsupported_command` on decoys),
- sends `HELLO~<accountName>~<characterName>\n` once (identity from `BSUIDataManager` —
  `AccountInfoData.name` / `CharacterInfoData.name`),
- sends `SEND~<channelId>~<sanitized text>\n` (channelId hardcoded to General root
  `00000000-0000-0000-0000-000000000001`; `~`/newlines/quotes/backslash stripped to mirror backend
  `zfeSafe`).
`writeUTFBytes` is the proven send; never call `flush` (native no-op).

## 6. Backend ingestion

`backend/src/services/hudPushTcp.ts` `socket.on('data')` parses `\n`-delimited lines.
- **Line handling is SERIALIZED per connection** (`lineChain` promise chain). CRITICAL: HELLO and SEND
  arrive in the same TCP chunk; `handleLine` is async (awaits DB). Without serialization, SEND's
  `state.identified` check runs before HELLO's async identity resolve finishes and SEND is wrongly
  rejected as "SEND before HELLO". This bug ate the first working message — do not regress it.
- `HELLO~acct~char` → `resolveHudIdentity` → `HMAC(HUD_IDENTITY_SECRET, accountName)` = `identityHash`;
  identity resolution uses a priority chain (see `hudIdentityService.ts`):
  1. Existing user already linked to this `identityHash` → reuse.
  2a. Existing unlinked user whose `fo76CharacterName` matches `characterName` (exactly 1) → auto-pair.
  2b. Existing unlinked user whose `username` or `discordUsername` matches `accountName`
      case-insensitively (exactly 1) → auto-pair. Handles Discord accounts where `fo76CharacterName`
      was never set but the Bethesda account name equals the Discord username (e.g. both `"Devotek-"`).
  3. Auto-provision a new lightweight user (hash-suffixed username only on collision).
  Ban-hash → socket destroyed. Sets `state.identified`.
- `SEND~channelId~text` (only when identified) → `ingestMessage({userId, channelId, rawContent,
  source:'hud', identityHash})` → full governance (mute, rate-limit, validation, automod) →
  `finalizeMessage` (broadcast + write-behind persist + Discord relay).
- **HELLO is OPTIONAL.** Receive-only feed clients never send it and must NOT be dropped. (An earlier
  "destroy if no HELLO in 10s" timeout killed the feed — removed. Do not re-add.)

## 7. Build & install

Source of truth (committed, OUR IP only — never Bethesda's SWF/decompiled source):
- `game-mods/FCMBridge/hudmenu-chat/fcm-inject.as` — the injected AS3 methods.
- `game-mods/FCMBridge/hudmenu-chat/apply-patch.py` — applies fields + `fcmInit` (onAddedToStage hook)
  + `fcmEvent` (ProcessUserEvent hook) + `fcmForward` (sendChatMessage hook) + the `chatEntryKeyUp`
  keystroke probe, to a decompiled `HUDMenu.as`. Anchors auto-match vanilla vs HUDModLoader arg styles.

Build steps (toolchain under `/tmp`, re-setup if wiped):
1. JRE: Adoptium Temurin 17 (`jdk-17.0.13+11` jre tar.gz). ffdec: JPEXS `ffdec_21.0.5.zip`.
2. Extract the base `interface/hudmenu.swf` from the BTDX/GNRL archive (vanilla:
   `SeventySix - Interface.ba2`; HUDModLoader: `HUDModLoader.ba2.fcmbak` — always work from the
   pristine `.fcmbak` backup). GNRL: 24B header, 36B records `<I4sIIQIII`, name table at offset.
3. `ffdec -export script` → edit `HUDMenu.as` via `apply-patch.py` → `ffdec -replace base.swf out.swf
   HUDMenu patched.as`.
4. **Repack into the .ba2 by SWAPPING the hudmenu blob and REUSING the original records'
   hashes/names** (rebuild offsets only). This sidesteps the BA2 name-hash algorithm entirely. The
   game loads the file from `HUDModLoader.ba2` directly (loose `Data/Interface/HUDMenu.swf` loading is
   unreliable in FO76 — use the .ba2 swap).
5. The game must be fully closed to write the .ba2 (it holds an exclusive lock while running).

Two variants are produced: **HUDModLoader** (base = HUDModLoader's hudmenu — preserves the widget
loader so the FCMBridge feed + other widgets keep working) and **vanilla** (base = current
`SeventySix - Interface.ba2` hudmenu — for users without HUDModLoader, shipped as its own `.ba2`).

## 8. Diagnostics (never fly blind again)

The injected `fcmLog(level, cat, msg)` sends `DIAG~<cat>~<msg>\n` over the proven socket AND tries the
ZFE `__ZFE` logger. The backend's inbound parser handles a `DIAG` verb and appends to
`backend/hud-diag.log` (also logs `HELLO-ACCEPTED` and `SEND ok=…`). To debug a boot: clear
`hud-diag.log`, boot, act in-game, read the file. `load`/`event`/`open`/`type`/`send` categories trace
each stage. (Note: socket DIAG only arrives once FCMBridge has connected; the load-time DIAG may be
lost — rely on `event`/`open` after the user presses a key.) The ZFE side also logs as
`Mod API [HUDMenuChat]` in `zfe.log`.

---

## 8. UI rebuild plan (next phase — currently uses the ugly native green box)

Decompiled the original Text Chat UI for the proven mechanics. **Recommendation: build our chat UI as
AS3 DisplayObjects directly inside the patched HUDMenu (no second SWF)** — we already inject AS3, and
FCMBridge proves every primitive (`Shape` bg + `TextField` + `TextFormat`).

- **Scrolling message log:** one `TextField` (`multiline`, `wordWrap`, `embedFonts`); on each new line
  rebuild from a capped ring (~80) via `htmlText`/`TextFieldEx.appendHtml`, then **auto-scroll with
  `tf.setSelection(tf.length, tf.length)`** — this caret-to-end trick is how Text Chat pins to the
  newest line (`TextChatWidget.updateComplexChat`). Manual scroll = `scrollV ± 1` with a `bScrolling`
  flag that suppresses re-render. **Our current build doesn't scroll because it uses the native box —
  this is the fix.**
- **Our input field** (replace native): `TextField` `type = INPUT`, `maxChars=300`; enable typing with
  `stage.focus = ourInput`; submit on `KeyboardEvent.ENTER`; ESC → `stage.focus = stage`. Repoint the
  existing focus plumbing at our field instead of `ChatEntryText_tf`.
- **Theme (amber):** `Shape.beginFill(0x0C0A08, 0.94) + drawRect`, accent `lineStyle(1, 0xF5CB5B)`,
  Georgia/`$$MAIN_Font`. Same pattern as `FCMBridge.buildPanel`.
- **Position:** top-left under/beside the FCMBridge feed panel (`x=5,y=5`; Text Chat's own default is
  `0,0`).
- **Feed it:** render from the **same `color~channel~user~content` socket lines FCMBridge already
  drains** (reuse `renderRecords`).
- **Scaleform crash rules (from `FCMBridge.hx:38-44`):** NO filters (GlowFilter crashes), NO HTML
  entities in `htmlText`, set `Extensions.enabled = true` before any `TextFieldEx` call, `embedFonts` +
  a font in the SWF's table or text renders blank, use `tf.text` (not `htmlText`) for plain/debug text.

---

## 9. Design constraints (from planning)

- **Zero-executable constraint:** the mod works standalone — no Electron fallback. In-game keybinds or nothing. Path A (HUDMenu replacement) was chosen over Path B (HUDModLoader widget input) because `ProcessUserEvent` is only delivered by the engine to the real HUDMenu.
- **§4(F) note:** reading BSUIDataManager `isLocal` is FO76's sanctioned UI data bus, **not** game-memory reading — distinct from the retired v1.3.0 memory-reading path. This is an accepted §4(F) exception.
- **Dev-only guard stays closed:** M7 does not flip the production guard (`hudPushTcp.ts` + `hudPushWs.ts`). The full two-way feature ships dev-only; M6 (production exposure) is a separate, later decision.
- **Accepted trade-offs of Path A:** single HUDMenu slot (conflicts with other HUDMenu-replacing mods) + a re-merge on every game patch that changes HUDMenu — both documented in `hud-mod-compatibility.md`.

---

## Known gaps / follow-ups

- **UI**: native green box, wrong position, no scroll → §8 rebuild.
- **Persist**: in-game message broadcasts (seen live) but write-behind DB persist needs verifying (a
  test SEND showed `ok=true` but did not appear in `messages` — check the Bull queue worker).
- **History/backfill**: the in-game feed shows only **root** channels (`parent_id IS NULL`); the
  wastelander streamer writes to sub-channel `…0005`, so those don't appear there (not a chat bug).
- **Identity**: confirm auto-pair vs auto-provision behavior with a non-linked character.
- **Tests/docs (HARD RULE)**: backend ingestion is covered by Jest; the SWF side is manual. When the UI
  lands, add coverage where feasible and reconcile `textchat-blueprint.md` (its `isChatKeyPressed`/
  `updateChatHotkey` claims are WRONG for our ZFE — see §2.1).
