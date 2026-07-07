# FCMChatWidget — Build & Install Guide (chat.v1)

> **Status (2026-06-26):** v2.5.3 — WORKS end-to-end on **native Windows** with **ZFE 0.9.9+**;
> merged to `dev` (PR #330). **BLOCKED under Proton/Wine** (Linux / Steam Deck) by an upstream
> Zig TLS bug — see "Proton / Wine status" below. Linux/Steam-Deck users run the desktop overlay
> (native Linux chat, no ZFE) until ZFE ships a Zig-0.14.0 build.

## What this builds

`FCMChatWidget.swf` inside `FCMChatWidget.ba2` — a HUDModLoader widget that renders
FCM community chat inside Fallout 76's HUD, using the ZFE chat.v1 native API. ZFE **0.9.9+**
is required (0.9.8's `chat.v1.sendMessage` returned `dispatch_failed` — the send never reached
the relay; 0.9.9 fixed dispatch).

The widget:
- Discovers `__ZFE` on the parent HUDMenu frame via `findZfeApi()` — no env-var or
  `child_bridge_access` workaround needed. HUDModLoader's `ApplicationDomain.currentDomain`
  puts the widget in the same domain as HUDMenu, where ZFE installs `__ZFE`.
- Calls `chat.v1.getRuntimeInfo` first to gate on `zfe-chat-online-v1` (requires ZFE 0.9.9+).
- Connects via `chat.v1.connect`, polls via `chat.v1.pollEvents` (2 s cursor poll),
  sends via `chat.v1.sendMessage` with slug-based channels.
- (v2.5.3) The native chat-input verbs are **top-level / bare** ZFE commands taking
  **bare-value payloads** (`"true"`/`"false"`/`"1"`, NOT JSON) and returning **bare
  booleans/strings**. `setChatInputActive("true")` ACTIVATES, `"false"` deactivates;
  `consumeChatInputSubmitted` returns a bare boolean (`true` = Enter pressed) and the
  message text comes from `readChatInput`. When a clean self-resetting probe proves it
  usable, `openInput()` runs the native flow (open → read → consume → send → clear); a
  low-rate `isChatKeyPressed` poll opens chat on PAGE_DOWN; otherwise SharedHUDTools is the
  fallback. `sendMessage` stays `chat.v1.sendMessage`. See "Native chat input (v2.5.3)" below.
- Handles limited-state (unlinked account): receive-only, pinned link-code notice.
- Self-reads `worldId` from BSUIDataManager, sends HMAC-SHA256 control message on the
  `server` channel to bind the world-session room (EULA section 4(F)-safe: game's own HUD data).

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| Haxe | build | 4.3+ |
| Python 3 | build | stdlib only |
| HUDModLoader | runtime | Nexus; provides HUDMenu shell + SharedHUDTools + HUDButton + GFx font aliases |
| ZFE (dxgi.dll + zfe.ini) | runtime | **0.9.9+ required**; native Windows only (Proton/Wine is blocked — see below) |

No font/TTF dependency — v2.5.3 uses HUDModLoader's engine-registered GFx font aliases
(see "Fonts" below), so there is nothing to embed at build time. HUDModLoader is still
listed (runtime) because the native chat-input path falls back to SharedHUDTools when the
ZFE native input session is unavailable.

---

## Widget load mechanism — why a ba2 is required

HUDModLoader reads `Data/hudmodloader.ini` (bare name per line) and calls:

```actionscript
// LoaderHelper.load() -- from decompiled source:
this._loader.load(new URLRequest("FCMChatWidget.swf"),
    new LoaderContext(false, ApplicationDomain.currentDomain));
```

`URLRequest("FCMChatWidget.swf")` is a **relative URL**. In Fallout 76's Scaleform/GFx
context, relative URLs are resolved through the **archive virtual filesystem**. The loader
SWF lives at `interface/hudmodloader.swf` inside HUDModLoader.ba2 -- so the relative URL
resolves to `interface/FCMChatWidget.swf` inside any loaded ba2.

A loose file at `Data/interface/FCMChatWidget.swf` is invisible unless
`bInvalidateOlderFiles=1` and loose interface dirs are enabled. The ba2 path is clean
and matches the distribution deliverable.

---

## Full per-install layout (native Windows)

The verified working install places these files (relative to the FO76 root):

| Path | Contents |
|------|----------|
| `dxgi.dll` (FO76 root) | ZFE 0.9.9+ proxy DLL |
| `Data/HUDModLoader.ba2`, `Data/FCMChatWidget.ba2` | HUDModLoader + this widget |
| `Data/FCMChat.ini` | widget config (position, open key, channel) |
| `Data/hudmodloader.ini` | bare line `FCMChatWidget` |
| `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` | ZFE fragment (endpoint default, `OpenChatKey`) |
| `Data/configuration/zfe.ini` | `[TextChat] Endpoint=wss://<host>/relay` (per-key override) |
| `Documents/My Games/Fallout 76/Fallout76Custom.ini` | `[Archive] sResourceArchive2List=HUDModLoader.ba2, FCMChatWidget.ba2` |

## Build steps

Run from the `game-mods/FCMBridge/hudmodloader-chat/` directory.

### Step 1 -- Compile

```bash
# Staged toolchain:
HAXE_STD_PATH=<buildtools>/haxe_*/std <buildtools>/haxe_*/haxe build.hxml

# System Haxe:
haxe build.hxml
```

Produces `FCMChatWidget.swf` (CWS -- zlib-compressed, Haxe default).

### Step 2 -- Patch SWF (CWS to FWS, version byte 32)

Scaleform requires FWS (uncompressed) with version byte 32.

```python
python3 - << 'EOF'
import zlib, struct
path = 'FCMChatWidget.swf'
with open(path, 'rb') as f:
    raw = f.read()
sig = raw[:3]
if sig == b'CWS':
    body = zlib.decompress(raw[8:])
    file_len = 8 + len(body)
    header = b'FWS' + raw[3:4] + struct.pack('<I', file_len)
    raw = bytearray(header + body)
else:
    raw = bytearray(raw)
raw[3] = 32
with open(path, 'wb') as f:
    f.write(bytes(raw))
print("Patched: FWS v32, %d bytes" % len(raw))
EOF
```

### Step 3 -- Pack into FCMChatWidget.ba2

`ba2tool.py` (in `hudmenu-chat/`) supports creating new BTDX GNRL ba2 archives. The
Bethesda hash algorithm was reverse-engineered from HUDModLoader.ba2 known records and
is verified at import time.

```bash
python3 ../hudmenu-chat/ba2tool.py create \
    FCMChatWidget.ba2 \
    "interface/FCMChatWidget.swf=FCMChatWidget.swf"
```

Output record:
- Internal path: `interface/FCMChatWidget.swf`
- `nameHash=0x87ac17e5` (btdx_hash("fcmchatwidget"))
- `dirHash=0xd2fdf873`  (btdx_hash("interface") -- same as HUDModLoader.ba2)

### Step 4 -- Install files

```bash
GAME="/mnt/d/SteamLibrary/steamapps/common/Fallout76"

cp FCMChatWidget.ba2 "$GAME/Data/FCMChatWidget.ba2"
cp FCMChat.ini       "$GAME/Data/FCMChat.ini"

mkdir -p "$GAME/Data/ZFE/TextChat/fragments/"
cp FCMChatWidget.ini "$GAME/Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
```

### Step 5 -- Register the ba2

In `Fallout76Custom.ini` `[Archive]`:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2, FCMChatWidget.ba2
```

If other ba2s are already listed, append `, FCMChatWidget.ba2`.

### Step 6 -- Register with HUDModLoader

Add to game's `Data/hudmodloader.ini` (bare name, no section or file= syntax):

```
FCMChatWidget
```

### Step 7 -- ZFE endpoint (if not already set)

`Data/configuration/zfe.ini`:

```ini
[TextChat]
Endpoint=wss://dev.falloutchatmod.com/relay
```

For local relay: `Endpoint=ws://127.0.0.1:7177/zfe-relay`

The fragment supplies the dev default; `zfe.ini` overrides per-key.

### Step 8 -- Launch the game

Boot Fallout 76 with HUDModLoader and ZFE active. The widget loads automatically.

> **Linux/Proton note:** NO Steam launch option is required — ZFE's `dxgi.dll` proxy loads
> without `WINEDLLOVERRIDES` (the usual `WINEDLLOVERRIDES="dxgi=n,b" %command%` is harmless but
> unnecessary on CachyOS). However, chat.v1 **crashes under Proton/Wine** at `chat.v1.connect` —
> see "Proton / Wine status" below. The native Linux chat path is the desktop overlay, not this widget.

---

## Keybind configuration

One binding controls chat input. Default: `PAGE_DOWN`. No custom keybind config.

### 1. ZFE native hotkey

File: `Data/ZFE/TextChat/fragments/FCMChatWidget.ini`

```ini
[TextChat]
OpenChatKey=PAGE_DOWN
```

User override (wins over fragment, per-key): `Data/configuration/zfe.ini` `[TextChat] OpenChatKey=...`

### 2. HUDMod::UserEvent binding

File: `Data/FCMChat.ini`

```ini
[FCMChat]
openKey=PAGE_DOWN
```

Keep `openKey` and `OpenChatKey` matching — they fire from the same physical key
via two independent paths (HUDMod::UserEvent and ZFE's key poll).

### Valid key/action names

| Value | Key |
|-------|-----|
| `Console` | Tilde / backtick |
| `TeamChat` | T (default team chat) |
| `PAGE_DOWN` | Page Down |
| `NextPage` | Page Down (also used for channel cycling) |
| `DiagnosticSnapshot` | Rarely used; safe fallback |

---

## Controls

| Action | Binding |
|--------|---------|
| Open chat input | Page Down (configurable -- see above) |
| Type + submit | Type in the HUDTools entry box, press Enter |
| Cancel input | Esc |
| Switch channel | Click a channel tab, `/g` `/t` `/e` `/i` `/r` in input, or Page Down (NextPage, cycle when closed) |
| Scroll back | Page Up (PrevPage when input closed) |
| Scroll to newest | Page Down (NextPage cycles; F12 menu "Scroll to newest"), or it auto-scrolls when not scrolled back |
| F12 menu | Channel switch, "Scroll to newest", and "Link account..." (when limited) |

Channels: `global` (GENERAL), `trade` (TRADING), `events` (EVENTS), `infests`
(INFESTS), `raids` (RAIDS). The channel-tab row is rendered as interactive HUDButtons
when HUDButton is available (gamepad-focusable + clickable); it falls back to a static
text strip otherwise.

---

## Verifying it loaded

Open `zfe.log` (Windows: `%LocalAppData%\zfe.log`; Linux/Proton: `~/.local/share/zfe/zfe.log`).

Expected on load (ZFE found on first attempt):

```
[FCMChatWidget] info startup: FCMChatWidget 2.5.3 loaded
[FCMChatWidget] info startup: BUILD=chatv1-widget-v2.5.3
[FCMChatWidget] info startup: zfe-chat-online-v1 OK
[FCMChatWidget] info startup: found after 1 attempt(s)
[FCMChatWidget] info hud: SharedHUDTools registered
[FCMChatWidget] info connect: attempt=1 displayName=<YourName>
[FCMChatWidget] info connect: connected
[FCMChatWidget] info auth: userId=<prefix>...
[FCMChatWidget] info auth: authState=authenticated
[FCMChatWidget] info probe: startup probe begin (v2.5.3)
[FCMChatWidget] info probe: getRuntimeInfo (chat.v1.getRuntimeInfo) raw={...}
[FCMChatWidget] info probe: getAuthState (chat.v1.getAuthState) raw={...}
[FCMChatWidget] info probe: setChatInputActive(true) (setChatInputActive) raw=true
[FCMChatWidget] info probe: setChatInputActive(false) (setChatInputActive) raw=true
[FCMChatWidget] info probe: clearChatInput (clearChatInput) raw=true
[FCMChatWidget] info probe: nativeInputUsable=true
[FCMChatWidget] info probe: startup probe end
[FCMChatWidget] info nativein: open-key poll started (150ms)
[FCMChatWidget] info world: worldId changed; sending control message
```

The **startup probe** runs once, right after `authState=authenticated`. It is now CLEAN
and self-resetting: it logs `chat.v1.getRuntimeInfo` / `chat.v1.getAuthState` once, then
activates with the decoded bare payload `setChatInputActive("true")`, sets
`_nativeInputUsable = nativeTruthy(raw)`, and ALWAYS deactivates (`setChatInputActive("false")`)
+ `clearChatInput("{}")` so native input is left INACTIVE (v2.5.2's probe used the wrong
`{"active":false}` reset and left native input STUCK ACTIVE, which fought the SharedHUDTools
box). The always-on watcher is REMOVED; its only useful job (open via PAGE_DOWN) is now a
low-rate `pollOpenKey()` that opens chat on an `isChatKeyPressed` false→true edge.

If ZFE is still attaching when the widget loads, you may first see:

```
[HUD status bar] chat.v1: searching ZFE (1/30)...
[HUD status bar] chat.v1: searching ZFE (2/30)...
...then the startup lines above when found (up to ~30 s)
```

Expected on input open + send via the NATIVE flow (open key, or PAGE_DOWN edge):

```
[FCMChatWidget] info nativein: isChatKeyPressed edge; opening input
[FCMChatWidget] info nativein: setChatInputActive(true) raw=true
[FCMChatWidget] info input path: native-chat-input
[FCMChatWidget] info nativein: read raw=hello
[FCMChatWidget] info nativein: clearChatInput raw=true
[FCMChatWidget] info nativein: setChatInputActive(false) raw=true
[FCMChatWidget] info send: payload ch=global len=<n>
[FCMChatWidget] info nativein: send-in-session raw={"success":true,...}
[FCMChatWidget] info send: sent ch=global len=<n>
```

The `send-in-session raw=...` line logs the FULL `chat.v1.sendMessage` result from a
native submit (first 200 chars), so we learn whether send works after a native session.

If the probe finds native input unusable, `openInput()` falls back to SharedHUDTools so the
user can still type (and `chat.v1.sendMessage` is exercised from that path):

```
[FCMChatWidget] info input path: shared-hud-tools
[FCMChatWidget] info input: FormatTextEdit ok
[FCMChatWidget] info input: FormatOnScreenKeyboard ok
[FCMChatWidget] info input: opened
[FCMChatWidget] info send: sent ch=global len=<n>
```

On a confirmed send the message is also echoed locally **immediately** (optimistic echo)
so the sender sees their line without waiting for the next poll; the server's echo of the
same message is deduped (by `messageId`, or by sender+channel+body) so it never shows twice.

If the relay rejects the send, you will see the mapped error code in the log and a
matching one-line notice in the feed (e.g. `permission_denied` shows the link prompt,
`user_muted` / `rate_limited` / `invalid_channel` / `message_too_long` show their notice,
and `auth_*` / `user_banned` trigger a reconnect):

```
[FCMChatWidget] warn send: relay rejected code=permission_denied raw={"success":false,...}
```

Slash commands (`/g`, `/t`, `/e`, `/i`, `/r`, plus long forms like `/general`,
`/trading`) consume the input without sending and update the active tab highlight:

```
[FCMChatWidget] info chan: selected global
```

If the widget produces NO zfe.log output at all: the ba2 was not loaded by the game.
Check `sResourceArchive2List` contains `FCMChatWidget.ba2` and the file is in `Data/`.

If you see "ZFE not found" on screen after 30 s: ZFE is not installed or zfe.ini is misconfigured.

Press **F12** in-game (HUDTools menu) -- FCMChatWidget should appear. `isReloadable=true`
so a hot-reload button is available without restarting.

---

## Known gaps / follow-ups

- **BSUIDataManager is UNREACHABLE from this widget (worldId / displayName) — server chat
  does NOT work in the widget variant.** The widget is a child SWF in HUDModLoader's
  ApplicationDomain, where `BSUIDataManager.GetDataFromClient` fails (same scope problem as
  the v2.1.x `ReferenceError #1065`). Confirmed empirically 2026-07-06: every session connects
  as the "Wanderer" fallback and no worldId read ever succeeds, so the SERVER tab (v2.8.0)
  never activates here. **The standalone track (`FCMBridge.hx` + patched HUDMenu) is the
  server-chat surface** — its `fcm-inject.as` polls BSUIDataManager in HUDMenu scope (where
  vanilla HUDMenu itself uses it) and feeds worldId + player name to the bridge.
- **Real displayName / worldId.** BSUIDataManager reads are attempted but fall back to
  "Wanderer" / empty if AccountInfoData is not available at connect time. This is a
  timing issue (widget loads before player is fully in-world). The connect-time fallback
  is safe; worldId HMAC is retried every 5 s so it will be sent once available.

## Proton / Wine status — BLOCKED, upstream-only (tracked in #326)

chat.v1 works on **native Windows** (ZFE 0.9.9+) but **crashes the game under Proton/Wine** at
`chat.v1.connect` (a Zig panic / `__fastfail`).

- **Root cause:** Zig `std.crypto.tls.Client.readvAdvanced` out-of-bounds / `@memcpy` panic on
  PARTIAL socket reads (Zig issues #15226 / #15673 / #14573), FIXED by Zig PR #20587 shipped in
  **Zig 0.14.0**. Wine's read fragmentation + Cloudflare TLS 1.3 record padding make the crash
  deterministic under Proton (intermittent on native Windows). The ZFE binary carries the sibling
  error `TlsConnectionTruncated`.
- chat.v1 uses its **own Zig TLS client + a PEM CA bundle** (NOT Schannel — the old `Schannel/Winsock`
  log line was the LEGACY Text Chat transport, relabeled `Legacy Text Chat transport backend` in
  ZFE 0.9.11). ZFE 0.9.11 logging confirms the host CA bundle LOADS FINE (`certs=149`) and the crash
  is in the TLS read, so the CA bundle is not the cause.
- **Fix is upstream-only:** the ZFE author must rebuild on Zig >= 0.14.0. There is **no client-side
  workaround** — plaintext `ws://` loopback is refused (ZFE won't `autoRegister` over insecure even
  with `[TextChat] AllowLocalhostDevelopment=yes`), a local `wss://` proxy still runs ZFE's buggy Zig
  TLS client, and there is no config to skip cert verification.
- **Linux / Steam Deck users:** use the desktop overlay (native, no ZFE) until ZFE ships the
  Zig-0.14.0 build.

## Native chat input (v2.5.3)

### History

v2.4.0's `sendMessage` failed with `dispatch_failed` (hardcoded inside ZFE's `dxgi.dll`).
v2.5.0 mis-prefixed the input verbs (`chat.v1.<verb>`) → `unsupported_command`, proving the
verbs are **top-level** (bare). v2.5.1 called them bare; v2.5.2 probed them and proved they
return **bare booleans/strings (not JSON)**. v2.5.3 **decoded the contract** from the v2.5.2
probe: the verbs take **bare-value payloads**, and programmatic activation DOES work with the
right payload.

### The decoded contract (bare-value payloads, bare returns)

`callTop(verb, payload)` → `__ZFE.call(verb, payload)` (bare, never `chat.v1.`-prefixed).
Payloads are **bare values, NOT JSON**:

| Verb (bare) | Payload | Returns | Notes |
|------|---------|---------|-------|
| `setChatInputActive` | `"true"` | `true` | ACTIVATES (isChatInputActive after = `true`). `"1"` also works. JSON `{}` / `{"active":true}` return `false` and do nothing. |
| `setChatInputActive` | `"false"` | `true` | deactivates |
| `consumeChatInputSubmitted` | `"{}"` | bare boolean | `true` = Enter pressed since last check. **Not the text.** |
| `readChatInput` | `"{}"` | bare string | the in-progress buffer text (this is where the MESSAGE TEXT comes from) |
| `isChatInputActive` | `"{}"` | `true`/`false` | session active? |
| `isChatKeyPressed` | `"{}"` | `true` | when the OpenChatKey (PAGE_DOWN) is pressed |
| `clearChatInput` | `"{}"` | `true` | resets the input buffer |

`chat.v1.getAuthState` returns ZFE's internal state JSON
(`{"success":true,"state":"authenticated","connected":true,"liveSubscriber":{"active":true},
"roles":["user"],"permissions":{...}}`). `sendMessage` is `chat.v1.sendMessage` ONLY —
**never** bare (bare hits the legacy bridge and returns literal `false`).

`nativeTruthy(raw)`: trims + lowercases; truthy IFF `== "true"` OR `== "1"` OR contains
`"success":true`. A bare `false` / empty / JSON / failure response is NOT truthy. Used for
`setChatInputActive` / `isChatInputActive` / `isChatKeyPressed` / `consumeChatInputSubmitted`.

`parseInputText(raw)`: the `readChatInput` buffer text — a bare string (`hello`), a
JSON-quoted string (strip the surrounding quotes), or a JSON object (extract a
`text`/`value`/`input` field). A bare `false` / empty → `""`.

### Clean self-resetting startup probe

Once per session (after `authState=authenticated`), `runStartupProbe()` logs
`chat.v1.getRuntimeInfo` / `chat.v1.getAuthState` once, then activates with the decoded bare
payload `setChatInputActive("true")`, sets `_nativeInputUsable = nativeTruthy(raw)` (falling
back to `isChatInputActive` if needed), and **ALWAYS** deactivates (`setChatInputActive("false")`)
+ `clearChatInput("{}")` so native input is left INACTIVE. (v2.5.2's probe used the wrong
`{"active":false}` reset and left native input STUCK ACTIVE, which fought the SharedHUDTools
box so the user could not type.) The always-on watcher and the payload-variant loop are
REMOVED — we know the answer now.

### Open triggers

- `onUserEvent` open key (`~` / Console / `_cfgOpenKey` / TeamChat) → `openInput()`.
- `pollOpenKey()` — a low-rate (~150 ms) timer that runs only while `_connected && !_inputOpen`
  and opens chat on a false→true edge of `isChatKeyPressed` (so the ZFE OpenChatKey PAGE_DOWN
  opens chat too). Debounced via `_lastChatKey`. It NEVER consumes/reads outside an open session.
- `openInput()`: if `_nativeInputUsable` → `openInputNative()`, else `openInputSharedHudTools()`.
  Never both.

### The native input flow (the real one)

`openInputNative()`: `callTop("setChatInputActive", "true")`; if `nativeTruthy(raw)` (or
`isChatInputActive` becomes truthy) set `_inputOpen=_nativeInput=true`, show the typing
prompt, start `_inputTimer` (~100 ms) → `pollNativeInput()`. On failure, fall back to
SharedHUDTools.

`pollNativeInput()` each tick (all guarded):

1. `readChatInput("{}")` → `parseInputText` → keep in `_inProgress`, show it in the prompt
   (`typingPrompt()` + " > " + text) so the user sees what they type.
2. if `nativeTruthy(consumeChatInputSubmitted("{}"))` → SUBMIT: read the buffer once more,
   `final = textNow || _inProgress`, `closeInputNative()`, and if non-empty run `final`
   through the shared `handleSubmittedText` (slash `/g /t /e /i /r` switch consuming, else
   send). The send is a direct `chat.v1.sendMessage`, and its FULL raw result is logged as
   `[nativein] send-in-session raw=<...200...>` (so we learn whether send works after a native
   session). Local-echo on a confirmed send as usual.
3. else if `!nativeTruthy(isChatInputActive("{}"))` → user cancelled (Esc) → `closeInputNative()`.

`closeInputNative()`: stop `_inputTimer`; `clearChatInput("{}")`; `setChatInputActive("false")`;
reset state + prompt. The loop only ever runs while a native session is open (never polls
consume/read outside one).

### Tested logic

`chatVerbFailed`, `nativeCommandName`/`callTop` (bare), `sendCommandName` (chat.v1.-only),
`setChatInputActivePayload` (bare `"true"`/`"false"`), `nativeTruthy` (`"true"`/`"1"`/`success:true`),
`probeUsable` (truthy-only gate), and `parseInputText` (bare string / quoted / json / `false`)
are mirrored in `cross-platform-overlay/__tests__/fcm-chat-widget-logic.js` and covered by Vitest.

## Fonts (v2.5.3 - engine aliases)

v2.5.3 uses HUDModLoader's **engine-registered GFx font aliases** — there is **no font
embed**:

- `$MAIN_Font_Light` — body / feed / messages / prompts / system notices (`FONT_BODY`).
- `$MAIN_Font_Bold`  — channel-tab labels, sender names, headers, active-tab (`FONT_BOLD`).

These aliases are registered by HUDModLoader at the GFx engine level (see `HUDTools.as`
`entry_tf`, which uses `$MAIN_Font_Light`, and `HUDButton.as` label TextFields, which use
`$MAIN_Font_Bold`). Unlike HUDMenu.swf's per-movie symbol `$$MAIN_Font` — which is **not**
resolvable in a child widget SWF — and unlike a Flash `@:font`-embedded TTF — which **GFx
ignores** for child SWFs — these engine aliases **do** resolve inside a child widget SWF
loaded into `ApplicationDomain.currentDomain`, proven by HUDButton / HUDTools / HUDKeyboard
rendering with them. `embedFonts = true` is kept on every TextField (the HUDTools entry_tf
precedent); the aliases resolve fine with it.

**Result:** no TTF dependency at build time. The SWF is ~35 KB (FWS, uncompressed;
v2.5.x's native chat-input + probe code added ~9 KB over v2.4.0's ~26 KB) versus the
v2.3.0 embed's ~711 KB.

**Root cause of the v2.3.0 tofu:** GFx resolves fonts per-movie. `$$MAIN_Font` is
HUDMenu.swf's symbol (not in a child SWF), and the Flash-embedded DejaVuSans TTF was
ignored by GFx for the child SWF — so every glyph rendered as a tofu square even with the
embed present.

**Fallback (only if the aliases still tofu in-game):** re-add the `@:font` embed and set
`TextFormat.font` / the `FormatTextEdit` font argument to the TTF's **DefineFont family
name `"DejaVu Sans"`** (with the space) — **not** the postscript `"DejaVuSans"`. GFx
matches the DefineFont family name; the v2.3.0 build used the postscript name, which is the
only reason its embed failed as a fallback.

## Input path notes (v2.2.0 fix)

v2.0.3 "immediately released" root cause: `HUDTools.startTextEdit` (HUDTools.as line 248)
gates on BOTH `entryFormats.hasOwnProperty(sendMod)` (set by `FormatTextEdit`) AND
`entryOSKFormats.hasOwnProperty(sendMod)` (set by `FormatOnScreenKeyboard`). v2.0.3 called
`FormatTextEdit` only, so the gate failed → HUDTools sent `ERROR|TXT` → `SharedHUDTools`
called `textFunction(null)` immediately → appeared as "immediately released" with no text.

v2.1.0/2.1.1 replaced SharedHUDTools entirely with a custom `TextFieldType.INPUT` field
and `BSUIDataManager.dispatchEvent("ControlMap::StartEditText")`. That approach failed because
`BSUIDataManager` is unreachable from a child SWF loaded with `ApplicationDomain.currentDomain`
(not the native HUDMenu scope). Proved on Windows: `ReferenceError #1065` on StartEditText.

v2.2.0 restores SharedHUDTools.TextEdit and adds the missing `FormatOnScreenKeyboard` call
(position off-screen at y=-300 so the gamepad OSK is invisible on PC). All three calls
are now made in order: `FormatTextEdit` → `FormatOnScreenKeyboard` → `TextEdit`.
