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

command -v curl >/dev/null 2>&1 || die "curl is required."

# --- Resolve the latest AppImage filename from the release API ----------------
# GET /api/releases returns { "data": [...] } newest-first.  data[0].version is
# the latest release version. We reconstruct the raw AppImage filename from it
# using the same convention as the release pipeline: productName "Fallout Chat
# Mod" WITH spaces, then URL-encode for the download URL.
say "Looking up the latest version..."
API_JSON="$(curl -fsSL "$API_URL")" || die "Could not reach the release API ($API_URL)."
# Extract the first version value from the JSON without requiring jq/python.
# The JSON has the form: {"data":[{"version":"1.2.3",...},...]}
VERSION="$(printf '%s\n' "$API_JSON" | grep -o '"version":"[^"]*"' | head -n1 | sed 's/"version":"//;s/"//')"
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
    if [ -r /dev/tty ]; then
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
StartupWMClass=Fallout Chat Mod
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
title=Fallout Chat Mod
titlematch=2
wmclass=fallout
wmclassmatch=2
wmclasscomplete=false
above=true
aboverule=3
layer=8
layerrule=2
fsplevel=0
fsplevelrule=2

[Fallout Chat Mod - demote game from fullscreen layer]
Description=Fallout Chat Mod - demote game from fullscreen layer
wmclass=steam_app_1151340
wmclassmatch=2
wmclasscomplete=false
fullscreen=false
fullscreenrule=2
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

Do NOT run the game inside gamescope for overlay purposes — its nested
compositor isolates the game and no external overlay can draw over it.

Uninstall:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash
Support:    https://falloutchatmod.com
EOF
say "Wrote setup notes + KDE rule to: $APP_DIR"

# --- FUSE check ---------------------------------------------------------------
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  warn "libfuse2 not detected. If the app won't launch, either install libfuse2,"
  warn "or run it with:  \"$APP_PATH\" --appimage-extract-and-run"
fi

# --- KDE / Wayland note -------------------------------------------------------
DESKTOP_ENV="$(printf '%s' "${XDG_CURRENT_DESKTOP:-}" | tr 'A-Z' 'a-z')"
SESSION_TYPE="$(printf '%s' "${XDG_SESSION_TYPE:-}" | tr 'A-Z' 'a-z')"
if printf '%s' "$DESKTOP_ENV" | grep -q 'kde\|plasma' && [ "$SESSION_TYPE" = "wayland" ]; then
  echo
  say "KDE Plasma on Wayland detected — the overlay configures itself on first launch"
  say "(forces XWayland + installs two KWin rules so it stays above the game). Just run"
  say "Fallout 76 in BORDERLESS WINDOWED. If it ever shows BEHIND the game, use the tray"
  say "menu -> \"KDE: keep overlay above game\" or import the bundled .kwinrule."
fi

echo
say "Done. Launch \"Fallout Chat Mod\" from your application menu, then sign in"
say "with Discord."
say "Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com."
say "Uninstall any time:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash"
