# EasyFishing installer

This directory contains the cross-platform installer for the third-party
`EasyFishing.1.0.7.zip` bundle. The archive itself is intentionally not checked
into the repository; pass its path with `--archive`.

The installer does four things:

1. Copies `EasyFishing.ba2` to Fallout 76's `Data/` directory.
2. Adds the archive to `[Archive]` / `sResourceIndexFileList` in the correct
   custom INI, while preserving the other entries.
3. Copies the AHK script and `.ini` to a per-user directory.
4. Writes launchers and creates timestamped backups before changing an existing
   archive, config, or script.

It never kills Fallout 76. The game must be closed before installation or
uninstallation.

## Windows

Run from Git Bash (or another Bash environment with `awk`, `cmp`, and `unzip`):

```bash
bash game-mods/EasyFishing/install.sh \
  --archive /c/Users/you/Downloads/EasyFishing.1.0.7.zip \
  --install-ahk
```

The script searches common Steam libraries automatically. If the game is in a
non-standard library, pass `--game-dir` with the directory containing `Data/`.
The default user install directory is `%LOCALAPPDATA%/EasyFishing`.

`--install-ahk` downloads the portable AutoHotkey v1.1.37.02 runtime and checks
its SHA-256 before copying `AutoHotkeyU64.exe`; it does not modify the registry.
Without that option, install AutoHotkey **v1.1** separately and use the
generated `EasyFishing.cmd` launcher. AutoHotkey v2 is not compatible with this
script.

If Fallout 76 is installed from the Microsoft Store/Xbox app, pass its install
directory explicitly if it is not found automatically. The installer uses
`Project76Custom.ini` for the Xbox/ModifiableWindowsApps layout and
`Fallout76Custom.ini` for Steam.

The archive's own requirements still apply: keyboard and mouse, Borderless
Windowed mode, visible fishing-menu squares, and no color-changing overlays,
HDR, ReShade, or GPU color tweaks. This is a screen-reading/input-automation
mod, not a game-memory or network scanner. It is an optional modding track and
is separate from the EULA-safe desktop overlay.

## Linux / Steam Proton

The `.ba2` and INI registration can be installed on Linux:

```bash
bash game-mods/EasyFishing/install.sh \
  --platform linux \
  --archive ~/Downloads/EasyFishing.1.0.7.zip \
  --install-ahk
```

For Proton, the custom INI normally lives under Steam's
`compatdata/1151340/pfx/drive_c/users/steamuser/My Documents/My Games/Fallout 76`.
If Steam or the prefix is in a non-standard location, pass `--game-dir` and
`--config-dir` explicitly. The installed `run-easyfishing.sh` launcher
uses:

```bash
protontricks-launch --appid 1151340 AutoHotkeyU64.exe EasyFishing.ahk
```

Install Protontricks using your distribution's package or Flatpak before using
that launcher. The wrapper also supports `FO76_WINEPREFIX` as a fallback when a
normal Wine prefix is intentionally being used.

This is a compatibility path, not a native Linux port. AutoHotkey's
`PixelGetColor`, `PixelSearch`, and synthetic key/mouse input run through
Wine and are most likely to work with Fallout 76 under X11/XWayland. Native Wayland,
HDR/color filters, other overlays, and compositor focus behavior may still make
the automation unreliable. The desktop FCM overlay remains the supported Linux
chat path; this optional fishing automation is independent of it.

## Check paths without changing anything

```bash
bash game-mods/EasyFishing/install.sh \
  --archive /path/to/EasyFishing.1.0.7.zip \
  --platform linux \
  --dry-run
```

## Uninstall

```bash
bash game-mods/EasyFishing/install.sh \
  --platform linux \
  --game-dir /path/to/Fallout76 \
  --config-dir /path/to/My\ Games/Fallout\ 76 \
  --uninstall
```

Uninstall moves the installed `.ba2` to a timestamped backup, removes only the
EasyFishing entry from the custom INI, and leaves the per-user automation files
in place.
