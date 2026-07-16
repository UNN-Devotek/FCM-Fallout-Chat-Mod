# ZFE (Zeroed Fallout Extender) — FCM in-game integration

ZFE is a `dxgi.dll` proxy for Fallout 76 that exposes `__ZFE` to the Scaleform
HUD. FCM's optional `FCMChatWidget` HUDModLoader mod uses its sanctioned
`chat.v1` surface to display chat in game.

> **Current widget (2026-07-16):** `FCMChatWidget` v2.9.4 targets `/relay` through
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
