# ZFE (Zeroed Fallout Extender) — FCM in-game integration

ZFE is a `dxgi.dll` proxy for Fallout 76 that exposes `__ZFE` to the Scaleform
HUD. FCM's optional `FCMChatWidget` HUDModLoader mod uses its sanctioned
`chat.v1` surface to display chat in game.

> **Current widget (2026-09-01):** `FCMChatWidget` v2.10.23 targets `/relay` through
> ZFE `chat.v1`. The backend keeps production relay access fail-closed until
> `RELAY_PRODUCTION_ENABLED=true` is deliberately rolled out. The desktop overlay
> remains independent of this optional mod path.

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

### HUD identity cosmetics (widget v2.10.23)

The relay now sends these additive fields on every `chat.message` event:

- `tag`: a server-validated Overseer tag, rendered before the sender name;
- `supporterStar: true`: the capability marker for an entitled Supporter or Overseer;
- `starColor`: a server-validated `#rrggbb` catalog color for the fixed `★` marker. The HUD
  renders that marker as a Scaleform inline image because its font aliases do not contain U+2605.

The widget never accepts a glyph from the wire. It uses immutable embedded five-point star assets
and falls back to the configured active-tab color if a star color is absent or malformed. The
catalog colour sources are embedded ahead of time because Fallout 76's GFx rejects runtime
`BitmapData.colorTransform` calls. Each row renders the selected asset through a direct HTML
`<img src="..." align="baseline">` linkage, avoiding a text substitution token that can leak into
the feed as literal text. When the local player sends a message, the widget waits for the
authoritative live relay event because ZFE strips cosmetics from the native send acknowledgement;
the sender therefore receives the same supporter marker and tag as every other message author.
The shared finalizer passes the server-resolved supporter tier to Discord, where the same immutable
star is shown beside the author.
Static history is decorated with the same current cosmetics as live messages. ZFE's native
chat bridge strips unknown JSON members before they reach Scaleform, so v2.10.23 also reads a
capability-gated `FCMHUD/1;...` envelope from the existing, known `targetUserId` member. That
member is an empty transport slot for ordinary channel chat; it is never a real recipient. Older
BA2 files receive no envelope, while raw relay consumers retain the additive JSON fields. The
relay stores only a short-lived one-way digest of the negotiated token/version in Redis; the
bearer token itself is never stored.
