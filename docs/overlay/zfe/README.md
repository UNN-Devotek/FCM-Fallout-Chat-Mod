# ZFE / xScal — FCM in-game integration

ZFE (Zeroed Fallout Extender) and xScal are supported script-extender providers
for Fallout 76's Scaleform HUD. FCM's optional `FCMChatWidget` HUDModLoader mod
uses ZFE's sanctioned `chat.v1` surface or xScal's `chatInterface` surface,
selected automatically. Depending on the xScal build, that surface may be
under `__SFECodeObj` or `__SFCodeObj`. A call-only `__SFCodeObj` remains a
separate generic callback object and is not a ZFE discriminator.

> **Current widget (2026-09-04):** `FCMChatWidget` v2.10.50 targets `/relay` through
> ZFE `chat.v1` or xScal `chatInterface`. If both providers are present, the explicit xScal
> `chatInterface` marker wins; ZFE is selected only when that marker is absent. Both providers
> use SharedHUDTools text input when available.
> The desktop overlay remains independent of this optional mod path.

xScal `connect` is asynchronous. `success:true,status:"connecting"` is a pending-start response;
the FCM widget keeps the accepted transport alive, refreshes xScal auth state from the poll loop,
and reconnects only on explicit terminal states. If xScal exposes a separate generic
`__SFCodeObj.call`, FCM uses it only for the optional `log` diagnostic path and never for chat
verbs.

Both providers receive the same complete bounded history on the long-lived relay subscription. A
fresh cursor-zero subscription sends up to 15 recent rows for each static feed (`global`, `trade`,
`events`, `infests`, and `raids`) plus up to 50 rows from the current `server` room: 125 events
total. The native poll limit remains 64, so the widget drains this ordered snapshot over multiple
polls. xScal's asynchronous subscriber is drained with a 250 ms warm-up for at most 20 polls.
ZFE uses the same subscribe-time stream; it requests authenticated `FCMCTL/1/RESYNC` recovery
only as a delayed fallback after an empty or dropped initial poll, and xScal is never sent that
ZFE control.

## Provider paths and automatic detection

| Provider | Runtime object | Configuration path | FCM code path |
|---|---|---|---|
| ZFE | `__ZFE` or `ZFECodeObj` with `.call`; legacy `__SFCodeObj` is accepted only after a positive `chat.v1.getRuntimeInfo` probe | `Data/configuration/zfe.ini` or `Documents/My Games/Fallout 76/configuration/zfe.ini`; FCM fragment at `Data/ZFE/TextChat/fragments/FCM.ini` | `FcmNativeApi.hx` calls canonical `chat.v1.*` verbs; SharedHUDTools input is primary and ZFE native input is no-lock fallback |
| xScal | `__SFECodeObj.chatInterface` or `__SFCodeObj.chatInterface` with `connect`, `pollEvents`, and `sendMessage`; a call-only `__SFCodeObj` is not used for chat | `xscal.ini` beside the Fallout 76 executable, using the `[Chat]` section; package example is `xscal.ini.example` | `FcmNativeApi.hx` removes `chat.v1.`, maps `report` → `reportMessage`, and uses SharedHUDTools input |

The shared widget files are `Data/FCMChatWidget.ba2`, `Data/FCMChat.ini`, and the
HUDModLoader registry entry. `hudmenu-chat/fcm-inject.as` passes the host's ZFE or
xScal object to `FCMBridge.hx` with a provider hint; `FCMChatWidget.hx` and
`FCMBridge.hx` also retry self-discovery on their parent/root chain. Detection is capability-based and
does not load `dxgi.dll`, read extender files, scan ports, inject code, or read
game memory. When both objects are exposed, an explicit xScal `chatInterface` is selected first;
otherwise the validated ZFE bridge is selected. A bare `__SFCodeObj` is only considered after
both positive surfaces have been ruled out and its ZFE capability is confirmed.

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
input. When the local player sends a message, the widget waits for the authoritative live relay
event because ZFE strips cosmetics from the native send acknowledgement; the sender therefore
receives the same validated marker/tag as every other message author. Static history is decorated
with the same current tag data as live messages. ZFE's native chat bridge strips unknown JSON members
before they reach Scaleform, so v2.10.30 also reads a
capability-gated `FCMHUD/1;...` envelope from the existing, known `targetUserId` member. That
member is an empty transport slot for ordinary channel chat; it is never a real recipient. Older
BA2 files receive no envelope, while raw relay consumers retain the additive JSON fields. The
relay stores only a short-lived one-way digest of the negotiated token/version in Redis; the
bearer token itself is never stored.
