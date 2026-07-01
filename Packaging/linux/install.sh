#!/usr/bin/env bash
#
# Fallout Chat Mod — Linux installer
#
#   curl -fsSL https://falloutchatmod.com/install.sh | bash
#
# Downloads the latest AppImage from the release API, installs it under
# ~/.local/share, registers a desktop launcher + icon, and prints KDE setup
# notes.
#
# New versions are NOT installed automatically. Download new versions from
# Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or
# falloutchatmod.com.
#
# Re-running UPGRADES an existing install and fast-forwards from ANY older
# version (no per-version stepping). If you are already on the latest, it asks
# whether to reinstall or cancel.
# Uninstall:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash
#
set -euo pipefail

BASE="https://falloutchatmod.com/downloads/electron"
API_URL="https://falloutchatmod.com/api/releases"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APP_DIR="$DATA_HOME/FalloutChatMod"
APP_PATH="$APP_DIR/Fallout Chat Mod.AppImage"           # stable install path
DESKTOP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$DESKTOP_DIR/fallout-chat-mod.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ICON_PATH="$ICON_DIR/fallout-chat-mod.png"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# --- In-game cursor lock (Wayland) via protontricks --------------------------
# On Wayland the compositor drops Fallout 76's mouse-lock when the overlay sits on
# top, so the cursor can drift off the game. We enable Wine's mouse capture with the
# protontricks/winetricks verb "grabfullscreen=y" (the winecfg "Automatically capture
# the mouse in full-screen windows" setting) — NO hand-editing of Wine config. Best
# effort: needs protontricks + FO76's prefix (launch the game once) + FO76 closed. The
# overlay tray "Fix in-game cursor lock (Wayland)" re-runs the same command later.
# X11 sessions don't need any of this.
FO76_APPID="1151340"

print_cursor_manual_steps() {
  cat <<'MAN'
    To enable the in-game mouse-lock by hand (community-standard method):
      1. Install protontricks: pacman -S protontricks (Arch/CachyOS) / dnf install
         protontricks (Fedora) / pipx install protontricks (Debian/Ubuntu).
      2. Run:  protontricks 1151340 grabfullscreen=y
         (GUI equivalent: protontricks 1151340 winecfg -> Input tab -> tick
          "Automatically capture the mouse in full-screen windows".)
      3. For Borderless-Windowed too, also run:
         protontricks 1151340 -c 'wine reg add "HKCU\Software\Wine\X11 Driver" /v GrabPointer /t REG_SZ /d Y /f && wineserver -w'
      4. Launch Fallout 76 (Fullscreen or Borderless-Windowed).
MAN
}

# Ensure protontricks is runnable; echo the invocation ("protontricks" or the flatpak
# command) on success, or nothing. Best-effort auto-install from the distro/pipx.
ensure_protontricks() {
  command -v protontricks >/dev/null 2>&1 && { printf 'protontricks'; return 0; }
  if command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm protontricks >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y protontricks >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    command -v pipx >/dev/null 2>&1 || sudo apt-get install -y pipx >/dev/null 2>&1 || true
    command -v pipx >/dev/null 2>&1 && pipx install protontricks >/dev/null 2>&1 || true
  elif command -v pipx >/dev/null 2>&1; then
    pipx install protontricks >/dev/null 2>&1 || true
  fi
  export PATH="$HOME/.local/bin:$PATH"
  command -v protontricks >/dev/null 2>&1 && { printf 'protontricks'; return 0; }
  if command -v flatpak >/dev/null 2>&1 && flatpak info com.github.Matoking.protontricks >/dev/null 2>&1; then
    printf 'flatpak run com.github.Matoking.protontricks'; return 0
  fi
  return 1
}

apply_fo76_cursor_lock() {
  if ps -A -o comm= 2>/dev/null | grep -qix 'Fallout76.exe'; then
    warn "In-game cursor lock: Fallout 76 is running. Close it and re-run this installer, or use the tray button."
    print_cursor_manual_steps; return 0
  fi
  local PT
  PT="$(ensure_protontricks)" || {
    warn "In-game cursor lock: protontricks isn't installed (and couldn't be auto-installed)."
    print_cursor_manual_steps; return 0
  }
  say "Enabling the in-game cursor lock via protontricks (grabfullscreen)…"
  local out=""
  if [ -n "${DISPLAY:-}" ]; then
    out="$($PT "$FO76_APPID" grabfullscreen=y 2>&1)" || true
  elif command -v xvfb-run >/dev/null 2>&1; then
    out="$(xvfb-run -a $PT "$FO76_APPID" grabfullscreen=y 2>&1)" || true
  else
    out="__nodisplay__"
  fi
  if printf '%s' "$out" | grep -qiE 'No Proton|not found|No installed|Steam is not|could not find'; then
    warn "In-game cursor lock: couldn't reach Fallout 76's Proton prefix — launch the game once via Steam,"
    warn "then re-run this installer (or use the overlay tray -> \"Fix in-game cursor lock (Wayland)\")."
    print_cursor_manual_steps; return 0
  fi
  if [ "$out" = "__nodisplay__" ]; then
    warn "In-game cursor lock: no display available to run protontricks from this context."
    print_cursor_manual_steps; return 0
  fi
  # Also set GrabPointer so the lock holds in Borderless-Windowed (no winetricks verb
  # exists for it). `wineserver -w` forces user.reg to flush before wine lingers.
  local ptr='wine reg add "HKCU\Software\Wine\X11 Driver" /v GrabPointer /t REG_SZ /d Y /f && wineserver -w'
  if [ -n "${DISPLAY:-}" ]; then
    $PT -c "$ptr" "$FO76_APPID" >/dev/null 2>&1 || true
  elif command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a $PT -c "$ptr" "$FO76_APPID" >/dev/null 2>&1 || true
  fi
  say "Enabled the in-game cursor lock for Fallout 76 (protontricks: GrabFullscreen + GrabPointer). Works in Fullscreen and Borderless — relaunch FO76."
}

command -v curl >/dev/null 2>&1 || die "curl is required."

# --- Resolve the latest AppImage filename from the release API ----------------
# GET /api/releases returns { "data": [...] } newest-first.  data[0].version is
# the latest release version. We reconstruct the raw AppImage filename from it
# using the same convention as the release pipeline: productName "Fallout Chat
# Mod" WITH spaces, then URL-encode for the download URL.
say "Looking up the latest version..."
API_JSON="$(curl -fsSL "$API_URL")" || die "Could not reach the release API ($API_URL)."
# Extract the first (latest) version value from the JSON without requiring jq/python.
# The JSON has the form: {"data":[{"version":"1.2.3",...},...]}.
# IMPORTANT: grep reads the WHOLE response and we pick the first match with pure-bash
# parameter expansion. Do NOT pipe grep into `head` (or `sed …;q`): the /api/releases
# payload is large (100s of matches), so the early pipe close sends grep SIGPIPE and,
# under `set -o pipefail` + `set -e`, intermittently aborts the installer at version
# lookup (flaky 141 exit) — i.e. the installer would fail to patch for many users.
VERSION_MATCHES="$(printf '%s\n' "$API_JSON" | grep -o '"version":"[^"]*"')" || true
VERSION="${VERSION_MATCHES%%$'\n'*}"   # first line = latest release
VERSION="${VERSION#\"version\":\"}"      # strip the leading "version":" prefix
VERSION="${VERSION%\"}"                   # strip the trailing quote
[ -n "$VERSION" ] || die "Could not parse the version from the release API response."
say "Latest version: $VERSION"

# --- Already installed? Compare and (if already current) prompt ---------------
# We record the installed version in $APP_DIR/.fcm-version on every install.
#   not installed / installed < latest -> upgrade (fast-forwards from any version)
#   installed >= latest (already current) -> ask: reinstall or cancel
VERSION_MARKER="$APP_DIR/.fcm-version"
INSTALLED=""
if [ -f "$VERSION_MARKER" ] && [ -f "$APP_PATH" ]; then
  INSTALLED="$(tr -d '[:space:]' < "$VERSION_MARKER" 2>/dev/null || true)"
fi
if [ -n "$INSTALLED" ]; then
  # "higher of the two" via version sort; if it equals INSTALLED, installed >= latest.
  HIGHER="$(printf '%s\n%s\n' "$INSTALLED" "$VERSION" | sort -V | tail -n1)"
  if [ "$INSTALLED" = "$VERSION" ] || [ "$HIGHER" = "$INSTALLED" ]; then
    say "You are already on the latest version (v$INSTALLED)."
    ans="c"
    # Detect a USABLE controlling terminal by actually opening /dev/tty. `[ -r /dev/tty ]`
    # is not enough: the device node passes the readability test even with no controlling
    # terminal (e.g. `curl | bash </dev/null`, CI, systemd), and the subsequent open then
    # fails with ENXIO ("No such device or address"), aborting under `set -e`. With a real
    # `curl | bash` from a terminal the controlling tty exists, so the prompt still works.
    if { : >/dev/tty; } 2>/dev/null; then
      printf '\033[1;33m?? \033[0m Reinstall (uninstall + reinstall) or cancel? [r/C] ' > /dev/tty
      read -r ans < /dev/tty || ans="c"
    else
      warn "Non-interactive (piped) — cancelling. Re-run in a terminal to force a reinstall."
    fi
    case "$ans" in
      r|R|y|Y) say "Reinstalling v$VERSION…" ;;
      *) say "Cancelled — nothing changed."; exit 0 ;;
    esac
  else
    say "Installed v$INSTALLED → updating to v$VERSION."
  fi
fi

# Build the raw AppImage filename using the release pipeline convention.
APPIMAGE_NAME="Fallout Chat Mod-${VERSION}.AppImage"

# URL-encode the filename (spaces -> %20, etc.) without depending on jq/python.
urlencode() {
  local s="$1" out="" c i
  for (( i=0; i<${#s}; i++ )); do
    c="${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}
DL_URL="$BASE/$(urlencode "$APPIMAGE_NAME")"

# --- Stop any running overlay -------------------------------------------------
# Recover a broken/locked prior install: kill any running overlay so the
# AppImage file is not in use (a busy/text-busy file can fail to be replaced)
# and a crashed/broken existing build is fully swapped out. We match the overlay
# by name/path only - NEVER kill Fallout76 (the game).
say "Closing any running Fallout Chat Mod overlay so it can be replaced…"
pkill -f "Fallout Chat Mod.AppImage" 2>/dev/null || true
pkill -f "$APP_PATH" 2>/dev/null || true
# Give the process a moment to release the file before we overwrite it.
sleep 1 2>/dev/null || true

# --- Download -----------------------------------------------------------------
mkdir -p "$APP_DIR" "$DESKTOP_DIR" "$ICON_DIR"
say "Downloading $APPIMAGE_NAME …"
TMP="$(mktemp "${TMPDIR:-/tmp}/fcm.XXXXXX.AppImage")"
curl -fSL --progress-bar "$DL_URL" -o "$TMP" || die "Download failed ($DL_URL)."
# Sanity: a real AppImage is many MB; an error page is tiny.
SIZE="$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP")"
[ "${SIZE:-0}" -gt 1000000 ] || { rm -f "$TMP"; die "Downloaded file is only ${SIZE} bytes — feed/CDN problem."; }
chmod +x "$TMP"
mv -f "$TMP" "$APP_PATH"
# Record the installed version so a later re-run can detect "already current".
printf '%s\n' "$VERSION" > "$VERSION_MARKER" 2>/dev/null || true
say "Installed v$VERSION to: $APP_PATH"

# --- Icon (best-effort: extract the AppImage's own icon) ----------------------
if "$APP_PATH" --appimage-extract '*.png' >/dev/null 2>&1 && [ -d squashfs-root ]; then
  ICON_SRC="$(find squashfs-root -maxdepth 2 -name '*.png' 2>/dev/null | head -n1 || true)"
  [ -n "$ICON_SRC" ] && cp -f "$ICON_SRC" "$ICON_PATH" 2>/dev/null || true
  rm -rf squashfs-root
fi

# --- Desktop launcher ---------------------------------------------------------
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Fallout Chat Mod
Comment=Community chat overlay for Fallout 76
Exec="$APP_PATH" %U
Icon=${ICON_PATH}
Terminal=false
Categories=Game;Network;Chat;
StartupWMClass=fallout-chat-mod
EOF
chmod +x "$DESKTOP_FILE"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
say "Created app-menu launcher (Fallout Chat Mod)."

# Auto-start on login (parity with Windows/macOS start-on-login) so users don't
# have to open the overlay by hand each session. Copy the launcher into the XDG
# autostart dir. Remove ~/.config/autostart/fallout-chat-mod.desktop to opt out.
AUTOSTART_DIR="$CONFIG_HOME/autostart"
mkdir -p "$AUTOSTART_DIR"
cp -f "$DESKTOP_FILE" "$AUTOSTART_DIR/fallout-chat-mod.desktop" 2>/dev/null || true
say "Enabled auto-start on login (remove $AUTOSTART_DIR/fallout-chat-mod.desktop to disable)."

# --- Drop the README + KWin rule next to the app -----------------------------
# So CLI users get the same docs as the zip download. (The app ALSO writes these
# into ~/.config/Fallout Chat Mod on first launch, but writing them here means
# they're visible immediately, before first run.)
README_PATH="$APP_DIR/INSTALL-LINUX.txt"
KWINRULE_PATH="$APP_DIR/fallout-chatmod-keepabove.kwinrule"

cat > "$KWINRULE_PATH" <<'EOF'
[Fallout Chat Mod - keep above games]
Description=Fallout Chat Mod - keep above games
wmclass=fallout-chat-mod
wmclassmatch=2
wmclasscomplete=false
above=true
aboverule=3

# Keep the GAME below - the no-flicker fix for "overlay hidden behind a focused
# fullscreen game". KWin evaluates keepBelow BEFORE the active-fullscreen promotion, so
# the overlay (rule above) stays above a focused fullscreen FO76 with NO flicker.
# Side effect: the game can be covered by the panel/other windows. Turn off via the app
# tray -> "Keep game below overlay".
[Fallout Chat Mod - keep game below]
Description=Fallout Chat Mod - keep game below
wmclass=steam_app_1151340
wmclassmatch=2
wmclasscomplete=false
below=true
belowrule=2
EOF

cat > "$README_PATH" <<EOF
Fallout Chat Mod — installed via the CLI installer
===================================================
App:       $APP_PATH
Launcher:  $DESKTOP_FILE  (also in your application menu as "Fallout Chat Mod")

Using the overlay
- Run Fallout 76 in BORDERLESS WINDOWED (not exclusive fullscreen).
- The overlay shows automatically while Fallout 76 is running (detected under
  Proton). With the game closed it stays hidden by design.
- Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com.

KDE Plasma (Wayland) — automatic
- On first launch the overlay forces XWayland and installs two KWin rules so it
  stays above Fallout 76 even while the game is focused. No manual step needed.
- If it somehow ends up BEHIND the game, import the bundled rule (this folder):
  $KWINRULE_PATH
    1. System Settings -> Window Management -> Window Rules -> Import...
    2. Select fallout-chatmod-keepabove.kwinrule
    3. Apply, then: qdbus org.kde.KWin /KWin reconfigure   (or log out/in)
  Or use the app tray menu -> "KDE: keep overlay above game".
- The uninstaller removes these KWin rules (restores FO76's fullscreen stacking).

In-game cursor lock (Wayland)
- On Wayland the compositor drops Fallout 76's mouse-lock when the overlay sits on
  top, so the cursor can drift off the game. THIS INSTALLER enables it via protontricks:
  the "grabfullscreen=y" winetricks verb (Fullscreen) PLUS a GrabPointer reg add
  (Borderless-Windowed), so the cursor stays locked in either display mode. No Wine
  config is hand-edited. protontricks is auto-installed if missing.
- It can only do this if Fallout 76's Proton prefix already exists (you've launched
  the game at least once) and FO76 is closed. If not, the installer prints the manual
  steps -- or just use the overlay tray -> "Fix in-game cursor lock (Wayland)" after
  you've run FO76 once. X11 sessions don't need any of this.
- Manual method: protontricks 1151340 grabfullscreen=y  and  protontricks 1151340 -c
  'wine reg add "HKCU\Software\Wine\X11 Driver" /v GrabPointer /t REG_SZ /d Y /f &&
  wineserver -w'  (GUI equivalent of the first: protontricks 1151340 winecfg -> "Input"
  tab -> tick "Automatically capture the mouse in full-screen windows"). Then run FO76.

Do NOT run the game inside gamescope for overlay purposes — its nested
compositor isolates the game and no external overlay can draw over it.

Troubleshooting — "it launched once, now the shortcut does nothing"
- This is almost always AppImageLauncher and/or a missing libfuse2:
  * AppImageLauncher's "Integrate AppImage and run" moves the AppImage and makes
    its own shortcut, which conflicts with this installer. Use ONE method. To
    recover: remove the AppImageLauncher integration, then re-run this installer.
  * A type-2 AppImage needs libfuse2 (libfuse.so.2). Fedora ships only fuse3 by
    default. Install it (Fedora: sudo dnf install fuse-libs; Debian/Ubuntu:
    sudo apt install libfuse2), OR — recommended on Fedora/Debian/Ubuntu — use the
    .deb instead of the AppImage (no FUSE, no AppImageLauncher):
      download "Fallout Chat Mod <ver>.deb" from https://falloutchatmod.com, then
      sudo apt install ./'Fallout Chat Mod'*.deb   (or: sudo dnf install ./*.deb)

Optional — release hotkeys when you tab out (KDE Wayland)
- Install kdotool (recommended on Wayland) or xdotool so the overlay's hotkeys
  (Insert/Delete/Home) are released when you switch to Konsole/Discord. Without
  it they stay registered for the whole game session (still works fine).

Uninstall:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash
Support:    https://falloutchatmod.com
EOF
say "Wrote setup notes + KDE rule to: $APP_DIR"

# --- FUSE check ---------------------------------------------------------------
# A type-2 AppImage needs libfuse2 (libfuse.so.2) to mount itself. Fedora and some
# other modern distros ship only fuse3 by default, so the AppImage "launches once
# then the shortcut does nothing" (issue #272). Steer those users to the .deb.
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  warn "libfuse2 (libfuse.so.2) not detected — a type-2 AppImage needs it to launch."
  warn "On Fedora/Debian/Ubuntu the .deb package is the more reliable option (no FUSE):"
  warn "  download \"Fallout Chat Mod <ver>.deb\" from https://falloutchatmod.com and"
  warn "  install with:  sudo apt install ./'Fallout Chat Mod'*.deb   (or: sudo dnf install ./*.deb)"
  warn "Otherwise install libfuse2 (Fedora: sudo dnf install fuse-libs; Debian/Ubuntu:"
  warn "  sudo apt install libfuse2), or run the AppImage with: \"$APP_PATH\" --appimage-extract-and-run"
fi

# --- AppImageLauncher conflict note -------------------------------------------
# AppImageLauncher's "Integrate AppImage and run" MOVES the AppImage and rewrites
# its own .desktop, which double-installs against this installer and leaves a
# shortcut that fails on the next launch (issue #272). Pick ONE method.
if command -v AppImageLauncher >/dev/null 2>&1 || [ -e "$CONFIG_HOME/appimagelauncher.cfg" ]; then
  warn "AppImageLauncher detected. Do NOT use its \"Integrate AppImage and run\" prompt"
  warn "for this app — it conflicts with this installer's launcher and can leave a"
  warn "shortcut that won't relaunch. Use the application-menu entry this installer"
  warn "created (or the .deb). If a shortcut has already broken, remove the"
  warn "AppImageLauncher integration and re-run this installer."
fi

# --- KDE / Wayland note -------------------------------------------------------
DESKTOP_ENV="$(printf '%s' "${XDG_CURRENT_DESKTOP:-}" | tr 'A-Z' 'a-z')"
SESSION_TYPE="$(printf '%s' "${XDG_SESSION_TYPE:-}" | tr 'A-Z' 'a-z')"
if printf '%s' "$DESKTOP_ENV" | grep -q 'kde\|plasma' && [ "$SESSION_TYPE" = "wayland" ]; then
  echo
  say "KDE Plasma on Wayland detected — the overlay configures itself on first launch"
  say "(forces XWayland + installs KWin rules so it stays above the game)."
  # Install-time OPTION: the "keep game below overlay" KWin rule keeps the chat visible
  # over a focused fullscreen game (the no-flicker fix). Default ON. Forcing the game
  # below also lets the panel/other windows cover it, so offer to opt out. We only WRITE
  # the setting for a FRESH install (no overlay-state.json yet) to avoid touching an
  # existing user's state — otherwise the app default (on) applies and the tray toggle
  # ("Keep game below overlay") is the control.
  STATE_DIR="$CONFIG_HOME/Fallout Chat Mod"
  STATE_FILE="$STATE_DIR/overlay-state.json"
  ANS=""
  # Detect a USABLE controlling terminal by actually opening /dev/tty (a bare
  # `[ -r /dev/tty ]` is true even when piped with no tty → read would hang/EOF).
  if { : >/dev/tty; } 2>/dev/null; then
    printf '%s ' "==> Keep the game BELOW the overlay so chat stays visible over a fullscreen game? (recommended) [Y/n]" > /dev/tty
    read -r ANS < /dev/tty 2>/dev/null || ANS=""
  fi
  case "$ANS" in
    [Nn]*)
      if [ ! -e "$STATE_FILE" ]; then
        mkdir -p "$STATE_DIR" 2>/dev/null || true
        printf '%s\n' '{"settings":{"kwinGameBelow":false}}' > "$STATE_FILE" 2>/dev/null \
          && say "Disabled 'keep game below' (you can re-enable it in the tray menu)." \
          || warn "Could not write the setting; toggle it in the tray menu after launch."
      else
        say "Existing settings found — leaving them. Toggle 'Keep game below overlay' in the tray menu if you want it off."
      fi
      ;;
    *) say "'Keep game below overlay' will be ON (toggle it off any time in the tray menu)." ;;
  esac
  say "Run Fallout 76 in BORDERLESS WINDOWED. If chat ever shows BEHIND the game, check the"
  say "tray menu -> \"Keep game below overlay\" / \"KDE: keep overlay above game\"."
fi

# In-game cursor lock — any Wayland session (X11 doesn't need it).
if [ "$SESSION_TYPE" = "wayland" ]; then
  echo
  apply_fo76_cursor_lock
fi

echo
say "Done. Launch \"Fallout Chat Mod\" from your application menu, then sign in"
say "with Discord."
say "Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com."
say "Uninstall any time:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash"
