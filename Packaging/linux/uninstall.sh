#!/usr/bin/env bash
#
# Fallout Chat Mod — Linux uninstaller
#   curl -fsSL https://falloutchatmod.com/uninstall.sh | bash
#
# Removes the per-user AppImage, the desktop launcher, and the icon. A .deb install
# is owned by apt/dpkg and should be removed with the package manager. By default it KEEPS
# your config/login (~/.config/Fallout Chat Mod). Pass --purge to remove that too.
#
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

# Whole install dir (AppImage + INSTALL-LINUX.txt + .kwinrule).
rm -rf "$DATA_HOME/FalloutChatMod" 2>/dev/null || true
rm -f  "$DATA_HOME/applications/fallout-chat-mod.desktop" 2>/dev/null || true
rm -f  "$CONFIG_HOME/autostart/fallout-chat-mod.desktop" 2>/dev/null || true
rm -f  "$DATA_HOME/icons/hicolor/512x512/apps/fallout-chat-mod.png" 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
say "Removed app, launcher, and icon."

# --- Remove the KWin window rules we installed (KDE only) ---------------------
# On KDE+Wayland the overlay installs ONE KWin rule (fcm-keepabove, overlay-only,
# above=true + layer=overlay/layerrule=2) while FO76 runs and shares the
# overlay's display; removed automatically on game exit or a monitor change, so
# normally nothing is left to clean up here. This block is a safety net for a
# rule left installed at quit time (crash, kill -9) or by an older build with
# different rule names/game-side rules. Matches FCM's rules by "Fallout Chat
# Mod" Description (current + legacy/numbered groups), keeps the user's own.
# Mirrors overlay-core.js buildKwinRemoveRulesScript. Best-effort: no-ops
# without the KDE config tools.
KWIN_READ_BIN=""
KWIN_WRITE_BIN=""
if command -v kreadconfig6 >/dev/null 2>&1 && command -v kwriteconfig6 >/dev/null 2>&1; then
  KWIN_READ_BIN="kreadconfig6"
  KWIN_WRITE_BIN="kwriteconfig6"
elif command -v kreadconfig5 >/dev/null 2>&1 && command -v kwriteconfig5 >/dev/null 2>&1; then
  KWIN_READ_BIN="kreadconfig5"
  KWIN_WRITE_BIN="kwriteconfig5"
fi

if [ -n "$KWIN_READ_BIN" ] && [ -n "$KWIN_WRITE_BIN" ]; then
  RULES="${XDG_CONFIG_HOME:-$HOME/.config}/kwinrulesrc"
  R="$("$KWIN_READ_BIN" --file kwinrulesrc --group General --key rules 2>/dev/null || true)"
  KEEP=""; FCM=""
  for g in $(printf '%s' "$R" | tr ',' ' '); do
    d="$("$KWIN_READ_BIN" --file kwinrulesrc --group "$g" --key Description 2>/dev/null || true)"
    case "$d" in
      "Fallout Chat Mod"*) FCM="$FCM $g" ;;
      *) KEEP="${KEEP:+$KEEP,}$g" ;;
    esac
  done
  if [ -n "$FCM" ]; then
    # Strip the FCM sections entirely by rewriting the file with awk. kwriteconfig6 CANNOT
    # delete a section (neither `--key X --delete` nor `--group G --delete` works — both
    # silently no-op), so per-key deletion left orphaned [section] cruft behind.
    awk -v drop=" $FCM " '/^\[.*\]$/{name=$0;sub(/^\[/,"",name);sub(/\]$/,"",name);skip=index(drop," " name " ")>0} !skip' "$RULES" > "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"
    "$KWIN_WRITE_BIN" --file kwinrulesrc --group General --key rules "$KEEP"
    COUNT="$(printf '%s' "$KEEP" | tr ',' '\n' | grep -c . || true)"
    "$KWIN_WRITE_BIN" --file kwinrulesrc --group General --key count "$COUNT"
    (qdbus org.kde.KWin /KWin reconfigure || qdbus6 org.kde.KWin /KWin reconfigure || qdbus-qt6 org.kde.KWin /KWin reconfigure) 2>/dev/null || true
    say "Removed Fallout Chat Mod KWin rules (KDE) — FO76 fullscreen restored."
  fi
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$CONFIG_HOME/Fallout Chat Mod" 2>/dev/null || true
  say "Purged config + login (~/.config/Fallout Chat Mod)."
else
  say "Kept your config/login. Use --purge to remove it too."
fi
say "Uninstalled."
