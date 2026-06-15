# ZFE API Reference

This is the combined API reference for all ZFE bridge calls available to HUD mod authors.
Read the [Modder Guide](modder-guide.md) first for bridge discovery, call mechanics, logging, and testing discipline.

---

## Remote Data

> **Note:** Remote data ships with ZFE 0.9.1. Public builds before 0.9.1 do not include `zfe-remote-data-v1`.

Remote data lets a mod read a configured HTTPS JSON/text resource without doing network I/O on the Scaleform thread. ZFE always returns local cache data immediately and refreshes in the background.

```as3
api.call("readRemoteData",
    "{\"vendor\":\"FCMBridge\",\"key\":\"hud.feed\"}");
```

Cold cache result:
```json
{
  "success": true,
  "vendor": "FCMBridge",
  "key": "hud.feed",
  "found": false,
  "source": "none",
  "stale": false,
  "refreshQueued": true,
  "text": ""
}
```

Cache hit result:
```json
{
  "success": true,
  "vendor": "FCMBridge",
  "key": "hud.feed",
  "found": true,
  "source": "cache",
  "stale": false,
  "refreshQueued": false,
  "text": "{\"messages\":[...]}"
}
```

### Polling Contract

- The first call on a cold cache **does not** return remote text.
- If `refreshQueued:true`, poll again on a later frame or timer.
- If `refreshQueued:false` and `found:false`, no refresh was admitted (remote data disabled, invalid source, no writable cache root, or both global refresh slots busy).
- Stale cache can return `found:true`, `stale:true`, `refreshQueued:true` — use stale text if acceptable, poll later for fresh.
- ZFE admits at most one refresh per `(vendor,key)` and at most two global refreshes. No unbounded queue.

Remote text is untrusted. Validate fields, handle missing data, never `eval` remote text.

### User Opt-In

Users must opt in globally via `Data/configuration/zfe.ini`:

```ini
[RemoteData]
Enabled=yes
FragmentSources=yes
```

**Booleans must be `yes`/`on` — `1` is silently ignored** (confirmed against the 0.9.1 binary). Ship the file to BOTH `Data\configuration\` and `Documents\My Games\Fallout 76\configuration\`, with CRLF line endings.

Optional per-user controls:
```ini
[RemoteData]
Enabled=yes
FragmentSources=yes
DisableVendors=BadVendor
DisableKeys=FCMBridge.hud.feed
AllowVendorsOnly=FCMBridge
```

`Enabled=0` or `ZFE_DISABLE_REMOTE_DATA=1` disables remote data globally.

### Source Fragments

Ship a source fragment with your mod at:

```
Data/ZFE/RemoteData/sources/<Vendor>.ini
```

Example (`Data/ZFE/RemoteData/sources/FCMBridge.ini`):
```ini
[Source.hud-feed]
Vendor=FCMBridge
Key=hud-feed
Url=https://falloutchatmod.com/api/game/hud-feed
MaxBytes=65536
CacheSeconds=300
TimeoutMillis=5000
```

Fragment rules:
- File stem must match a declared `Vendor`. `FCMBridge.ini` must contain `Vendor=FCMBridge`.
- `(Vendor, Key)` pair identifies the source used by `readRemoteData`.
- User `RemoteData.Source.<id>` entries in `zfe.ini` override fragment sources.
- Fragment attempts to set global `RemoteData` options are ignored.
- **Matching is case-insensitive** — Vendor is lowercased in the cache path (`cache/fcmbridge/hud-feed/`).
- **Source loading is silent** — ZFE logs nothing on successful fragment load. Absence of log lines ≠ failure.

Caps:
- `MaxBytes`: default 65536, range 1–262144
- `CacheSeconds`: default 86400, range 300–604800 (**min is 300** — out-of-range values risk invalidating the source; clear the cache dir for fast dev iteration instead)
- `TimeoutMillis`: default 3000, range 500–10000
- At most 32 merged sources loaded

### URL Policy (Production)

Release sources **must** use HTTPS:
- `https://` only, default port 443 only
- Host must be a DNS hostname, **not an IP literal** (IP literals are rejected)
- Resolved addresses must be global (no private/loopback/link-local)
- ZFE performs **GET only** — no request body, no user data sent

Do not put user secrets, account IDs, character names, or gameplay telemetry in URLs.

### Localhost Development

Requires **both** the INI opt-in and the environment variable:

```ini
; Data/configuration/zfe.ini  (AND Documents\My Games\Fallout 76\configuration\zfe.ini)
[RemoteData]
Enabled=yes
FragmentSources=yes
AllowLocalhostDevelopment=yes
```

```powershell
[Environment]::SetEnvironmentVariable('ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT','1','User')
# Restart Steam after setting (game inherits Steam's env block)
```

Source fragment for local testing:
```ini
[Source.localhost-demo]
Vendor=FCMBridge
Key=hud-feed
Url=http://127.0.0.1:7177/api/game/hud-feed
MaxBytes=4096
CacheSeconds=300
TimeoutMillis=2000
```

**Do not ask normal users to set localhost development.** It is only for mod authors testing on their own machine.

### Cache Locations

ZFE resolves and pins the cache root once per manager lifetime:

1. `<Game>\Data\ZFE\RemoteData\cache` (Steam)
2. `<Documents>\My Games\Fallout 76\ZFE\RemoteData\cache` (Game Pass)
3. `%LOCALAPPDATA%\ZFE\RemoteData\cache`

Cache entries: `RemoteData/cache/<vendor>/<key>/data.json` + `meta.json`

### Packaging

```
MyMod.ba2
  interface/MyMod.swf

Data/hudmodloader.ini        ← add MyMod entry
Data/ZFE/RemoteData/sources/FCMBridge.ini
```

### Testing Checklist (Remote Data)

1. `getRuntimeInfo` — confirm `zfe-remote-data-v1` in capabilities
2. Confirm `runtimeInfo.remoteData.enabled` is `true`
3. Confirm runtime info lists your `(vendor, key, host)`
4. `readRemoteData` once — expect `found:false` on cold cache
5. Poll after a delay until `found:true` or your mod's timeout
6. Inspect `zfe.log` for remote-data refresh failures
7. Test Steam and Game Pass separately
8. Verify Game Pass writes cache under Documents, not inside install container

---

## Storage

Use storage when your UI mod needs to save local text owned by your vendor — settings, UI state, or a small cache.

### Path Rules

Every storage call needs `vendor` and `path`.

Storage paths must:
- Use forward slashes `/`
- Contain 1–4 path segments
- Use only ASCII letters, digits, `.`, `-`, `_` in each segment
- Avoid empty segments, `.`, `..`, backslashes, or absolute paths

Good: `settings.json`, `profiles/default.json`, `cache/session/state.json`  
Bad: `../settings.json`, `settings\state.json`, `/absolute.json`

### Writing

```as3
api.call("writeStorage",
    "{\"vendor\":\"FCMBridge\",\"path\":\"settings.json\",\"text\":\"{\\\"enabled\\\":true}\"}");
// Result: {"success":true,"status":"saved"}
```

`text` is plain text. Encode structured data as JSON yourself.

### Reading

```as3
api.call("readStorage",
    "{\"vendor\":\"FCMBridge\",\"path\":\"settings.json\"}");
```

Found: `{"success":true,"found":true,"text":"...stored text..."}`  
Missing: `{"success":true,"found":false,"text":""}` — use as your first-run/default-settings case.

### Where Files Are Written

| Platform | Primary path |
|---|---|
| Steam | `Data/ZFE/Storage/<Vendor>/<path>` |
| Game Pass (read-only container) | `Documents\My Games\Fallout 76\ZFE\Storage\<Vendor>\<path>` |
| Fallback | `%LOCALAPPDATA%\ZFE\Storage\<Vendor>\<path>` |

### Storage Limits

- Write/read text limit: 1 MiB each
- Paths are scoped under your vendor
- Storage is local to the user's machine

### Storage Tips

- Store settings and UI state, not large databases
- Treat stored text as user-editable input — parse defensively
- Keep one stable vendor name forever so users don't lose settings after an update

---

## Events

Events are a **local, in-process message bus** for UI mods. Useful when one mod wants to announce something and another wants to react. Events are not saved to disk and are not network messages.

### Model

1. One mod calls `emitEvent`
2. Another mod periodically calls `pollEvents`
3. ZFE keeps a cursor per polling vendor so each vendor sees new retained events

By default, a vendor does not receive its own events. Use `includeOwn:true` to test your own emit/poll path.

### Emitting

```as3
api.call("emitEvent",
    "{\"vendor\":\"FCMBridge\",\"topic\":\"settings.saved\",\"data\":{\"profile\":\"default\"}}");
// Result: {"success":true,"status":"queued","id":1}
```

`topic` follows the same safe-name rules as vendor: 1–64 ASCII letters, digits, `.`, `-`, `_`.

### Polling

```as3
api.call("pollEvents", "{\"vendor\":\"FCMBridge\",\"max\":16}");
```

Result:
```json
{
  "success": true,
  "events": [
    {"id":1,"from":"MyMod","topic":"settings.saved","data":{"profile":"default"}}
  ]
}
```

Include own events: `{"vendor":"FCMBridge","max":16,"includeOwn":true}`

### Events Polling Notes

- `max` defaults to 16, clamped to 1–64
- Only the latest 128 events are retained
- A vendor cursor advances to the highest event ID returned to that vendor
- If an event falls out of the retained window before your mod polls, it is gone

### Simple Polling Pattern

```as3
var timer:Timer = new Timer(1000);
timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void {
    var result:String = String(api.call("pollEvents",
        "{\"vendor\":\"FCMBridge\",\"max\":16}"));
    // Parse result JSON and handle events
});
timer.start();
```

### Events Tips

- Use stable topic names: `settings.saved`, `profile.changed`
- Keep event data small — send IDs or state names, not large blobs
- Poll on a timer or UI lifecycle points, not every frame
- Treat events as hints — handle missed or delayed events gracefully

---

## Imports

Use imports when your UI mod needs to read a small, allow-listed file that the player or another mod intentionally generated in the game Data folder. This is **not** arbitrary filesystem access — ZFE only exposes named import sources.

### Supported Sources

| Source name | File |
|---|---|
| `inventomatic.items` | `Data/itemsmod.ini` |
| `legendary.mods` | `Data/LegendaryMods.ini` |

### Reading an Import

```as3
api.call("importExportFile",
    "{\"vendor\":\"FCMBridge\",\"source\":\"inventomatic.items\"}");
```

Found:
```json
{"success":true,"source":"inventomatic.items","found":true,"text":"...raw export text..."}
```

Missing:
```json
{"success":true,"source":"inventomatic.items","found":false,"text":""}
```

Missing imports are not errors — treat as "the user has not generated this file yet."

### Import Limits

- Import read limit: 2 MiB
- ZFE reads only the supported source names above
- Imported text is local user input — parse defensively

### Good Uses

- Displaying information from a player-generated export
- Building passive UI summaries
- Reading compatibility data the user intentionally placed in `Data`

Do not use imports for scraping, automation, arbitrary paths, or hidden user data.

---

## Legacy Compatibility

For authors and users of older Fallout 76 UI mods written for SFE-style bridge calls.

**New mods should use `__ZFE.call(command, payloadJson)` — see the [Modder Guide](modder-guide.md).**

### Legacy Bridge Object

Legacy SFE/Text Chat-compatible mods normally look for:
```as3
__SFCodeObj.call(...)
```

ZFE also supports common root/child fallback paths used by existing mods. `ZFECodeObj.call(...)` may be exposed as a fallback for the newer ZFE general API when the active UI root rejects `__ZFE`.

The object name is only the transport surface. The **command** determines whether you are using the legacy bridge or the newer ZFE API.

### Legacy File-Write Commands

ZFE models the observed legacy file-write command surface used by existing mods. Paths are relative to the game Data folder:

| Command | Target File |
|---|---|
| `writeChatConfigFile` | `Data/configuration/chatmod.ini` |
| `writeBuffDataFile` | `Data/BuffData.ini` |
| `writeChallengeDataFile` | `Data/ChallengeData.ini` |
| `writePerksFile` | `Data/perkloadoutmanager.ini` |
| `writeSaveEverythingFile` | `Data/saveeverything.ini` |
| `writeItemsModFile` | `Data/itemsmod.ini` |
| `writeLegendaryModsFile` | `Data/LegendaryMods.ini` |
| `writeVendorLogFile` | `Data/vendorlog.txt` |
| `writeDPSMeterFile` | `Data/DPSMeter.txt` |
| `writeCampSearchConfigFile` | `Data/CAMPSearch.ini` |
| `writeBlockFile` | `Data/configuration/blocklist.ini` |
| `writeCampDataFile` | `Data/CampData.ini` |
| `writeCharacterDataFile` | `Data/CharacterData.ini` |
| `WriteIHBData` | `Data/configuration/ImprovedBars.ctx` |
| `ReadIHBData` | `Data/configuration/ImprovedBars.ctx` (read) |

ZFE refuses empty payloads for `writeItemsModFile` and `writeLegendaryModsFile` to avoid wiping a user's previous export.

### Legacy Runtime Info

The legacy bridge exposes:
- `GetZFERuntimeInfo`
- `GetZFERuntimeInfo2`

Use `GetZFERuntimeInfo2` when an old SFE-style mod wants to detect ZFE and learn about the newer general API bridge objects. New ZFE API feature checks should use:

```as3
__ZFE.call("getRuntimeInfo", "{}")
```

### Text Chat Compatibility

ZFE models the local bridge behavior needed by known legacy SFE/Text Chat-style UI calls. This does not mean online Text Chat relay behavior is guaranteed for every user or every old mod.

### What Compatibility Does NOT Mean

Not guaranteed:
- Undocumented bridge commands
- Mods depending on unobserved SFE internals
- Unsupported Steam or Game Pass game versions
- Future Fallout 76 updates before ZFE is updated
- Online Text Chat relay reachability
- Using SFE and ZFE together

**ZFE replaces SFE. Do not install both at the same time.**

ZFE does not copy, patch, redistribute, or include SFE, F4SE, Text Chat, or Fallout 76 code or assets.

### If a Legacy Mod Cannot Find SFE/ZFE

1. Confirm `zfe.log` exists.
2. Confirm the log says `ZFE compatibility initialized`.
3. Confirm the game version is supported by the installed ZFE release.
4. Confirm SFE is **not** installed at the same time.
5. Confirm the UI mod is loaded by HUDModLoader or the user's mod setup.
