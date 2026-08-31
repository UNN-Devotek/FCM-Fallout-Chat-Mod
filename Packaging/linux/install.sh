#!/usr/bin/env bash
#
# Fallout Chat Mod — Linux installer
#
#   curl -fsSL https://falloutchatmod.com/install.sh | bash
#
# Detects the host distro/session/capabilities, then chooses a safe install path:
# a per-user AppImage, AppImage extract-and-run when FUSE2 is unavailable, or an
# explicitly confirmed Debian-family .deb install. It registers a desktop launcher
# + icon and prints compositor/helper setup notes.
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

INSTALL_FORMAT="auto"
PRINT_PLAN=0

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

while [ "$#" -gt 0 ]; do
  case "$1" in
    --format=auto|--format=appimage|--format=deb) INSTALL_FORMAT="${1#*=}"; shift ;;
    --format)
      [ "$#" -ge 2 ] || die "--format requires auto, appimage, or deb."
      case "$2" in auto|appimage|deb) INSTALL_FORMAT="$2" ;; *) die "--format requires auto, appimage, or deb." ;; esac
      shift 2
      ;;
    --help|-h)
      printf '%s\n' 'Usage: install.sh [--format auto|appimage|deb]' \
        '  auto      detect the safest supported path (default)' \
        '  appimage  install the per-user AppImage' \
        '  deb       offer the Debian-family package (requires apt and explicit sudo consent)' \
        '  --print-plan  detect the host and print the selected path without downloading'
      exit 0
      ;;
    --print-plan) PRINT_PLAN=1; shift ;;
    *) die "Unknown option: $1 (use --help)." ;;
  esac
done

# --- Detect the host without installing or elevating anything ----------------
OS_ID="unknown"
OS_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-}"
fi
OS_ID="$(printf '%s' "$OS_ID" | tr 'A-Z' 'a-z')"
OS_LIKE="$(printf '%s' "$OS_LIKE" | tr 'A-Z' 'a-z')"
DISTRO_TOKENS=" $OS_ID $OS_LIKE "
DISTRO_FAMILY="other"
case "$DISTRO_TOKENS" in
  *debian*|*ubuntu*|*linuxmint*|*pop*|*elementary*|*zorin*) DISTRO_FAMILY="debian" ;;
  *fedora*|*rhel*|*centos*|*rocky*|*almalinux*) DISTRO_FAMILY="fedora" ;;
  *arch*|*manjaro*|*cachyos*|*endeavouros*) DISTRO_FAMILY="arch" ;;
esac

DESKTOP_ENV="$(printf '%s' "${XDG_CURRENT_DESKTOP:-}" | tr 'A-Z' 'a-z')"
SESSION_TYPE="$(printf '%s' "${XDG_SESSION_TYPE:-unknown}" | tr 'A-Z' 'a-z')"
COMPOSITOR="other"
if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || printf '%s' "$DESKTOP_ENV" | grep -q 'hyprland'; then
  COMPOSITOR="hyprland"
elif printf '%s' "$DESKTOP_ENV" | grep -q 'kde\|plasma'; then
  COMPOSITOR="kde"
fi

PACKAGE_MANAGER="none"
if command -v apt-get >/dev/null 2>&1; then PACKAGE_MANAGER="apt";
elif command -v dnf >/dev/null 2>&1; then PACKAGE_MANAGER="dnf";
elif command -v pacman >/dev/null 2>&1; then PACKAGE_MANAGER="pacman";
elif command -v zypper >/dev/null 2>&1; then PACKAGE_MANAGER="zypper";
fi

FUSE2_AVAILABLE=0
if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  FUSE2_AVAILABLE=1
elif [ -e /lib/libfuse.so.2 ] || [ -e /lib64/libfuse.so.2 ] || [ -e /usr/lib/libfuse.so.2 ] || [ -e /usr/lib64/libfuse.so.2 ]; then
  FUSE2_AVAILABLE=1
fi

has_command() { command -v "$1" >/dev/null 2>&1; }
KDTOOL_AVAILABLE=0; has_command kdotool && KDTOOL_AVAILABLE=1
XDOTOOL_AVAILABLE=0; has_command xdotool && XDOTOOL_AVAILABLE=1
HYPRCTL_AVAILABLE=0; has_command hyprctl && HYPRCTL_AVAILABLE=1
PROTONTRICKS_AVAILABLE=0; has_command protontricks && PROTONTRICKS_AVAILABLE=1
KWIN_TOOLS_AVAILABLE=0
if has_command kwriteconfig6 && has_command kreadconfig6; then KWIN_TOOLS_AVAILABLE=1; fi

APPIMAGE_EXEC_ARGS=""
DEB_SELECTED=0
if [ "$INSTALL_FORMAT" = "deb" ]; then
  [ "$DISTRO_FAMILY" = "debian" ] || die "--format deb is only supported on Debian-family systems (detected: $OS_ID)."
  has_command apt-get || die "--format deb requires apt-get on this Debian-family system; re-run with --format appimage."
  DEB_SELECTED=1
elif [ "$INSTALL_FORMAT" = "auto" ] && [ "$FUSE2_AVAILABLE" -eq 0 ] && [ "$DISTRO_FAMILY" = "debian" ] && has_command apt-get; then
  # A .deb is the native no-FUSE path on Debian-family systems, but installing it
  # changes system package state, so it is always an explicit user choice.
  DEB_SELECTED=2
else
  [ "$FUSE2_AVAILABLE" -eq 1 ] || APPIMAGE_EXEC_ARGS="--appimage-extract-and-run"
fi

say "Detected: $OS_ID ($DISTRO_FAMILY), session=$SESSION_TYPE, compositor=$COMPOSITOR, package-manager=$PACKAGE_MANAGER"
if [ "$COMPOSITOR" = "kde" ] && [ "$SESSION_TYPE" = "wayland" ]; then
  if [ "$KWIN_TOOLS_AVAILABLE" -eq 1 ]; then say "KDE rule tools detected (kwriteconfig6/kreadconfig6)."; else warn "KDE rule tools not found; automatic KWin stacking will retry/fail closed."; fi
  if [ "$KDTOOL_AVAILABLE" -eq 1 ]; then say "kdotool detected for Wayland foreground detection."; else warn "kdotool not found; hotkeys may remain registered while you alt-tab."; fi
elif [ "$COMPOSITOR" = "hyprland" ]; then
  if [ "$HYPRCTL_AVAILABLE" -eq 1 ]; then say "hyprctl detected for Hyprland foreground and stacking control."; else warn "hyprctl not found; Hyprland stacking will remain ordinary."; fi
elif [ "$SESSION_TYPE" = "x11" ] && [ "$XDOTOOL_AVAILABLE" -eq 0 ]; then
  warn "xdotool not found; X11 foreground-aware hotkey release will be unavailable."
fi
if [ "$SESSION_TYPE" = "wayland" ]; then
  if [ "$PROTONTRICKS_AVAILABLE" -eq 1 ]; then
    say "protontricks detected for the optional Fallout 76 cursor-lock setup."
  else
    warn "protontricks not found; the optional Fallout 76 cursor-lock setup requires a manual install."
  fi
fi

if [ "$PRINT_PLAN" -eq 1 ]; then
  if [ "$DEB_SELECTED" -eq 1 ]; then
    say "Plan: install the Debian package (explicit apt/sudo confirmation required)."
  elif [ "$DEB_SELECTED" -eq 2 ]; then
    say "Plan: offer the Debian package; decline falls back to AppImage extract-and-run."
  elif [ -n "$APPIMAGE_EXEC_ARGS" ]; then
    say "Plan: install the per-user AppImage with $APPIMAGE_EXEC_ARGS."
  else
    say "Plan: install the per-user AppImage using native FUSE2."
  fi
  exit 0
fi

# --- In-game cursor lock (Wayland) is a Proton/Wine concern -------------------
# On Wayland the compositor drops Fallout 76's mouse-lock when the overlay sits on
# top, so the cursor can drift off the game. Fixing this means enabling Wine's own
# mouse capture inside FO76's Proton prefix — outside this mod's scope. This
# installer never touches the game/Proton prefix; it only prints the manual,
# community-standard steps below as a one-time tip. X11 sessions don't need it.

print_cursor_manual_steps() {
  cat <<'MAN'
    To enable the in-game mouse-lock by hand (community-standard method):
      1. Recommended: run Fallout 76 on the latest Proton 11.x available in
         Steam (Fallout 76 -> Properties -> Compatibility -> Force the use of
         a specific Steam Play compatibility tool -> pick the newest Proton
         11.x), or a well-maintained community build like Proton-CachyOS or
         GE-Proton (install via ProtonUp-Qt). Newer Wine/DXVK builds are more
         reliable at persisting the settings below.
      2. Install protontricks: pacman -S protontricks (Arch/CachyOS) / dnf install
         protontricks (Fedora) / pipx install protontricks (Debian/Ubuntu).
      3. Run:  protontricks 1151340 grabfullscreen=y
         (GUI equivalent: protontricks 1151340 winecfg -> Input tab -> tick
          "Automatically capture the mouse in full-screen windows".)
      4. For Borderless-Windowed too, also run:
         protontricks 1151340 -c 'wine reg add "HKCU\Software\Wine\X11 Driver" /v GrabPointer /t REG_SZ /d Y /f && wineserver -w'
      5. Launch Fallout 76 (Fullscreen or Borderless-Windowed).
MAN
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
DEB_NAME="Fallout Chat Mod-${VERSION}.deb"
DEB_URL="$BASE/$(urlencode "$DEB_NAME")"

# In auto mode, offer the native Debian package only when it solves a detected
# AppImage problem. The offer is interactive and never invokes sudo silently;
# non-interactive callers use the no-root extract-and-run fallback instead.
if [ "$DEB_SELECTED" -eq 2 ]; then
  DEB_SELECTED=0
  if { : >/dev/tty; } 2>/dev/null; then
    printf '\033[1;33m?? \033[0m AppImage FUSE support is unavailable. Install the Debian package instead? [Y/n] ' > /dev/tty
    DEB_ANSWER="y"
    read -r DEB_ANSWER < /dev/tty || DEB_ANSWER="y"
    case "$DEB_ANSWER" in n|N|no|NO) APPIMAGE_EXEC_ARGS="--appimage-extract-and-run" ;; *) DEB_SELECTED=1 ;; esac
  else
    APPIMAGE_EXEC_ARGS="--appimage-extract-and-run"
    warn "No controlling terminal; using AppImage --appimage-extract-and-run instead of changing system packages."
  fi
fi

if [ "$DEB_SELECTED" -eq 1 ]; then
  has_command sudo || die "sudo is required to install the .deb; re-run with --format appimage for a per-user install."
  say "Downloading $DEB_NAME …"
  DEB_TMP="$(mktemp "${TMPDIR:-/tmp}/fcm.XXXXXX.deb")"
  curl -fSL --progress-bar "$DEB_URL" -o "$DEB_TMP" || { rm -f "$DEB_TMP"; die "Download failed ($DEB_URL)."; }
  DEB_SIZE="$(stat -c%s "$DEB_TMP" 2>/dev/null || stat -f%z "$DEB_TMP")"
  [ "${DEB_SIZE:-0}" -gt 1000000 ] || { rm -f "$DEB_TMP"; die "Downloaded .deb is only ${DEB_SIZE} bytes — feed/CDN problem."; }
  say "Installing the Debian package. apt/sudo will show its normal confirmation prompts."
  sudo apt-get install "$DEB_TMP" || { rm -f "$DEB_TMP"; die "The .deb installation failed."; }
  rm -f "$DEB_TMP"
  say "Installed v$VERSION from $DEB_NAME."
  say "The package manager owns this install; update with --format deb or remove it with your package manager."
  exit 0
fi

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
DESKTOP_EXEC="\"$APP_PATH\"${APPIMAGE_EXEC_ARGS:+ $APPIMAGE_EXEC_ARGS} %U"
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
Exec=$DESKTOP_EXEC
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
# ONE rule on the OVERLAY window (wmclass=fallout-chat-mod): keep-above
# (above=true, belt-and-suspenders) plus force-Layer (layer=overlay, Force),
# the KWin-6 fix (KDE Bug 441074) for "overlay hidden behind a focused
# fullscreen game". Sits above the active-fullscreen game WITHOUT demoting
# it, so FO76 keeps normal fullscreen stacking and the overlay keeps
# keyboard focus. The game is never "kept below" either; that would also
# drop it under the taskbar.
[Fallout Chat Mod - keep above games]
Description=Fallout Chat Mod - keep above games
wmclass=fallout-chat-mod
wmclassmatch=2
wmclasscomplete=false
above=true
aboverule=3
layer=overlay
layerrule=2
EOF

cat > "$README_PATH" <<EOF
Fallout Chat Mod — installed via the CLI installer
===================================================
App:       $APP_PATH
Launcher:  $DESKTOP_FILE  (also in your application menu as "Fallout Chat Mod")
Detected:  $OS_ID ($DISTRO_FAMILY), session=$SESSION_TYPE, compositor=$COMPOSITOR
Run mode:  AppImage${APPIMAGE_EXEC_ARGS:+ with $APPIMAGE_EXEC_ARGS}

Using the overlay
- Run Fallout 76 in BORDERLESS WINDOWED (not exclusive fullscreen).
- The overlay shows automatically while Fallout 76 is running (detected under
  Proton). With the game closed it stays hidden by design.
- Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com.

Automatic desktop/session detection
- The installer and overlay detect the Linux session and compositor automatically.
  There is no desktop-environment switch to select. Each path fails closed and
  keeps the normal game-running fallback if its helper is unavailable.
- KDE Plasma + Wayland: forces XWayland and installs one KWin rule only while
  Fallout 76 runs on the same display. The rule combines keep-above with KWin's
  Overlay layer without demoting the game, then is removed on game exit or a
  monitor change. Run Fallout 76 in Borderless Windowed mode.
- Hyprland: uses hyprctl for focus, same-output detection, and pinning. This path
  is best-effort and has not been verified on real Hyprland hardware; missing or
  failing hyprctl logs a diagnostic and leaves ordinary stacking plus the Linux
  heartbeat fallback.
- Plain X11: xdotool is preferred (kdotool is the fallback) for hide-on-alt-tab
  and hotkey release. Without either tool, the game-running fallback remains.
- GNOME or other non-KDE Wayland: no KWin or Hyprland rule is applied. If the
  overlay will not stay above the game, use this Fallout 76 Steam launch option:
    PROTON_NO_WM_DECORATION=1 %command%
  KDE users must not use that option; use the KWin rule above instead.

KDE Plasma (Wayland) — automatic
- On first launch the overlay forces XWayland. While FO76 runs and the overlay
  shares its display, it installs one KWin rule (fcm-keepabove: above=true +
  layer=overlay/layerrule=2) so it stays above Fallout 76 even while focused.
  No manual step needed. Removed automatically on FO76 exit or a monitor change.
- If it somehow ends up BEHIND the game, import the bundled rule (this folder):
  $KWINRULE_PATH
    1. System Settings -> Window Management -> Window Rules -> Import...
    2. Select fallout-chatmod-keepabove.kwinrule
    3. Apply, then: qdbus org.kde.KWin /KWin reconfigure   (or log out/in)
- The uninstaller removes this KWin rule (restores FO76's fullscreen stacking).

In-game cursor lock (Wayland) — manual, self-service step
- On Wayland the compositor drops Fallout 76's mouse-lock when the overlay sits on
  top, so the cursor can drift off the game. This mod never modifies FO76's
  Proton/Wine prefix, so enabling Wine's own mouse capture is a step you apply
  yourself via protontricks (community-standard method) -- X11 sessions don't
  need it.
- Recommended: run FO76 on the latest Proton 11.x in Steam (Properties ->
  Compatibility -> Force the use of a specific Steam Play compatibility tool),
  or a well-maintained build like Proton-CachyOS or GE-Proton.
- Install protontricks: pacman -S protontricks (Arch/CachyOS) / dnf install
  protontricks (Fedora) / pipx install protontricks (Debian/Ubuntu).
- Then run: protontricks 1151340 grabfullscreen=y  and  protontricks 1151340 -c
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
  * A type-2 AppImage needs libfuse2 (libfuse.so.2). This install is configured to
    use --appimage-extract-and-run when FUSE2 is unavailable, so it remains a
    per-user install without sudo. It is slower because it extracts on launch.
    On Debian-family systems you can instead run with --format deb to use the
    native package (no FUSE, but apt/sudo owns the install):
      download "Fallout Chat Mod <ver>.deb" from https://falloutchatmod.com, then
      sudo apt install ./'Fallout Chat Mod'*.deb   (or: sudo dnf install ./*.deb)

Optional — release hotkeys when you tab out (KDE Wayland)
- Install kdotool (Arch/CachyOS: paru -S kdotool [AUR]; Fedora: sudo dnf install
  kdotool) so the overlay's hotkeys (Insert/Delete/Home) are released when you
  switch to Konsole/Discord. It is preferred on KDE Wayland because it sees
  native-Wayland windows. xdotool is the fallback there; on plain X11, xdotool
  is preferred and kdotool is the fallback. Without either tool they stay
  registered for the whole game session (still works fine).

Uninstall:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash
Support:    https://falloutchatmod.com
EOF
say "Wrote setup notes + KDE rule to: $APP_DIR"

# --- FUSE result --------------------------------------------------------------
# A type-2 AppImage needs libfuse2 (libfuse.so.2) to mount itself. If it is absent,
# the selected launcher uses --appimage-extract-and-run, which avoids package
# changes and still works on Fedora, Arch, and other non-Debian systems.
if [ "$FUSE2_AVAILABLE" -eq 0 ]; then
  warn "libfuse2 (libfuse.so.2) not detected — a type-2 AppImage needs it to launch."
  warn "Using the no-root fallback: \"$APP_PATH\" --appimage-extract-and-run"
  if [ "$DISTRO_FAMILY" = "debian" ]; then
    warn "For a native package-managed install, re-run with: $0 --format deb"
  elif [ "$DISTRO_FAMILY" = "fedora" ]; then
    warn "If preferred, install FUSE2 with your distro's fuse-libs package and re-run."
  fi
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
if printf '%s' "$DESKTOP_ENV" | grep -q 'kde\|plasma' && [ "$SESSION_TYPE" = "wayland" ]; then
  echo
  say "KDE Plasma on Wayland detected — the overlay configures itself on first launch"
  say "(forces XWayland + one KWin rule, fcm-keepabove, installed while FO76 runs"
  say "on the same display as the overlay)."
  say "The overlay is placed in KWin's Overlay layer, so it shows above Fallout 76 WITHOUT"
  say "demoting the game — FO76 keeps normal fullscreen stacking (above the panel). If chat"
  say "ever shows BEHIND the game, import the bundled .kwinrule by hand via System Settings"
  say "-> Window Rules -> Import."
  say ""
  say "TIP: install kdotool (AUR: paru -S kdotool) so the overlay releases its hotkeys"
  say "when you tab to another app while the game runs. xdotool also works, but it"
  say "cannot see native-Wayland windows (keys may stay captured in Konsole/Firefox)."
fi

# In-game cursor lock is a Proton/Wine concern this installer never automates —
# print the manual steps once as a tip, on Wayland sessions only (X11 doesn't need it).
if [ "$SESSION_TYPE" = "wayland" ]; then
  echo
  print_cursor_manual_steps
fi

echo
say "Done. Launch \"Fallout Chat Mod\" from your application menu, then sign in"
say "with Discord."
say "Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com."
say "Uninstall any time:  curl -fsSL https://falloutchatmod.com/uninstall.sh | bash"
