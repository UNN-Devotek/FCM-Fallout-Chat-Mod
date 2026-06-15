# FCMBridge ⇄ ZFE Data Pattern (WORKING — battle-tested 2026-06-10)

How chat data actually flows from the backend into the in-game Scaleform HUD,
and every pitfall hit while getting there. **Read this before touching any part
of the pipeline.** The official ZFE article copies live alongside this file
([api-reference.md](api-reference.md) etc.); this doc records what those articles
do NOT tell you.

## The Pipeline

```
backend GET /api/game/hud-feed          ZFE (dxgi.dll)                FCMBridge.swf
  {"t":"col~ch~user~msg|col~…"}  ───►  fetch + JSON-validate   ───►  readRemoteData
  (quote-free string payload)          + cache 300s                  escape-aware extract → split('|')/split('~')
                                                                     → styled htmlText (ChatOverlay design tokens)
```

- Backend: `backend/src/routes/hudFeed.ts` (`zfeSafe` + `buildFeedLines`, unit-tested in `src/routes/__tests__/hudFeed.test.ts`)
- SWF: `game-mods/FCMBridge/FCMBridge.hx`
- ZFE source fragment: `<game>\Data\ZFE\RemoteData\sources\FCMBridge.ini`

## Payload Format — why `{"t":"…|…"}`

Three constraints force this shape; each was discovered by a failed attempt:

1. **The body MUST be valid JSON.** ZFE validates at cache-write and rejects
   anything else (`zfe.log`: `remote data refresh failed stage=cache-write …
   err=InvalidJson`). Plain text does not work.
2. **JSON string values must contain NO `"` or `\`.** ZFE's envelope escapes/
   unescapes exactly one level. Any pre-escaped character in the body (e.g. a
   message containing `\"quoted\"`) round-trips into a *bare* quote on the
   Scaleform side, corrupting the structure. Nested JSON (JSON body with
   escaped quotes inside the envelope's `text` field) is therefore unusable.
3. **AS3-side `haxe.Json.parse` proved unreliable** even on apparently-valid
   round-tripped bodies. Don't parse JSON in the SWF at all.

So: the backend pre-renders message records `color~channel~user~content`,
sanitizes every field quote-free (`zfeSafe`: `"`→`’`, `\`→`/`, `|`→`¦`,
`~`→`∼`, `<`→`‹`, `>`→`›`, `&`→`+`, newlines→space — the HTML chars matter
because fields are interpolated into Scaleform htmlText), joins records on
`|`, and wraps in a single-field JSON object. The SWF never parses JSON — it
extracts the envelope's `text` value with an escape-aware scan, unescapes one
level (`\"`→`"`, `\\`→`\`), pulls the `t` value (next `"` closes it — content
is quote-free by construction), splits on `|` then `~`, and renders each
record as styled htmlText.

## Visual Styling — ChatOverlay.tsx is the source of truth

The SWF mirrors the `fo76-wasteland` theme tokens from
`admin-dashboard/src/features/chat/ChatOverlay.tsx` (panel `#0A0907`, chrome
`#0C0A08`, primary `#F5CB5B`, text `#FAF4DA`; 23px header with
`rgba(primary,0.45)` underline; 1px `rgba(primary,0.25)` border; 14px text).
Message row anatomy matches the overlay: `[Tag]` in the channel color →
**bold username:** in primary → content in cream. The 8-layer black
text-shadow halo is approximated with a black `GlowFilter`. Token constants
live at the top of `FCMBridge.hx` — when the overlay theme changes, update
both.

## ZFE Configuration — the undocumented parts

These were established by reverse-engineering dxgi.dll 0.9.1 (string/parser
analysis) and live testing:

| Fact | Detail |
| --- | --- |
| **Boolean values are `yes`/`on`, NOT `1`** | The INI truthy parser only accepts `yes`/`on`. `Enabled=1` silently does nothing → `FragmentSources` never activates → every `readRemoteData` returns `invalid_remote_key`. This was the root cause of a full day of failures. |
| **zfe.ini is read from Documents too** | Keep identical copies at `<game>\Data\configuration\zfe.ini` AND `Documents\My Games\Fallout 76\configuration\zfe.ini`. |
| **CRLF line endings** | Files written from WSL get LF; convert to CRLF. |
| **`CacheSeconds` min is 300** | Out-of-range values risk invalidating the source. Don't set 10 for "fast dev iteration" — clear the cache dir instead. |
| **Fragment dir** | `<game>\Data\ZFE\RemoteData\sources\<Vendor>.ini`, resolved from the game EXE path. File stem MUST equal the `Vendor=` value. |
| **Matching is case-insensitive** | Vendor is lowercased in the cache path (`cache/fcmbridge/hud-feed/`). |
| **Source loading is silent** | ZFE logs NOTHING on successful fragment load. Absence of log lines ≠ failure. The only remote-data log lines are `remote data refresh cached …` and `remote data refresh failed …`. |
| **Localhost needs ini + env var + Steam restart** | `AllowLocalhostDevelopment=yes` AND Windows User env var `ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT=1`, then a FULL Steam exit/relaunch (the game inherits Steam's env block). |
| **`getRemoteDataState` does not exist** | The supported diagnostic is `getRuntimeInfo` — its `remoteData` field lists loaded sources. |

Working dev config:

```ini
; <game>\Data\configuration\zfe.ini  AND  Documents\My Games\Fallout 76\configuration\zfe.ini
[RemoteData]
Enabled=yes
FragmentSources=yes
AllowLocalhostDevelopment=yes
```

```ini
; <game>\Data\ZFE\RemoteData\sources\FCMBridge.ini
[Source.hud-feed]
Vendor=FCMBridge
Key=hud-feed
Url=http://127.0.0.1:7177/api/game/hud-feed
MaxBytes=65536
CacheSeconds=300
TimeoutMillis=5000
```

Production: same fragment with `Url=https://falloutchatmod.com/api/game/hud-feed`
(HTTPS + DNS hostname required; IP literals rejected), and no
`AllowLocalhostDevelopment`/env var needed.

## SWF-side gotchas

- **ZFE responses are AS3 object-literal STRINGS with unquoted keys**
  (`{success:false,error:{…}}`) — not valid JSON, not a Dynamic object. Parse
  by `indexOf` field-search only.
- **ZFE's log truncates at the first `{`** and caps messages (~4 KB). Before
  logging anything, replace `{`→`(`, `}`→`)`, `"`→`'`; chunk long output
  (`rt0=…`, `rt1=…`).
- **Text rendering**: `embedFonts=true` + `htmlText` with `$MAIN_Font` (in
  Haxe single-quoted strings write `$$MAIN_Font` — `$` interpolates).
- **Polling contract**: cold cache returns `found:false, refreshQueued:true` —
  retry after ~2 s; ZFE fetches in the background.

## Real-time push path

The polling pipeline above is the **cold-start and fallback** path.
When `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1` is set and ZFE connects its TCP/WS bridge,
FCMBridge receives an FCMHUD/1 push stream from the backend in real time:

- On connect: `HELLO~1~<n>` + last 30 backfill lines (same SQL as hud-feed, same `buildFeedLines` format)
- Live: one `color~channel~user~content\n` line per chat message
- Keepalive: `PING~<unixSeconds>` every 60 s (skipped by `renderRecords` — <4 fields)

The SWF polls via `readRemoteData` until the first socket line arrives (M3 — implemented),
then switches to live mode and stops polling. On socket death a 180 s watchdog resumes polling
and reconnects with 2 s→60 s exponential backoff.

Full protocol, env vars, backend architecture, and probe tooling:
**[realtime-socket.md](realtime-socket.md)**

## Build & Deploy (every change)

```bash
cd game-mods/FCMBridge
/mnt/c/Users/White/scoop/shims/haxe.exe --main FCMBridge --swf FCMBridge.swf --swf-version 32
python3 -c "
with open('FCMBridge.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
"   # MANDATORY: haxe writes version byte 43; the game requires 32
cp FCMBridge.swf "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf"
```

Iteration checklist:
1. **The game loads the SWF once at HUD init** — full game relaunch per SWF change.
2. **Backend `tsx watch` cannot see `/mnt/d` edits from WSL** (no inotify on
   drvfs) — kill and restart the backend after editing.
3. **Clear ZFE's cache** to force a refetch: delete
   `<game>\Data\ZFE\RemoteData\cache\` (else it serves stale data for `CacheSeconds`).
4. Watch `<game>\zfe.log` — `remote data refresh cached vendor=FCMBridge …`
   confirms end-to-end fetch.
