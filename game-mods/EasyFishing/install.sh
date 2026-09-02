#!/usr/bin/env bash
#
# EasyFishing installer for Windows Git Bash/MSYS and Linux/Steam Proton.
# The .ba2/INI installation is cross-platform; the AHK automation runtime is
# optional and is run through Protontricks on Linux.
#
set -euo pipefail
IFS=$'\n\t'

MOD_ARCHIVE_NAME="EasyFishing.ba2"
FO76_APPID="1151340"
AHK_VERSION="1.1.37.02"
AHK_URL="https://github.com/AutoHotkey/AutoHotkey/releases/download/v1.1.37.02/AutoHotkey_1.1.37.02.zip"
AHK_SHA256="6f3663f7cdd25063c8c8728f5d9b07813ced8780522fd1f124ba539e2854215f"

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
TMPBASE="$(printenv TMPDIR 2>/dev/null || true)"
[ -n "$TMPBASE" ] || TMPBASE="/tmp"
TEMP_ROOT="$(mktemp -d "$TMPBASE/easyfishing.XXXXXX")"

PLATFORM=""
ARCHIVE_PATH=""
GAME_DIR=""
CONFIG_DIR=""
CONFIG_FILE=""
INSTALL_DIR=""
INSTALL_AHK=0
DRY_RUN=0
UNINSTALL=0
ARCHIVER=""

AHK_SOURCE=""
INI_SOURCE=""
BA2_SOURCE=""
README_SOURCE=""

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
    [ -d "$TEMP_ROOT" ] && rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

new_temp_dir() {
    mktemp -d "$TEMP_ROOT/stage.XXXXXX"
}

usage() {
    cat <<'EOF'
EasyFishing installer

Usage:
  install.sh [options]

Options:
  --archive PATH             EasyFishing zip; otherwise Downloads/ and nearby zips are searched
  --platform windows|linux   Override platform detection (useful from WSL)
  --game-dir PATH            Fallout 76 install directory (the directory containing Data/)
  --config-dir PATH          Fallout 76 custom-INI directory
  --config-file PATH         Exact Fallout76Custom.ini or Project76Custom.ini path
  --install-dir PATH         Where to keep EasyFishing.ahk, EasyFishing.ini, and launchers
  --install-ahk              Download verified portable AutoHotkey v1.1.37.02
  --dry-run                  Resolve paths and show changes without writing anything
  --uninstall                Remove EasyFishing.ba2 and its INI entry; files are backed up
  -h, --help                 Show this help

Examples:
  # Windows Git Bash:
  bash install.sh --archive /c/Users/me/Downloads/EasyFishing.1.0.7.zip --install-ahk

  # Linux/Steam Proton:
  bash install.sh --platform linux --archive ~/Downloads/EasyFishing.1.0.7.zip --install-ahk

The game must be closed before installing or uninstalling.
EOF
}

detect_platform() {
    [ -n "$PLATFORM" ] && return 0
    case "$(uname -s 2>/dev/null || true)" in
        MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
        Linux*) PLATFORM="linux" ;;
        *) die "Unsupported shell platform. Use --platform windows or --platform linux." ;;
    esac
}

to_posix_path() {
    if [ "$PLATFORM" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
        cygpath -u -- "$1" 2>/dev/null || printf '%s\n' "$1"
    else
        printf '%s\n' "$1"
    fi
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_common_commands() {
    require_command awk
    require_command cmp
    require_command find
    require_command mktemp
}

require_install_commands() {
    require_common_commands
    if command -v unzip >/dev/null 2>&1; then
        ARCHIVER="unzip"
    elif command -v 7z >/dev/null 2>&1; then
        ARCHIVER="7z"
    else
        die "An archive extractor is required. Install unzip (or 7-Zip) and retry."
    fi
}

emit_steam_root() {
    local root="$1"
    local raw_path converted

    [ -d "$root" ] || return 0
    printf '%s\n' "$root"

    if [ -f "$root/steamapps/libraryfolders.vdf" ]; then
        while IFS= read -r raw_path; do
            [ -n "$raw_path" ] || continue
            converted="$(printf '%s' "$raw_path" | sed 's#\\\\#/#g')"
            converted="$(to_posix_path "$converted")"
            [ -d "$converted" ] && printf '%s\n' "$converted"
        done < <(awk -F'"' '/"path"[[:space:]]/ { print $4 }' "$root/steamapps/libraryfolders.vdf")
    fi
}

candidate_steam_roots() {
    local env_root
    env_root="$(printenv STEAM_DIR 2>/dev/null || true)"
    [ -n "$env_root" ] && emit_steam_root "$(to_posix_path "$env_root")"

    if [ "$PLATFORM" = "windows" ]; then
        emit_steam_root "/c/Program Files (x86)/Steam"
        emit_steam_root "/c/Program Files/Steam"
    else
        emit_steam_root "$HOME/.steam/steam"
        emit_steam_root "$HOME/.steam/root"
        emit_steam_root "$HOME/.local/share/Steam"
        emit_steam_root "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam"
    fi
}

candidate_game_dirs() {
    local root

    if [ -n "$GAME_DIR" ]; then
        printf '%s\n' "$(to_posix_path "$GAME_DIR")"
        return 0
    fi

    while IFS= read -r root; do
        printf '%s\n' "$root/steamapps/common/Fallout76"
        printf '%s\n' "$root/steamapps/common/Fallout 76"
    done < <(candidate_steam_roots)

    if [ "$PLATFORM" = "windows" ]; then
        printf '%s\n' "/c/XboxGames/Fallout 76/Content"
        printf '%s\n' "/c/Program Files/ModifiableWindowsApps/Fallout 76/Content"
    fi
}

resolve_game_dir() {
    local candidate

    while IFS= read -r candidate; do
        if [ -d "$candidate/Data" ]; then
            GAME_DIR="$(cd -- "$candidate" && pwd -P)"
            return 0
        fi
    done < <(candidate_game_dirs)

    die "Could not find Fallout 76. Pass --game-dir PATH (the directory containing Data/)."
}

windows_documents_dir() {
    local profile
    profile="$(printenv USERPROFILE 2>/dev/null || true)"
    [ -n "$profile" ] || profile="$HOME"
    profile="$(to_posix_path "$profile")"
    printf '%s\n' "$profile/Documents/My Games/Fallout 76"
}

game_steam_root() {
    case "$GAME_DIR" in
        */steamapps/common/*)
            printf '%s\n' "$GAME_DIR" | sed 's#/steamapps/common/.*$##'
            ;;
    esac
}

candidate_config_dirs() {
    local root

    if [ -n "$CONFIG_DIR" ]; then
        printf '%s\n' "$(to_posix_path "$CONFIG_DIR")"
        return 0
    fi

    if [ -n "$CONFIG_FILE" ]; then
        dirname -- "$(to_posix_path "$CONFIG_FILE")"
        return 0
    fi

    if [ "$PLATFORM" = "windows" ]; then
        windows_documents_dir
        return 0
    fi

    while IFS= read -r root; do
        printf '%s/steamapps/compatdata/%s/pfx/drive_c/users/steamuser/My Documents/My Games/Fallout 76\n' "$root" "$FO76_APPID"
        printf '%s/steamapps/compatdata/%s/pfx/drive_c/users/steamuser/Documents/My Games/Fallout 76\n' "$root" "$FO76_APPID"
    done < <({ game_steam_root; candidate_steam_roots; } | awk '!seen[$0]++')
    printf '%s\n' "$HOME/Documents/My Games/Fallout 76"
}

choose_config_name() {
    case "$GAME_DIR" in
        */XboxGames/*|*/ModifiableWindowsApps/*|*/WindowsApps/*)
            printf 'Project76Custom.ini\n'
            ;;
        *)
            printf 'Fallout76Custom.ini\n'
            ;;
    esac
}

resolve_config_file() {
    local dir first_dir candidate
    first_dir=""

    if [ -n "$CONFIG_FILE" ]; then
        CONFIG_FILE="$(to_posix_path "$CONFIG_FILE")"
        CONFIG_DIR="$(dirname -- "$CONFIG_FILE")"
        return 0
    fi

    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        [ -n "$first_dir" ] || first_dir="$dir"
        if [ -f "$dir/Fallout76Custom.ini" ]; then
            CONFIG_DIR="$dir"
            CONFIG_FILE="$dir/Fallout76Custom.ini"
            return 0
        fi
        if [ -f "$dir/Project76Custom.ini" ]; then
            CONFIG_DIR="$dir"
            CONFIG_FILE="$dir/Project76Custom.ini"
            return 0
        fi
    done < <(candidate_config_dirs)

    [ -n "$first_dir" ] || die "Could not determine the Fallout 76 custom-INI directory. Pass --config-dir PATH."
    CONFIG_DIR="$first_dir"
    candidate="$(choose_config_name)"
    CONFIG_FILE="$CONFIG_DIR/$candidate"
}

resolve_install_dir() {
    local env_value

    [ -n "$INSTALL_DIR" ] && {
        INSTALL_DIR="$(to_posix_path "$INSTALL_DIR")"
        return 0
    }

    if [ "$PLATFORM" = "windows" ]; then
        env_value="$(printenv LOCALAPPDATA 2>/dev/null || true)"
        [ -n "$env_value" ] || env_value="$HOME/AppData/Local"
        INSTALL_DIR="$(to_posix_path "$env_value")/EasyFishing"
    else
        env_value="$(printenv XDG_DATA_HOME 2>/dev/null || true)"
        [ -n "$env_value" ] || env_value="$HOME/.local/share"
        INSTALL_DIR="$env_value/easyfishing"
    fi
}

resolve_paths() {
    resolve_game_dir
    resolve_config_file
    resolve_install_dir
}

game_is_running() {
    if [ "$PLATFORM" = "windows" ] && command -v tasklist.exe >/dev/null 2>&1; then
        tasklist.exe /FI "IMAGENAME eq Fallout76.exe" 2>/dev/null |
            tr -d '\r' |
            awk '$1 == "Fallout76.exe" { found=1 } END { exit !found }'
        return $?
    fi

    if command -v pgrep >/dev/null 2>&1; then
        pgrep -f '(^|[ /])Fallout76(\.exe)?([[:space:]]|$)' >/dev/null 2>&1
        return $?
    fi
    return 1
}

ensure_game_closed() {
    game_is_running && die "Fallout 76 is running. Close it completely, then run this installer again."
    return 0
}

make_backup() {
    local source="$1"
    local label="$2"
    local backup suffix=0

    backup="$source.bak-easyfishing-$label-$(date +%Y%m%d-%H%M%S)"
    while [ -e "$backup" ]; do
        suffix=$((suffix + 1))
        backup="$source.bak-easyfishing-$label-$(date +%Y%m%d-%H%M%S)-$suffix"
    done
    cp -p -- "$source" "$backup" || die "Could not back up $source"
    printf '%s\n' "$backup"
}

move_to_backup() {
    local source="$1"
    local label="$2"
    local backup suffix=0

    backup="$source.bak-easyfishing-$label-$(date +%Y%m%d-%H%M%S)"
    while [ -e "$backup" ]; do
        suffix=$((suffix + 1))
        backup="$source.bak-easyfishing-$label-$(date +%Y%m%d-%H%M%S)-$suffix"
    done
    mv -- "$source" "$backup" || die "Could not move $source to its backup"
    printf '%s\n' "$backup"
}

copy_with_backup() {
    local source="$1"
    local destination="$2"
    local destination_dir temporary

    destination_dir="$(dirname -- "$destination")"
    mkdir -p -- "$destination_dir"

    if [ -f "$destination" ] && cmp -s -- "$source" "$destination"; then
        return 0
    fi

    if [ -e "$destination" ]; then
        say "Backing up existing $(basename -- "$destination")"
        make_backup "$destination" previous >/dev/null
    fi

    temporary="$(mktemp "$destination_dir/.easyfishing-copy.XXXXXX")"
    cp -p -- "$source" "$temporary" || die "Could not copy $source"
    mv -f -- "$temporary" "$destination" || die "Could not install $destination"
}

copy_if_missing() {
    local source="$1"
    local destination="$2"

    if [ -e "$destination" ]; then
        say "Keeping existing $(basename -- "$destination")"
        return 0
    fi
    copy_with_backup "$source" "$destination"
}

archive_config_update() {
    local action="$1"
    local path="$2"
    local destination_dir temporary

    destination_dir="$(dirname -- "$path")"

    if [ "$DRY_RUN" -eq 1 ]; then
        if [ "$action" = "add" ]; then
            say "Would register $MOD_ARCHIVE_NAME in $path"
        else
            say "Would remove $MOD_ARCHIVE_NAME from $path"
        fi
        return 0
    fi

    if [ "$action" = "remove" ] && [ ! -f "$path" ]; then
        say "No INI to update: $path"
        return 0
    fi

    mkdir -p -- "$destination_dir"
    temporary="$(mktemp "$destination_dir/.easyfishing-config.XXXXXX")"

    if [ -f "$path" ]; then
        awk -v action="$action" -v mod="$MOD_ARCHIVE_NAME" '
            function trim(value) {
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                return value
            }
            function update_value(value,    count, parts, i, part, output) {
                entry_found = 0
                output = ""
                count = split(value, parts, ",")
                for (i = 1; i <= count; i++) {
                    part = trim(parts[i])
                    if (part == "") continue
                    if (tolower(part) == tolower(mod)) {
                        entry_found = 1
                        if (action == "remove") continue
                    }
                    output = output (output == "" ? "" : ",") part
                }
                if (action == "add" && !entry_found) {
                    output = mod (output == "" ? "" : ",") output
                }
                return output
            }
            function flush_archive() {
                if (in_archive && !key_seen && action == "add") {
                    print "sResourceIndexFileList=" mod
                    key_seen = 1
                }
            }
            {
                line = $0
                sub(/\r$/, "", line)

                if (line ~ /^[[:space:]]*\[/) {
                    flush_archive()
                    in_archive = (tolower(line) ~ /^[[:space:]]*\[archive\][[:space:]]*$/)
                    if (in_archive) {
                        archive_seen = 1
                        key_seen = 0
                    }
                }

                if (in_archive && line ~ /^[[:space:]]*sResourceIndexFileList[[:space:]]*=/) {
                    value = line
                    sub(/^[^=]*=/, "", value)
                    updated = update_value(value)
                    if (action == "remove" && !entry_found) {
                        print line
                    } else {
                        print "sResourceIndexFileList=" updated
                    }
                    key_seen = 1
                    next
                }
                print line
            }
            END {
                flush_archive()
                if (action == "add" && !archive_seen) {
                    print ""
                    print "[Archive]"
                    print "sResourceIndexFileList=" mod
                }
            }
        ' "$path" > "$temporary"
    elif [ "$action" = "add" ]; then
        printf '[Archive]\nsResourceIndexFileList=%s\n' "$MOD_ARCHIVE_NAME" > "$temporary"
    else
        : > "$temporary"
    fi

    if [ -f "$path" ] && cmp -s -- "$temporary" "$path"; then
        rm -f -- "$temporary"
        say "No INI change needed: $path"
        return 0
    fi

    if [ -e "$path" ]; then
        say "Backing up custom INI"
        make_backup "$path" config >/dev/null
    fi
    mv -f -- "$temporary" "$path" || die "Could not update $path"
    say "Updated $path"
}

extract_archive() {
    local archive="$1"
    local destination="$2"

    mkdir -p -- "$destination"
    case "$ARCHIVER" in
        unzip)
            unzip -q "$archive" -d "$destination" || die "Could not extract $archive"
            ;;
        7z)
            7z x -y "-o$destination" "$archive" >/dev/null || die "Could not extract $archive"
            ;;
        *) die "Unknown archive extractor: $ARCHIVER" ;;
    esac
}

validate_archive_paths() {
    local archive="$1"
    local listing name

    # Reject zip-slip paths before extraction. The supplied bundle is local,
    # but the same installer will eventually be handed archives by other users.
    if [ "$ARCHIVER" = "unzip" ]; then
        listing="$(unzip -Z1 "$archive")" || die "Could not inspect $archive"
        while IFS= read -r name; do
            case "$name" in
                /*|../*|*/../*|*/..|[A-Za-z]:*)
                    die "Unsafe archive path: $name"
                    ;;
            esac
        done <<< "$listing"
    fi
}

resolve_archive() {
    local candidate

    if [ -n "$ARCHIVE_PATH" ]; then
        ARCHIVE_PATH="$(to_posix_path "$ARCHIVE_PATH")"
        [ -f "$ARCHIVE_PATH" ] || die "Archive does not exist: $ARCHIVE_PATH"
        return 0
    fi

    for candidate in \
        "$SCRIPT_DIR"/EasyFishing*.zip \
        "$PWD"/EasyFishing*.zip \
        "$HOME"/Downloads/EasyFishing*.zip; do
        if [ -f "$candidate" ]; then
            ARCHIVE_PATH="$candidate"
            return 0
        fi
    done

    die "Could not find EasyFishing zip. Pass --archive PATH."
}

prepare_archive_files() {
    local archive_root ahk_file ini_file ba2_file readme_file

    resolve_archive
    validate_archive_paths "$ARCHIVE_PATH"
    archive_root="$(new_temp_dir)"
    extract_archive "$ARCHIVE_PATH" "$archive_root"

    ahk_file="$(find "$archive_root" -type f -iname 'EasyFishing*.ahk' -print -quit)"
    ini_file="$archive_root/EasyFishing.ini"
    ba2_file="$archive_root/EasyFishing.ba2"
    readme_file="$archive_root/README.txt"

    [ -n "$ahk_file" ] && [ -s "$ahk_file" ] ||
        die "Archive does not contain a usable EasyFishing AHK script."
    [ -s "$ini_file" ] || die "Archive does not contain EasyFishing.ini."
    [ -s "$ba2_file" ] || die "Archive does not contain EasyFishing.ba2."

    AHK_SOURCE="$ahk_file"
    INI_SOURCE="$ini_file"
    BA2_SOURCE="$ba2_file"
    README_SOURCE=""
    if [ -s "$readme_file" ]; then
        README_SOURCE="$readme_file"
    fi
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -- "$1" | awk '{ print tolower($1) }'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 -- "$1" | awk '{ print tolower($1) }'
    else
        die "sha256sum or shasum is required for --install-ahk."
    fi
}

install_ahk_runtime() {
    local download_root zip_path extract_root actual

    if [ "$DRY_RUN" -eq 1 ]; then
        say "Would download and verify AutoHotkey v$AHK_VERSION into $INSTALL_DIR"
        return 0
    fi

    require_command curl
    download_root="$(new_temp_dir)"
    zip_path="$download_root/AutoHotkey.zip"
    extract_root="$download_root/extracted"

    say "Downloading verified AutoHotkey v$AHK_VERSION portable runtime"
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$AHK_URL" -o "$zip_path" ||
        die "Could not download AutoHotkey v$AHK_VERSION"
    actual="$(sha256_file "$zip_path")"
    [ "$actual" = "$AHK_SHA256" ] ||
        die "AutoHotkey download hash mismatch; refusing to install it."

    extract_archive "$zip_path" "$extract_root"
    [ -s "$extract_root/AutoHotkeyU64.exe" ] ||
        die "AutoHotkeyU64.exe is missing from the verified archive."

    copy_with_backup "$extract_root/AutoHotkeyU64.exe" "$INSTALL_DIR/AutoHotkeyU64.exe"
    say "Installed portable AutoHotkeyU64.exe"
}

write_launchers() {
    local windows_launcher linux_launcher

    windows_launcher="$(new_temp_dir)/EasyFishing.cmd"
    cat > "$windows_launcher" <<'EOF'
@echo off
setlocal
set "HERE=%~dp0"
if exist "%HERE%AutoHotkeyU64.exe" (
  start "" /b "%HERE%AutoHotkeyU64.exe" "%HERE%EasyFishing.ahk"
  exit /b 0
)
for %%A in ("%ProgramFiles%\AutoHotkey\AutoHotkeyU64.exe" "%ProgramFiles%\AutoHotkey\AutoHotkey.exe" "%ProgramFiles(x86)%\AutoHotkey\AutoHotkey.exe") do (
  if exist "%%~A" (
    start "" /b "%%~A" "%HERE%EasyFishing.ahk"
    exit /b 0
  )
)
echo AutoHotkey v1.1 was not found. Re-run install.sh with --install-ahk.
exit /b 1
EOF
    copy_with_backup "$windows_launcher" "$INSTALL_DIR/EasyFishing.cmd"

    linux_launcher="$(new_temp_dir)/run-easyfishing.sh"
    cat > "$linux_launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "$0")" && pwd -P)"
AHK="$HERE/AutoHotkeyU64.exe"
SCRIPT="$HERE/EasyFishing.ahk"

if [ ! -f "$AHK" ]; then
  printf 'AutoHotkeyU64.exe is not installed. Re-run install.sh with --install-ahk.\n' >&2
  exit 1
fi

if command -v protontricks-launch >/dev/null 2>&1; then
  exec protontricks-launch --appid 1151340 "$AHK" "$SCRIPT"
fi

if command -v flatpak >/dev/null 2>&1 && flatpak info com.github.Matoking.protontricks >/dev/null 2>&1; then
  exec flatpak run --command=protontricks-launch com.github.Matoking.protontricks \
    --appid 1151340 "$AHK" "$SCRIPT"
fi

if [ -n "$(printenv FO76_WINEPREFIX 2>/dev/null || true)" ] &&
   command -v wine >/dev/null 2>&1; then
  exec env WINEPREFIX="$FO76_WINEPREFIX" wine "$AHK" "$SCRIPT"
fi

cat >&2 <<'MESSAGE'
Protontricks was not found. Install it, then run this launcher again:
  protontricks-launch --appid 1151340 AutoHotkeyU64.exe EasyFishing.ahk

If you intentionally use a separate Wine prefix, set FO76_WINEPREFIX and make
sure that prefix contains Fallout 76 before launching this script.
MESSAGE
exit 1
EOF
    chmod 755 "$linux_launcher"
    copy_with_backup "$linux_launcher" "$INSTALL_DIR/run-easyfishing.sh"
}

install_mod() {
    local data_dir

    prepare_archive_files
    resolve_paths
    ensure_game_closed

    data_dir="$GAME_DIR/Data"
    say "Platform: $PLATFORM"
    say "Game data: $data_dir"
    say "Custom INI: $CONFIG_FILE"
    say "EasyFishing files: $INSTALL_DIR"

    if [ "$DRY_RUN" -eq 1 ]; then
        say "Would install $MOD_ARCHIVE_NAME into $data_dir"
        say "Would install EasyFishing.ahk and EasyFishing.ini into $INSTALL_DIR"
        archive_config_update add "$CONFIG_FILE"
        if [ "$INSTALL_AHK" -eq 1 ]; then
            install_ahk_runtime
        fi
        return 0
    fi

    mkdir -p -- "$INSTALL_DIR"
    copy_with_backup "$BA2_SOURCE" "$data_dir/$MOD_ARCHIVE_NAME"
    copy_with_backup "$AHK_SOURCE" "$INSTALL_DIR/EasyFishing.ahk"
    copy_if_missing "$INI_SOURCE" "$INSTALL_DIR/EasyFishing.ini"
    if [ -n "$README_SOURCE" ]; then
        copy_with_backup "$README_SOURCE" "$INSTALL_DIR/README.txt"
    fi

    archive_config_update add "$CONFIG_FILE"
    if [ "$INSTALL_AHK" -eq 1 ]; then
        install_ahk_runtime
    fi
    write_launchers

    say "EasyFishing installation complete."
    say "Start the automation with: $INSTALL_DIR/EasyFishing.cmd (Windows)"
    say "Linux launcher: $INSTALL_DIR/run-easyfishing.sh"
    if [ "$INSTALL_AHK" -eq 0 ]; then
        warn "AutoHotkey v1.1 was not downloaded. Use --install-ahk or install AHK v1.1 yourself."
    fi
}

uninstall_mod() {
    local data_file

    resolve_paths
    ensure_game_closed

    data_file="$GAME_DIR/Data/$MOD_ARCHIVE_NAME"
    say "Game data: $GAME_DIR/Data"
    say "Custom INI: $CONFIG_FILE"

    if [ "$DRY_RUN" -eq 1 ]; then
        [ -e "$data_file" ] && say "Would move $data_file to a backup"
        archive_config_update remove "$CONFIG_FILE"
        return 0
    fi

    if [ -e "$data_file" ]; then
        say "Removing $MOD_ARCHIVE_NAME (recoverable backup)"
        move_to_backup "$data_file" uninstall >/dev/null
    else
        warn "$data_file is already absent"
    fi
    archive_config_update remove "$CONFIG_FILE"
    say "EasyFishing archive and INI registration removed."
    say "Automation files were kept in $INSTALL_DIR; delete that folder if you no longer need them."
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --archive)
                [ "$#" -ge 2 ] || die "--archive requires a path"
                ARCHIVE_PATH="$2"
                shift 2
                ;;
            --platform)
                [ "$#" -ge 2 ] || die "--platform requires windows or linux"
                PLATFORM="$2"
                [ "$PLATFORM" = "windows" ] || [ "$PLATFORM" = "linux" ] ||
                    die "--platform must be windows or linux"
                shift 2
                ;;
            --game-dir)
                [ "$#" -ge 2 ] || die "--game-dir requires a path"
                GAME_DIR="$2"
                shift 2
                ;;
            --config-dir)
                [ "$#" -ge 2 ] || die "--config-dir requires a path"
                CONFIG_DIR="$2"
                shift 2
                ;;
            --config-file)
                [ "$#" -ge 2 ] || die "--config-file requires a path"
                CONFIG_FILE="$2"
                shift 2
                ;;
            --install-dir)
                [ "$#" -ge 2 ] || die "--install-dir requires a path"
                INSTALL_DIR="$2"
                shift 2
                ;;
            --install-ahk)
                INSTALL_AHK=1
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                shift
                ;;
            --uninstall)
                UNINSTALL=1
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1 (use --help for usage)"
                ;;
        esac
    done
}

main() {
    parse_args "$@"
    detect_platform
    if [ "$UNINSTALL" -eq 1 ]; then
        require_common_commands
        uninstall_mod
    else
        require_install_commands
        install_mod
    fi
}

main "$@"
