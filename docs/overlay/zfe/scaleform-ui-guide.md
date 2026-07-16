# Working with Scaleform GFx UI (Fallout 76 / AS3) — Practical Guide

A field guide for building stable, performant in-game UI in Fallout 76's Scaleform GFx runtime (the
Flash/AS3 engine baked into Bethesda's Creation Engine). Written from a multi-source research pass +
our own hard-won experience shipping the FCM chat overlay. Pairs with
[two-way-chat-implemented.md](two-way-chat-implemented.md) (our working pattern) and
[textchat-blueprint.md](textchat-blueprint.md) (the original Text Chat decompile).

> **The golden rule:** Scaleform GFx is NOT Adobe Flash Player. It silently ignores or hard-crashes on
> a meaningful subset of AS3. Code that works in a Flash test harness can blank out or access-violate
> in-game. Validate everything in-game; treat the rules below as load-bearing.

---

## 1. The GFx execution model

- **Advance vs Render are separate threads.** The Advance thread runs ActionScript + timeline; the
  Render thread draws from a *snapshot*. There is **no Flash `invalidate()` / dirty-region API** at the
  AS layer — the whole movie advances or it doesn't.
- **Never update a TextField every frame** — it's the #1 documented perf drain. Update on data change
  only (we're event-driven off the socket — keep it that way).
- **`Extensions.noInvisibleAdvance = true`** excludes hidden clips (and children) from Advance — use it
  to freeze a hidden chat panel. Caveat: code relying on continuous `enterFrame` in a hidden clip stops.
- **`cacheAsBitmap`** is fine for static panels (our amber chrome) but bad for scrolling text
  (re-rasterizes on every scroll). Note: accessing `.filters` on a `cacheAsBitmap` object with no
  filters crashed pre-Scaleform-4.5.32 — don't poke `.filters`.

## 2. GFx vs Flash — what's banned or silently broken

| Feature | In GFx | Consequence |
| --- | --- | --- |
| **Filters on MovieClip/Sprite** (GlowFilter, DropShadow…) | **silently ignored** (work on TextFields ONLY, with limits) | wasted effort + the alt-tab-disappears bug |
| Inner glow/shadow, ConvolutionFilter, ShaderFilter, Pixel Bender | **unsupported** | `ReferenceError` for shader classes |
| `URLLoader`/`XMLSocket`/`Socket`/`LocalConnection`/`FileReference` networking | **disabled** | all remote I/O must go through the native bridge (ZFE/`__SFCodeObj`) |
| `ExternalInterface.call(obj/array)` | **type-stripped** to Null/Bool/Int/Number/String | pass JSON strings, never AS Objects, across the bridge |
| `BitmapData.paletteMap()`, `beginShaderFill`, `drawTriangles`, `lineBitmapStyle` | **not implemented** | — |
| `cacheAsBitmap` as a generic speed-up | **limited** | don't rely on it |
| Gradient masks, `BlendMode.SHADER` | **unsupported** | use solid/vector masks only |
| `fl.motion.*` (AnimatorFactory3D, MotionBase, KeyframeBase) | **Flash-only → runtime `ReferenceError`** | the Text Chat GiveawayWidget uses these — do NOT port it |
| Some `RegExp` operations | flaky in GFx's AVM2 | prefer split/join over regex (we already do in `fcmClean`) |

**Our codified crash rules (already in `FCMBridge.hx:38-44`, keep enforcing):** no `filters` arrays, no
HTML entities in `htmlText`, debug/plain text via `tf.text` never `htmlText`, `Extensions.enabled=true`
before any `scaleform.gfx.*` call.

## 3. Text rendering & fonts (the blank-text traps)

- **`embedFonts` is mandatory** on dynamic/input TextFields or text renders **blank** (GFx has no OS
  font fallback). Static text is fine (vector-baked).
- **Reuse the game's font library** rather than embedding our own where possible — reference an
  engine-registered font binding. **Which binding depends on the movie scope** (verified in-game,
  FCMChatWidget v2.3.0 → v2.5.3):
  - In **HUDMenu.swf itself** (a HUDMenu surgery patch), Bethesda's per-movie symbol `"$$MAIN_Font"`
    resolves.
  - In a **child widget SWF** loaded into `ApplicationDomain.currentDomain` (any HUDModLoader widget),
    `$$MAIN_Font` does **NOT** resolve and a Flash `@:font`-embedded TTF is **ignored by GFx** — both
    render every glyph as a **tofu square**. Use HUDModLoader's **engine-registered GFx aliases**
    instead: **`$MAIN_Font_Light`** (body text) / **`$MAIN_Font_Bold`** (headers/labels). These DO
    resolve in a child SWF (proven by HUDButton / HUDTools / HUDKeyboard), with no TTF embed —
    keep `embedFonts=true`. See `game-mods/FCMBridge/hudmodloader-chat/BUILD.md` → "Fonts".
  - If you must embed your own: `embedAsCFF="false"` (classic TextField, NOT TLF),
    `advancedAntiAliasing="true"`, a **narrow unicode range** (Latin ≈ 69KB; don't over-embed), and set
    `TextFormat.font` to the **DefineFont family name** (e.g. `"DejaVu Sans"` with the space), NOT the
    postscript name (`"DejaVuSans"`) — GFx matches the family name. Bold/italic are **separate faces** —
    embed them too if used.
- **`htmlText` is XML-strict.** Raw `&`, `<`, `>` in *content* break parsing → the whole field can
  render blank. Use numeric refs (`&#39;`) over named entities. Server-side `zfeSafe()` already strips
  `< > & " ~ |` — keep that contract on both ends.
- **`TextFieldEx.appendHtml(tf, html)` not `tf.htmlText +=`.** `+=` reparses the entire document every
  message; `appendHtml` is incremental. Fails silently if a StyleSheet is applied — don't use CSS.
- **Glyph cache: keep font size < 48px** (default `MaxSlotHeight`) or glyphs fall back to slow vector
  rendering. Minimize distinct faces/sizes (cache pressure). For an **input** field where users type
  arbitrary chars, `TextFieldEx.setForceVector(tf, true)` avoids cache misses; for display-only logs do
  NOT force vector (slower).
- Re-assigning `.text` after `.htmlText` strips all inline formatting — always rebuild the full HTML.

## 4. The scrolling chat-log recipe (proven by Text Chat)

One `TextField` (`multiline`, `wordWrap`, `embedFonts`), fed from a capped ring array:
1. On new message: cap the ring (`if(arr.length==N) arr.shift()`), then **rebuild**: `tf.htmlText=""`
   then loop `TextFieldEx.appendHtml(tf, line)` for each entry.
2. **Auto-scroll to newest:** `tf.setSelection(tf.length, tf.length)` (caret-to-end forces scroll to
   bottom). Do NOT rely on `scrollV = maxScrollV` — Text Chat's `scrollMax()` is a no-op bug.
3. **Manual scroll:** `--tf.scrollV` / `++tf.scrollV`, and set a `bScrolling` flag that **suppresses
   auto-scroll** while the user reads back. (Improve on the original: keep appending to the ring while
   scrolled up + show a "new messages" indicator — Text Chat dropped messages from view while scrolled.)
4. Per-message color via inline `<font color="#RRGGBB">`; channel/user/content each get their own span.
5. Ring size ≈ 80–150 (Text Chat uses 100). The "All" tab fills fastest if it mirrors every channel.

## 5. Input & focus — why HUD typing is hard (and how we got it working)

This is the subtlety that cost us the most, now fully explained:
- **A HUD-layer movie is keyboard-deaf by default.** The engine only routes keyboard `HandleEvent`s to
  the *focused menu*. `stage.focus = myField` is inert unless the movie itself received
  `HandleEvent(SetFocus)` from C++. That's why our early `stage.addEventListener(KEY_DOWN)` never fired.
- **`HUDMenu.ProcessUserEvent(actionName, isDown)` delivers NAMED actions, not characters** (`"Forward"`,
  `"Console"`, `"TeamChat"`). Great for detecting an open-key (we hook `"Console"` = the `~` key); useless
  for capturing typed text.
- **Typed text needs the engine's "edit text" gate.** Bethesda games gate text entry through
  `InputManager::AllowTextInput(true)` (SKSE/F4SE expose it; vanilla triggers it via the chat flow). It
  ref-counts: while >0 the engine stops feeding keys to gameplay and routes them to Scaleform's
  CharEvent pipeline. **This is exactly why we reuse the native `enterChatMode()`** — it runs FO76's own
  text-entry flow (`stage.focus = ChatEntryText_tf` + `BSUIDataManager "ControlMap::StartEditText"`),
  which trips the engine's text-input gate for us. Building our own input field means we'd have to
  trip that gate ourselves (no SKSE-equivalent on FO76 → we'd lean on `StartEditText`/`EndEditText`).
- **The native bridge / code-object pattern:** AS↔C++ goes through a code object (vanilla `BGSCodeObj`;
  ours is ZFE's `__SFCodeObj`/`BRG_OBJ`). It exposes named functions callable from AS
  (`call("writeUTFBytes", …)`). Only Null/Bool/Int/Number/String cross — strings for everything.
- **ZFE native chat-input session (ZFE 0.9.9+) — the sanctioned way to capture text.** ZFE's
  `dxgi.dll` exposes a native chat-input API as **TOP-LEVEL** ZFE commands (called bare, like
  `getRuntimeInfo` / `readStorage` — **NOT** `chat.v1.` commands): **`setChatInputActive`**,
  **`isChatInputActive`**, **`readChatInput`**, **`clearChatInput`**, **`consumeChatInputSubmitted`**,
  **`isChatKeyPressed`**. Prefixing them with `chat.v1.` returns
  `{"success":false,"error":{"code":"unsupported_command",...}}` (confirmed in-game, v2.5.0 test). They
  take **BARE-VALUE payloads (NOT JSON)** and return **BARE booleans/strings** (decoded in-game, v2.5.2
  probe → v2.5.3): `setChatInputActive("true")` → `true` and ACTIVATES (`"1"` also works; JSON `{}` /
  `{"active":true}` return `false` and do nothing); `setChatInputActive("false")` deactivates;
  `consumeChatInputSubmitted("{}")` → a bare boolean (`true` = Enter pressed since last check — **not**
  the text); `readChatInput("{}")` → the in-progress buffer text (this is where the message text comes
  from); `isChatInputActive`/`isChatKeyPressed` → `true`/`false`; `clearChatInput("{}")` → `true`. ZFE
  drives FO76's own text-input gate for you, so you do **not** roll your own input field. `sendMessage`
  is the one command that IS `chat.v1.`-prefixed (never bare — a bare `sendMessage` hits the legacy
  bridge and returns literal `false`). FCMChatWidget v2.5.3 runs the real flow when a clean
  self-resetting probe proves it usable: `setChatInputActive("true")` → poll `readChatInput` (show
  in-progress text) + `consumeChatInputSubmitted` (Enter) + `isChatInputActive` (Esc) → on submit
  `chat.v1.sendMessage` the `readChatInput` text → `clearChatInput` + `setChatInputActive("false")`. A
  low-rate `isChatKeyPressed` edge poll opens chat on the OpenChatKey (PAGE_DOWN); SharedHUDTools
  remains the fallback. See `game-mods/FCMBridge/hudmodloader-chat/BUILD.md` → "Native chat input (v2.5.3)".
- **Native Windows only — Proton/Wine is BLOCKED (2026-06-26, tracked in #326).** chat.v1 works
  end-to-end on native Windows but **crashes the game under Proton/Wine** at `chat.v1.connect` (a Zig
  `__fastfail` panic). Root cause is an upstream Zig TLS bug — `std.crypto.tls.Client.readvAdvanced`
  panics on PARTIAL socket reads (Wine read fragmentation + Cloudflare TLS 1.3 padding make it
  deterministic), fixed by Zig PR #20587 in **Zig 0.14.0**; the fix is the ZFE author rebuilding on
  Zig >= 0.14.0. chat.v1 uses its OWN Zig TLS client + a PEM CA bundle (the host CA bundle loads fine,
  `certs=149`) — **not** Schannel; the old `Schannel/Winsock` ZFE log line was the LEGACY Text Chat
  transport (relabeled `Legacy Text Chat transport backend` in ZFE 0.9.11). There is no client-side
  workaround. Linux/Steam-Deck users run the desktop overlay (native, no ZFE) instead.

## 6. Z-order & layering (a cleaner fix than our hack)

- AS3 display list: `addChild` = top; `addChildAt(o, i)`, `setChildIndex(o, i)`, `swapChildren`.
- **HUDModLoader stacks widgets in INI order** — later `hudmodloader.ini` entries render on top. Listing
  the FCM widget **last** keeps it on top with zero code.
- **`InteractiveObjectEx.setTopmostLevel(obj, true)`** renders an object above ALL others regardless of
  depth — a far cleaner fix for "input behind the feed" than our `setChildIndex` reparent hack
  (which only works within HUDMenu's own children).
- **`InteractiveObjectEx.setHitTestDisable(obj, true)`** makes an overlay pass mouse-through without
  hiding it (better than `mouseEnabled=false` when you still want programmatic hit-tests).

## 7. `scaleform.gfx.*` extensions — quick reference

Set `Extensions.enabled = true` once per display class before any of these.
- **`Extensions`**: `noInvisibleAdvance`, `visibleRect` (HUD-safe layout bounds), `isScaleform` (guard
  GFx-only code so a SWF can also run in a Flash test harness), `getTopMostEntity`.
- **`TextFieldEx`**: `appendHtml` (use it), `setVerticalAlign`, `setTextAutoSize` (SHRINK/FIT),
  `setForceVector` (input fields), `setImageSubstitutions`/`updateImageSubstitution` (emoji-in-text via
  BitmapData — the substitution map is the right way to do inline emoji), selection colors.
- **`InteractiveObjectEx`**: `setTopmostLevel`, `setHitTestDisable`, `setFocusGroupMask`.
- **`DisplayObjectEx`**: `setInvertedMask`, renderer string/float hooks, `disableBatching`.
- **`FocusManager`** (GFx) + **CLIK `FocusHandler`** (component layer): `setModalClip` locks focus to a
  clip (modal input), `setFocus`/`moveFocus` per-controller.

## 8. CLIK components are already in HUDMenu

FO76's `HUDMenu.swf` ships compiled CLIK (`scaleform.clik.*`): `ScrollingList`/`TileList` (data-bound,
`ListItemRenderer`), `ScrollBar`/`ScrollIndicator`, `Button`/`CheckBox`, `TextInput`/`TextArea`. We can
*instantiate and drive* these from injected AS (they exist in the loaded ApplicationDomain) even though
we can't recompile them without the Flex SDK + CLIK stubs. A `ScrollingList` is the "proper" scrolling
log, but a plain `TextField + appendHtml` (Text Chat's approach) is simpler and proven — prefer it
unless we need row interactivity.

## 9. HUDModLoader integration API (from decompile)

- **Loading:** `hudmodloader.swf` reads `Data/hudmodloader.ini` (one widget per line:
  `Name[, enabled][, reloadable]`) and `addChild`s each widget SWF into HUDMenu, sharing
  `ApplicationDomain.currentDomain` (mandatory — lets widgets see engine classes).
- **Input events:** `HUDMenu.ProcessUserEvent` dispatches a **bubbling `HUDModUserEvent`
  (`"HUDMod::UserEvent"`)** on the stage *before* native handling. Any widget can
  `stage.addEventListener("HUDMod::UserEvent", …)` to receive every control-map action (e.g. `"TeamChat"`,
  `"DiagnosticSnapshot"`=F12, `"L3"`). This is the conflict-free way for a *widget* to get input without
  patching HUDMenu.
- **`SharedHUDTools` IPC + text entry:** a message bus (`Register`, `SendMessage`) plus
  **`TextEdit(callback, startText)` + `FormatTextEdit(x,y,w,h,font,size,color,bg,alpha)`** — HUDTools'
  own text-entry machinery that handles gamepad OSK + the StartEditText/EndEditText cycle for you. A
  cleaner path than re-skinning the native green box, IF the user runs HUDModLoader.
- **HUD-mode filtering** (`HUDModes.All`, suppress in `VATS`/`ScopeMenu`), **`isReloadable=true`**
  (hot-reload from the F11 HUDModLoader menu during dev). Coordinate space is **always 1920×1080**.
- **Position config convention:** a per-widget `Data/<Widget>.ini` read via `URLLoader("../X.ini")` —
  the established way users reposition HUD mods by editing a text file (HUD-editor style).

## 10. Toolchain & build

- **ffdec full-class recompile widens vanilla `QName`→`Multiname`** (loses precise namespaces) which
  **crashes GFx**. Two mitigations: (a) FFDEC ≥ v19.0.0 fixes the direct-edit QName bug; (b) **what we
  do: RABCDAsm** — lossless ABC bytecode splice into the *pristine* bytecode, so vanilla methods stay
  byte-identical and only our methods/hooks are added. Pipeline + tools persisted at
  `game-mods/FCMBridge/hudmenu-chat/.build/tools/` (`build_rabc.sh`, patched `rabcdasm`, `splice2.py`).
- P-code markers `§§goto`/`§§newclass` etc. can't round-trip through FFDEC's source editor — another
  reason to use RABCDAsm for HUDMenu surgery.
- FO76 = AS3 / SWF≈FP11; carve SWFs from BTDX/GNRL `.ba2`; loose `Data/Interface/*.swf` loading is
  unreliable on FO76 — repack the `.ba2` (we swap the hudmenu blob, reusing original hashes).

## 11. Crash-avoidance checklist (pin this)

1. No filters on MovieClips/Sprites (no-op) and none anywhere we don't strictly need.
2. `embedFonts=true` + a real embedded/known font, or text is blank.
3. Never put raw `& < >` in `htmlText`; sanitize both ends (`zfeSafe`/`fcmClean`).
4. `Extensions.enabled=true` before any `scaleform.gfx.*` call.
5. `appendHtml`, not `htmlText +=`; no StyleSheet on append targets.
6. No `fl.motion.*`, shaders, `paletteMap`, gradient masks, networking classes.
7. Don't update TextFields per-frame; event-driven only.
8. Edit HUDMenu via **RABCDAsm lossless splice**, never ffdec full recompile.
9. Pass only strings across the native bridge; JSON-encode structure.
10. Validate in-game — a Flash harness will not catch GFx-specific failures.

---

## Sources

Autodesk Scaleform GFx Help (AS3 Extensions, TextFieldEx/InteractiveObjectEx/Extensions/FocusManager,
CLIK guide, Font/Glyph-cache parts 1/4/5, HUD Development best practices, ExternalInterface integration,
FAQs: rendering/memory/font/integration); FFDEC (github.com/jindrapetrik/jpexs-decompiler, issue #2072);
RABCDAsm (github.com/CyberShadow/RABCDAsm); SKSE/F4SE Scaleform hooks (ianpatt/skse64, F4SE changelogs,
AllowTextInput/code-object pattern); fo76modding guide (github.com/sdaskaliesku/fo76modding); moreHUDSE
(github.com/ahzaab/moreHUDSEScaleForm); Nexus HUDFramework/HUD Mod Loader pages; UDK Scaleform best
practices; gamesas/Nexus Flash-SWF-editing wikis. Plus our local decompiles of HUDModLoader.ba2 and the
Text Chat ChatMod.ba2.
