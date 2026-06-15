# ZFE Environment Variables

**Most Fallout 76 modders do not need environment variables.** If your mod uses ZFE normally, start with the [Modder Guide](modder-guide.md) and [ZFE API Reference](api-reference.md).

This page covers only the small set of environment variables useful while making or testing a mod.

## Quick Choice

| Goal | Variable |
|---|---|
| Test remote data against a local server | `ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT=1` |
| Test mod behavior when remote data is disabled | `ZFE_DISABLE_REMOTE_DATA=1` |
| Put `zfe.log` somewhere easy to find | `ZFE_LOG_DIRECTORY=your-folder` |
| Enable real-time live feed (Text Chat bridge) | `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1` |
| Override live feed endpoint | `ZFE_TEXT_CHAT_ENDPOINT=host:port` or `=wss://host/path` |
| Force-disable live feed even if opt-in is set | `ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND=1` |

## Two Rules

1. A switch that says `=1` must be exactly `1`. Values like `true`, `yes`, or `0` are ignored.
2. If you set a persistent Windows User variable, **restart Steam, the Xbox app, or the game** before testing. The game only sees environment variables that existed when the launcher/game process started.

## Localhost Remote Data Testing

> **Note:** Remote data ships with ZFE 0.9.1. Public builds before 0.9.1 do not include `zfe-remote-data-v1`.

Requires both the INI opt-in and the environment variable.

`Data/configuration/zfe.ini`:
```ini
[RemoteData]
Enabled=1
FragmentSources=1
AllowLocalhostDevelopment=1
```

PowerShell (persistent User variable):
```powershell
[Environment]::SetEnvironmentVariable('ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT','1','User')
# Restart Steam after setting
```

Source fragment for local testing:
```ini
[Source.local-test]
Vendor=FCMBridge
Key=hud.feed
Url=http://127.0.0.1:7177/api/game/hud-feed
MaxBytes=4096
CacheSeconds=30
TimeoutMillis=2000
```

Source fragments go in `Data/ZFE/RemoteData/sources/FCMBridge.ini`.

**Do not ask normal users to set localhost development.**

## Live Feed (Text Chat Bridge)

ZFE's live transport is opt-in and off by default. All three variables use **User scope** and
require a **full Steam exit + relaunch** after any change (the game inherits Steam's env block).

| Variable | Value | Effect |
|----------|-------|--------|
| `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND` | exactly `1` | Enables the Text Chat bridge (Schannel/Winsock transport) |
| `ZFE_TEXT_CHAT_ENDPOINT` | `host:port` (TCP) or `wss://host/path` (TLS WS) | Overrides the built-in default (`wss://falloutchatmod.com/ws/hud`). Plain `ws://` support is UNVERIFIED. |
| `ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND` | exactly `1` | Force-disables the bridge even when `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND=1` |

Dev setup (TCP, local backend):
```powershell
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND','1','User')
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','127.0.0.1:4001','User')
# Fully exit Steam (File > Exit), relaunch Steam, then launch game.
```

`zfe.log` startup confirmation line: `text_relay_backend=<value>`  
When opt-in is absent: `Text Chat transport backend: Schannel/Winsock (opt-in-disabled)`

See [realtime-socket.md](realtime-socket.md) for the full protocol and backend setup.

## Disabling Remote Data For Testing

Current PowerShell process only:
```powershell
$env:ZFE_DISABLE_REMOTE_DATA = "1"
```

Persistent:
```powershell
[Environment]::SetEnvironmentVariable('ZFE_DISABLE_REMOTE_DATA','1','User')
# Restart Steam after setting
```

## Moving the Log File

Current process only:
```powershell
$env:ZFE_LOG_DIRECTORY = "D:\Temp\ZFELogs"
```

This is a **folder path**, not a full `zfe.log` path.

## Clearing Test Variables

Current PowerShell process:
```powershell
Remove-Item Env:\ZFE_LOG_DIRECTORY -ErrorAction SilentlyContinue
Remove-Item Env:\ZFE_DISABLE_REMOTE_DATA -ErrorAction SilentlyContinue
Remove-Item Env:\ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT -ErrorAction SilentlyContinue
Remove-Item Env:\ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND -ErrorAction SilentlyContinue
Remove-Item Env:\ZFE_TEXT_CHAT_ENDPOINT -ErrorAction SilentlyContinue
Remove-Item Env:\ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND -ErrorAction SilentlyContinue
```

Persistent User variables:
```powershell
[Environment]::SetEnvironmentVariable('ZFE_LOG_DIRECTORY',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_DISABLE_REMOTE_DATA',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT',$null,'User')
[Environment]::SetEnvironmentVariable('ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND',$null,'User')
# Restart Steam after clearing
```
