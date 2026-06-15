# ZFE Logs and Troubleshooting

## Where zfe.log Is Written

By default, ZFE writes `zfe.log` beside the loaded `dxgi.dll`.

Fallback locations if that folder is not writable:
1. `<Documents>\My Games\Fallout 76\zfe.log`
2. `%LOCALAPPDATA%\ZFE\zfe.log`

Game Pass/Xbox installs often use the Documents fallback because the install container can be read-only.

## Force an Easy Log Folder (Testing Only)

```powershell
$env:ZFE_LOG_DIRECTORY = "D:\Temp\ZFELogs"
```

This affects only the current PowerShell process. The value is a **folder path**, not a full `zfe.log` path.

Clear afterward:
```powershell
Remove-Item Env:\ZFE_LOG_DIRECTORY -ErrorAction SilentlyContinue
```

## What to Look For

Useful lines:
- A ZFE DLL load line
- `ZFE Alpha/Experimental compatibility initialized` — game version supported, initialization complete
- `ZFE compatibility disabled: ...` — executable or version not supported
- Mod API lines from your own `log` calls
- `remote data refresh cached ...` or `remote data refresh failed ...` if using remote data
- The first warning or error near the time your mod fails

You do not need to understand every startup line. The key questions are: did ZFE load, did compatibility initialize, and what was the first warning/error near the problem?

## If No zfe.log Appears

Check:
- File is named exactly `dxgi.dll`
- `dxgi.dll` is beside the supported Fallout 76 executable
- ZFE release supports your current Steam or Game Pass game version
- Security software did not quarantine or block the DLL
- For Game Pass, check `Documents\My Games\Fallout 76\zfe.log`
- Try `ZFE_LOG_DIRECTORY` with a known writable folder

If still no log, ZFE may not be loading at all — re-check the install path and whether another wrapper/proxy is replacing `dxgi.dll`.

## If a UI Mod Cannot Find SFE/ZFE

ZFE replaces SFE. **Do not install SFE and ZFE at the same time.**

1. Confirm `zfe.log` exists.
2. Confirm the log says `ZFE compatibility initialized`.
3. Confirm your game version is supported by the installed ZFE release.
4. Confirm the UI mod is actually loaded by HUDModLoader or your mod setup.
5. If your mod calls ZFE directly, start with `getRuntimeInfo` and check `success:true`.

Do not set advanced debug variables such as Scaleform hook toggles unless a maintainer specifically asks. Those switches can make normal mod detection fail.

## What to Include in a Support Report

- Fallout 76 platform: Steam or Game Pass
- Fallout 76 game version (if known)
- ZFE version
- Whether SFE is also installed (it should not be)
- Mod name and version that failed
- Relevant part of `zfe.log` — especially startup lines and first warning/error
- Whether you used a mod manager or installed manually

Avoid posting unrelated personal information from logs or screenshots.

## For Mod Authors — Leave Breadcrumbs

```as3
api.call("log",
    "{\"vendor\":\"FCMBridge\",\"level\":\"info\",\"category\":\"startup\",\"message\":\"loaded\"}");
```

Good log messages name the feature and state what happened:
- `startup loaded`
- `settings read found=true`
- `remote data poll timeout`

Keep messages short. Do not log private player data.
