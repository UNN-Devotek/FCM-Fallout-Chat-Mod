> Navigation correction (local HUD 2.10.77): the existing ZFE `Input.*` path is
> locally observed compatibility, not a verified public ZFE contract. Earlier
> references below equating `zfe-input-v1` with this surface are superseded:
> that capability describes `input.v1.*` text sessions. The new decoder removes
> general Haxe JSON dependencies associated with the observed Error #1014;
> live ZFE verification is pending. No navigation INI edits are required.
> The public guide names `zfe-hotkeys-v1` for hotkeys; migration requires its
> detailed payload contract. See [ZFE Modder Guide](https://www.nexusmods.com/fallout76/articles/255).

### User-selectable open-chat key

ZFE users may change the default `INSERT` open-chat key. The supported packaged workflow keeps
`Data/FCMChat.ini` `[FCMChat] openKey` equal to `Data/configuration/zfe.ini` `[TextChat]
OpenChatKey`; the global ZFE setting overrides the widget fragment. ZFE documents `INSERT`,
`DELETE`, `HOME`, `END`, `PAGE_DOWN`/`PAGEDOWN`/`PGDN`, and a single letter or digit. `DELETE`
is the recommended alternative. Restart Fallout 76 after editing native ZFE configuration.
The package ships `KEYBINDS.txt` with the complete procedure and conflict guidance. See the
[ZFE Modder Guide](https://www.nexusmods.com/fallout76/articles/255) for the extender hotkey surface.

xScal does not read `OpenChatKey` from `xscal.ini`. The HUD maps `Data/FCMChat.ini` `openKey`
to xScal's documented numeric `Input.RegisterKey`/`Input.IsKeyPressed` callbacks, then keeps
the named `HUDMod::UserEvent` path as a compatibility fallback. `Input.RegisterKey` is polling
bookkeeping, not keyboard suppression; xScal's documented suppression calls cover gamepad
buttons. Test the selected key for gameplay conflicts and do not add a fabricated
xScal `OpenChatKey` setting. See the [xScal Input interface, Nexus article 268](https://www.nexusmods.com/fallout76/articles/268)
for the documented registration and polling contract.

# ZFE / xScal — FCM in-game integration

## Duplicate-feed diagnostics (source-only; not yet released)

Diagnostic builds identify themselves with `diagnostics=dup-v1` on the BUILD line.
Every widget log message carries a random per-load `[instance=...]` tag. Interleaved
activity from different tags can reveal concurrent modern widgets; sequential tags
can simply indicate a reload. Old widgets/legacy renderers will not emit this tag,
so a single tag does not exclude a second older renderer.

Receive summaries include `appended` and `duplicateRejected` (normal message replay
rejections; scheduled-event edit handling is separate), alongside existing echo
matches and before/after record counts. Render summaries include `repeatedIds`,
`repeatedContent` (same channel, sender ID and body), and `pendingRows`. Repeated
content can be intentional; it is not proof of a delivery bug. `renderedRows`
counts tracked message rows before the optional new-message notice; `legacyTextVisible`
refers to this widget's fallback TextField, not an independently loaded legacy mod.

These additions emit counts, not message bodies, names or durable IDs. Snapshot
maps are limited to retained visible records and discarded after each summary.
To investigate, collect the extender log from startup through a visible duplicate,
plus a screenshot and the active HUD loader/archive configuration. Check the BUILD
marker first: existing packaged SWF/BA2 files do not contain these source changes.

## Retained-message replay protection (source-only; not yet released)

The HUD rejects a replay if a retained non-pending row already has the same channel
and nonempty durable message ID, even if fresh replay cursors evicted that ID from
the bounded history cache. Matching never uses message text. Pending own echoes
still follow reconciliation, scheduled-event edits use their existing update path,
and clearing server-world rows permits their normal history restoration.

This closes a reproduced cache-eviction duplication case; it does not establish the
cause of the reported 2.10.74 user's duplicates. It cannot suppress a second renderer
or duplicate backend messages assigned different IDs. Continue collecting the
instance/receive/render diagnostics for those cases.

## Appearance controls (source-only; not yet released)

F11 → FCM → Customize → Colors offers palettes for panel, tab-box and input-box
backgrounds, borders, message text, input text, default sender text, active/inactive
tab text and hints. Exact INI colors use `bgColor`, `tabRowColor`, `inputBgColor`,
`borderColor`, `textColor`, `inputTextColor`, `senderColor`, `tabActiveColor`,
`tabInactiveColor`, and `promptColor` (`#RRGGBB`). `bgAlpha` controls background
opacity for the panel, tab boxes, and actual SharedHUDTools editor. Custom
server-supplied sender colors are retained; the local sender color is a fallback.
Both providers persist these settings with the matching backend for xScal.

Input width and alignment are fixed to the widget's input rectangle. Its height
and font size are the only separate input geometry/text-size settings. Badges,
channel tags (including colors and visibility), emojis, default channel and
available channels are not appearance controls. Older `showChannelTag`,
`channelTagColor`, and per-channel `colorGeneral`/`colorTrading`/`colorEvents`/
`colorInfests`/`colorRaids`/`colorServer` INI overrides are ignored and no longer
serialized. Normal channel switching remains available.

Unified ZIPs include `Data/FCMChat.ini`, `xscal.ini.example`, the ZFE fragment
`examples/ZFE/FCMChatWidget.ini.example`, and the optional global endpoint override
`examples/ZFE/zfe.ini.example`. Merge the latter into an existing
`Data/configuration/zfe.ini` only when an override is needed; never replace its
unrelated sections. Install only the examples for the selected extender.

Every generated HUD ZIP includes `CUSTOMIZATION.txt` with F11 steps, the exact INI
keys, fixed-feature rules, and saved-setting precedence. The website's Appearance
page documents the same controls for public and signed-in users. Saved ZFE vendor
settings and xScal device settings take precedence over the INI.

## Auto-hide controls (source-only; not yet released)

`autoHideEnabled=false` in `[FCMChat]` disables automatic hiding while retaining
`autoHideSec` (default 60). F11 exposes **Auto-hide: ON/OFF** independently of
**Hide delay +5s / -5s** in Customize. The delay is bounded to 1–600 seconds;
changing it while disabled does not turn auto-hide on. Switching off cancels the
pending timer and reveals a hidden panel. Manual Hide remains available.
Legacy `autoHideSec=0` still means off; explicitly enabling it supplies a 60-second
delay. Enabled state and delay persist through ZFE storage or the updated xScal
relay settings. Reset restores enabled/60 seconds.

## Input sizing (source-only; not yet released)

In **F11 → FCM → Customize**, separate **Panel width +/−** and **Panel height +/−**
controls replace combined Size +/−. Width changes in steps of 30, height in steps
of 20. **Input height +/−** changes by 4; **Input text size +/−** and **Feed text
size +/−** change by 1. Labels show current values when the menu is built.
**Input text: use default size** restores inheritance. Changes apply immediately
and use the existing persistence path. Panel `width` and `height` also remain
independently editable in the INI. The input spans the panel's inner width.


Edit the `[FCMChat]` section of `Data/FCMChat.ini`, then reload the widget using
HUDModLoader's F11 menu. For example:

```ini
[FCMChat]
inputHeight=48
inputFontSize=24
```

`inputHeight` defaults to 28 and accepts 28–120 HUD coordinate units.
`inputFontSize` accepts 8–47; its default, 0, preserves the existing sizing:
SharedHUDTools inherits `fontSize`, while native input uses 13. An explicit value
applies to typed text in both paths without changing feed text or tab labels.
The same input rectangle drives the widget prompt and the overlaid
SharedHUDTools editor through `FormatTextEdit`, including width, height, stage
position, and input font size. Live menu resize/move/reset also reformats an open
SharedHUDTools editor; the next open always reapplies current settings. The
`FormatTextEdit ok` log includes dimensions and font size for in-game verification.
Increasing height alone does not enlarge text. The row grows to provide at least
10 units beyond the effective font size. Small panels reserve 70 units for tabs,
separation and feed, reducing effective input height/font as necessary without
discarding the requested settings. Both settings survive F11 saves on ZFE through local storage and on xScal through
the updated relay's device settings; reset restores 28/0. Existing packaged artifacts do not yet implement these settings.

> **HUD 2.10.74:** Styled emoji rendering and chosen name colors have been tested
> in-game. Verify the global ZFE endpoint as well as its fragment when switching
> Dev/Prod. See the [test record](../../testing/hud-emoji-status.md).


ZFE (Zeroed Fallout Extender) and xScal are supported script-extender providers
for Fallout 76's Scaleform HUD. FCM's optional `FCMChatWidget` HUDModLoader mod
uses ZFE's sanctioned `chat.v1` surface or xScal's `chatInterface` surface,
selected automatically. Depending on the xScal build, that surface may be
under `__SFECodeObj` or `__SFCodeObj`. A call-only `__SFCodeObj` remains a
separate generic callback object and is not a ZFE discriminator.

> **Current widget (2026-09-05):** `FCMChatWidget` v2.10.56 targets `/relay` through
> ZFE `chat.v1` or xScal `chatInterface`. If both providers are present, the explicit xScal
> `chatInterface` marker wins; ZFE is selected only when that marker is absent. Both providers
> use SharedHUDTools text input when available.
> The desktop overlay remains independent of this optional mod path.

xScal `connect` is asynchronous. `success:true,status:"connecting"` is a pending-start response;
the FCM widget keeps the accepted transport alive, refreshes xScal auth state from the poll loop,
and reconnects only on explicit terminal states. If xScal exposes a separate generic
`__SFCodeObj.call`, FCM uses it only for the optional `log` diagnostic path and the documented
`Input.*` physical-key bookkeeping path; it never uses that callback for chat verbs.

Both providers receive the same complete bounded history on the long-lived relay subscription. A
fresh cursor-zero subscription sends up to 15 recent rows for each static feed (`global`, `trade`,
`events`, `infests`, and `raids`) plus up to 50 rows from the current `server` room: 125 events
total. The native poll limit remains 64, so the widget drains this ordered snapshot over multiple
polls. xScal's asynchronous subscriber is drained with a 250 ms warm-up for at most 20 polls.
Both providers use authenticated `FCMCTL/1/RESYNC` recovery after a 1.5-second grace period
if static history is absent or the queue reports loss. A normal static snapshot suppresses replay.
SERVER replay IDs reset with SERVER rows on leave; static IDs remain remembered across world
changes. An accepted recovery restarts the bounded drain and forces the next roster/world bind.

Widget v2.10.58 waits for a correlated `FCMCTL/1/SERVER-READY` event from the relay before
showing SERVER or admitting its rows. Native queued success does not enable the tab. HUD
observations now include map player markers and public-team members (up to 24 names), and
main-menu state clears membership. Roster-derived rooms use an expiring session identity, so
leaving and joining a solo world cannot replay the previous solo room's history. See
[Server session binding](native-chat-relay/server-session-binding.md) for wire fields, failure
behavior, the inference limits, and the required two-player validation.

## Provider paths and automatic detection

| Provider | Runtime object | Configuration path | FCM code path |
|---|---|---|---|
| ZFE | `__ZFE` or `ZFECodeObj` with `.call`; legacy `__SFCodeObj`/`BRG_OBJ` is accepted only after a positive `chat.v1.getRuntimeInfo` probe | `Data/configuration/zfe.ini` or `Documents/My Games/Fallout 76/configuration/zfe.ini`; FCM fragment at `Data/ZFE/TextChat/fragments/FCM.ini` | `FcmNativeApi.hx` calls canonical `chat.v1.*` verbs; SharedHUDTools input is primary, ZFE native input is no-lock fallback, and physical `Input.*` navigation uses the first accepted dispatcher: generic callback first, then `__ZFE` |
| xScal | `__SFECodeObj.chatInterface` or `__SFCodeObj.chatInterface` with `connect`, `pollEvents`, and `sendMessage`; a call-only `__SFCodeObj` is not used for chat | `xscal.ini` beside the Fallout 76 executable, using the `[Chat]` section; package example is `xscal.ini.example` | `FcmNativeApi.hx` removes `chat.v1.`, maps `report` → `reportMessage`, uses SharedHUDTools input, and polls physical keys through the generic `Input.*` surface |

The shared widget files are `Data/FCMChatWidget.ba2`, `Data/FCMChat.ini`, and the
HUDModLoader registry entry. `hudmenu-chat/fcm-inject.as` passes the host's ZFE or
xScal object to `FCMBridge.hx` with a provider hint; `FCMChatWidget.hx` and
`FCMBridge.hx` also retry self-discovery on their parent/root chain. Detection is capability-based and
does not load `dxgi.dll`, read extender files, scan ports, inject code, or read
game memory. When both objects are exposed, an explicit xScal `chatInterface` is selected first;
otherwise the validated ZFE bridge is selected. A bare `__SFCodeObj`/`BRG_OBJ` is only considered
after both positive surfaces have been ruled out and its ZFE capability is confirmed. When Page
keys are collapsed to `Unmapped`, physical navigation uses only `Input.RegisterKey`,
`Input.IsKeyPressed`, and `Input.UnregisterKey`. The dispatcher is chosen at the first
registration: a separately discovered generic callback (`__SFCodeObj`/`BRG_OBJ`) first, then under
ZFE the `__ZFE` dispatcher itself, which serves `Input.*` from the same SFE-compatibility bridge as
`isChatKeyPressed` (ZFE 0.12 advertises `zfe-input-v1`). A void/null registration return counts as
success; an explicit false/error/unsupported answer moves to the next candidate. The poll starts at
provider discovery and does not depend on the relay session. Chat transport remains on the selected
ZFE or xScal chat surface and never receives Input.* verbs under xScal.

### Verified ZFE physical-navigation pattern (FCMChatWidget v2.10.54)

**Confirmed by live ZFE smoke test:** Page Up and Page Down switch channels when the loader
collapses those keys to `Unmapped`. This is the correct implementation pattern for ZFE:

1. Discover and validate the ZFE chat bridge with `chat.v1.getRuntimeInfo`; do not identify ZFE
   from a bare `__SFCodeObj` name.
2. For physical navigation, try a separately discovered generic callback first. If no generic
   callback accepts the operation and the selected provider is ZFE, call the same `Input.*`
   compatibility dispatcher through `__ZFE.call`.
3. Pass the Windows virtual-key integer directly, not a JSON payload:
   `PAGEUP=0x21` (33), `PAGEDOWN=0x22` (34), `UP=0x26`, `DOWN=0x28`, `HOME=0x24`, and
   `END=0x23`.
4. Register with `Input.RegisterKey`, poll with `Input.IsKeyPressed`, and release with
   `Input.UnregisterKey`. A successful void/`null` registration response is valid; only an
   explicit false, error, or unsupported response rejects a dispatcher candidate.
5. Decode ZFE's `Input.IsKeyPressed` response from an explicit `pressed`, `down`, or `value`
   field. A response containing only `"success":true` is not proof that the key is down.
6. Start the physical poll as soon as the provider is discovered, before relay authentication,
   and keep channel switching local to the HUD. Use an edge latch so a key-down/key-up pair
   performs one action, and unregister every key during widget shutdown.

The selected chat surface remains separate: `chat.v1.*` transport calls continue through the
validated ZFE bridge, while `Input.*` is used only for local physical-key bookkeeping. The
diagnostic log should identify the accepted dispatcher and preserve the clipped raw registration
and probe responses so a future runtime test can distinguish discovery, registration, decoding, and
channel-rendering failures.

## Guides

| Guide | What it covers |
|---|---|
| [**FCMBridge Data Pattern**](fcmbridge-data-pattern.md) | **START HERE — the working end-to-end pipeline + every pitfall (quote-free payload, `yes`/`on` booleans, build/deploy steps)** |
| [**Native Chat Relay (`chat.v1`)**](native-chat-relay/README.md) | Current adapter and protocol for the `FCMChatWidget` HUD mod. |
| [Real-Time Socket (FCMHUD/1)](realtime-socket.md) | Legacy bridge reference; not the `FCMChatWidget` transport. |
| [Two-Way Chat — Implemented](two-way-chat-implemented.md) | Legacy FCMHUD/1 reference; keep separate from the chat.v1 widget. |
| [Modder Guide](modder-guide.md) | Bridge discovery, `findZfeApi`, `getRuntimeInfo`, logging, safety boundary |
| [ZFE API Reference](api-reference.md) | Remote Data, Storage, Events, Imports, and Legacy Compatibility — full API call reference |
| [Environment Variables](env-vars.md) | Dev/testing only — normal users never need these |
| [Logs & Troubleshooting](logs-troubleshooting.md) | Finding `zfe.log`, what to look for, support reports |
| [Scaleform UI Guide](scaleform-ui-guide.md) | GFx execution model, banned features, text rendering, input/focus, toolchain |
| [HUD surface manifest](hud-surface-manifest.md) | Exact repository/runtime paths, provider markers, ownership, and verification ledger |
| [In-Game Chat Appearance](ingame-chat-appearance.md) | FCMBridge HUD vs ChatOverlay.tsx reference — gaps, improvements, banned list |
| [In-Game Send Investigation (2026-08-06)](ingame-send-investigation-2026-08-06.md) | **OPEN** — `invalid_channel` on send / no server chat: findings, four dead hypotheses, current evidence |
| [HUD Mod Compatibility](hud-mod-compatibility.md) | HUDModLoader coexistence, load-order analysis, mod survey, shipping recommendations |
| [Text Chat Blueprint](textchat-blueprint.md) | Reverse-engineered Text Chat decompile — the precedent for M7's input chain |

## FCMBridge Architecture

### Polling path (cold-start / fallback)

```
FO76 Scaleform (FCMBridge.swf)
  └─ __ZFE.call("readRemoteData", {vendor:"FCMBridge", key:"hud-feed"})
        │  GET (ZFE-cached 300s)
        ▼
  https://falloutchatmod.com/api/game/hud-feed
        │
        ▼
  Backend → {"t":"col~ch~user~msg|…"} (quote-free pre-rendered lines)
        → SWF splits on '|' and renders in HUD
```

The payload is deliberately NOT structured JSON — see
[fcmbridge-data-pattern.md](fcmbridge-data-pattern.md) for why (ZFE envelope
escaping corrupts nested quotes).

The standalone legacy renderer also treats every relay-provided display name,
message body, and pinned system notice as untrusted at the final GFx boundary.
Before assigning `htmlText`, `FCMBridge.swf` escapes `&`, `<`, `>`, and `"` as
numeric character references (`&#38;`, `&#60;`, `&#62;`, `&#34;`). Named entities
such as `&amp;` are intentionally not used because Fallout 76's Scaleform
parser can reject them. The game-mod CI job compiles this legacy Haxe source in
addition to the HUDModLoader widget and runs regression anchors for the escape
contract.

### Real-time push path (live feed)

```
FO76 Scaleform (FCMBridge.swf)
  └─ ZFE Text Chat bridge (ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1)
        │  TCP :4001  or  wss://.../ws/hud
        ▼
  Backend hudPush core
  (HELLO + 30-line backfill → live FCMHUD/1 lines on every chat:message)
        → SWF ZfeSocket wrapper reads \n-terminated lines, skips control lines,
          feeds renderRecords() unchanged
```

See [realtime-socket.md](realtime-socket.md) for full protocol, env vars, and probe tooling.

## Install Files (shipped with FCMBridge mod)

| File | Purpose |
|---|---|
| `dxgi.dll` → FO76 root | ZFE itself |
| `Data/configuration/zfe.ini` | Enables remote data opt-in |
| `Data/ZFE/RemoteData/sources/FCMBridge.ini` | Points ZFE at our backend |
| `FCMBridge.ba2` (or loose SWF) | The HUD widget |

## zfe.ini (shipped with mod)

```ini
[RemoteData]
Enabled=yes
FragmentSources=yes
```

**Booleans must be `yes`/`on` — `1` is silently ignored** (confirmed against
the 0.9.1 binary). Ship the file to BOTH `Data\configuration\` and
`Documents\My Games\Fallout 76\configuration\`, with CRLF line endings.
No environment variables required for production users.

## Dev / Localhost Testing

See [fcmbridge-data-pattern.md](fcmbridge-data-pattern.md) for the full dev
loop (build, version-byte patch, cache clearing). Localhost requires
`ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT=1` as a Windows User env var AND
`AllowLocalhostDevelopment=yes` in `zfe.ini`, then a FULL Steam exit/relaunch.


---

## Client version handshake (`clientVersion`)

The widget reports its `VERSION` to the relay in the register/hello payload. The relay records
it per connection (`backend/src/services/relay/clientCapability.ts`) and mirrors a short-lived
token-digest record in Redis (`clientCapabilityStore.ts`) for ZFE's separate subscribe socket.

**Why it exists.** The `.ba2` is distributed as a manual file copy — download, fully
exit the game, drop into `Data/`, restart. There is no auto-update and no way to retire
an old build, and BUILD.md already documents older widgets coexisting with newer relays.
So any field the relay starts emitting reaches clients that do not understand it,
indefinitely. Before this, `VERSION` only ever reached the local ZFE log, so the relay
had no way to tell what it was talking to.

Any future non-additive change to the shape of what the widget receives — such as a
sentinel embedded in a display string — **must** be gated on this. Unknown, missing or
unparseable versions fail closed. The legacy additive cosmetics capability starts at
`2.10.0`; the native-known `FCMHUD/1` carrier has its own stricter `2.10.16` gate because
ZFE filters unknown members before the SWF sees them.

Version comparison is numeric per component, not string: `'2.10.0' < '2.9.4'`
lexicographically, so a string compare would silently lock every updated client out.

`MIN_COSMETICS_VERSION` is **2.10.0**, the first build that reports a version at all —
the bump IS the capability signal.

### HUD identity cosmetics (widget v2.10.30)

The relay now sends these additive fields on every `chat.message` event:

- `tag`: a server-validated Overseer tag, rendered before the sender name;
- `supporterStar: true` and `starColor`: a server-validated supporter marker and its color.

The widget renders the marker as a fixed five-point vector `Shape` positioned from the author's
`TextField.getCharBoundaries()`. It never inserts U+2605, a bitmap, an HTML image, or a substitution
token, avoiding the tofu blocks produced by Fallout 76's missing star glyph and GFx image path.
Feed paragraph leading is zero and the feed keeps only a 4px safety gap above the top-level HUDTools
input. Current builds create a local pending row and reconcile it with authoritative send
receipts/live events; they do not wait for a live event before showing the pending send.
Server-resolved cosmetics arrive through the supported HUD carrier, and static history is
decorated with current tag data. ZFE strips unknown JSON members before they reach Scaleform,
so the v2.10.30 compatibility path introduced a
capability-gated `FCMHUD/1;...` envelope from the existing, known `targetUserId` member. That
member is an empty transport slot for ordinary channel chat; it is never a real recipient. Older
BA2 files receive no envelope, while raw relay consumers retain the additive JSON fields. The
relay stores only a short-lived one-way digest of the negotiated token/version in Redis; the
bearer token itself is never stored.

### v2.10.59 General and PipBoy behavior

General includes current-room SERVER rows with their SERVER labels; the SERVER tab remains
scoped to those rows alone. Room invalidation clears them from both views. This does not
broadcast server chat to other worlds or to the public Discord General channel.
PipBoy releases the HUD editor and blocks reopening during transition/while the UI menu
is present. Late callbacks from a released editor are ignored. Both ZFE and xScal share
this implementation; live simultaneous-input testing is required on each provider.

### xScal package setup

xScal can ship with `[Chat] enabled=false`. The website HUD ZIP includes
`Enable-xScal-Chat.cmd` and `.ps1`: close Fallout 76, extract into the game folder,
and run the CMD helper. Nexus HUD ZIPs never contain executable or script files; they include
`DOWNLOAD-XSCAL-SETUP-HELPERS.txt` pointing to the website ZIP instead. The helper backs up and edits the existing `xscal.ini`, enables chat,
and selects the package relay endpoint without replacing unrelated settings.
Linux/Proton users should merge the example's `enabled=true` and `relayEndpoint`
into the existing `[Chat]` section manually. Merely extracting the BA2 or the INI
example does not enable chat. ZFE packages contain neither this helper nor xScal settings.

For the native HUD outbox protocol, cross-instance deduplication and delivery limits, see
[HUD send receipts and retry safety](hud-send-retries.md).
