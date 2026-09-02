#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
INSTALLER="$ROOT/install.sh"
TEST_ROOT="$(mktemp -d "/tmp/easyfishing-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_file() {
    [ -f "$1" ] || fail "Expected file: $1"
}

assert_contains() {
    local needle="$1"
    local file="$2"
    grep -F -- "$needle" "$file" >/dev/null || fail "Expected $needle in $file"
}

assert_count() {
    local expected="$1"
    local needle="$2"
    local file="$3"
    local actual
    actual="$(grep -oF -- "$needle" "$file" || true)"
    if [ -z "$actual" ]; then
        actual=0
    else
        actual="$(printf '%s\n' "$actual" | wc -l | tr -d '[:space:]')"
    fi
    [ "$actual" = "$expected" ] ||
        fail "Expected $expected occurrences of $needle in $file, got $actual"
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required for the installer test"

GAME="$TEST_ROOT/game"
DATA="$GAME/Data"
CONFIG="$TEST_ROOT/config"
INSTALL="$TEST_ROOT/install"
ARCHIVE_STAGE="$TEST_ROOT/archive-stage"
ARCHIVE="$TEST_ROOT/EasyFishing.1.0.7.zip"
mkdir -p "$DATA" "$CONFIG" "$INSTALL" "$ARCHIVE_STAGE"

printf 'fake ba2 v1\n' > "$ARCHIVE_STAGE/EasyFishing.ba2"
printf '#SingleInstance, Force\n' > "$ARCHIVE_STAGE/EasyFishing.1.0.7.ahk"
printf '[Settings]\nsearchAreaPos1X=0\n' > "$ARCHIVE_STAGE/EasyFishing.ini"
printf 'EasyFishing test README\n' > "$ARCHIVE_STAGE/README.txt"
python3 - "$ARCHIVE_STAGE" "$ARCHIVE" <<'PY'
import pathlib
import sys
import zipfile

stage, archive = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    for file_path in stage.iterdir():
        bundle.write(file_path, file_path.name)
PY

CUSTOM_INI="$CONFIG/Fallout76Custom.ini"
printf '[Display]\nfoo=bar\n\n[Archive]\nsResourceIndexFileList=Other.ba2, Another.ba2\n' > "$CUSTOM_INI"

bash "$INSTALLER" \
    --platform linux \
    --archive "$ARCHIVE" \
    --game-dir "$GAME" \
    --config-file "$CUSTOM_INI" \
    --install-dir "$INSTALL"

assert_file "$DATA/EasyFishing.ba2"
assert_file "$INSTALL/EasyFishing.ahk"
assert_file "$INSTALL/EasyFishing.ini"
assert_file "$INSTALL/run-easyfishing.sh"
assert_contains 'sResourceIndexFileList=EasyFishing.ba2,Other.ba2,Another.ba2' "$CUSTOM_INI"
assert_count 1 'EasyFishing.ba2' "$CUSTOM_INI"

# A second run must be idempotent and must not overwrite a user's learned INI.
printf '[Settings]\nsearchAreaPos1X=123\n' > "$INSTALL/EasyFishing.ini"
bash "$INSTALLER" \
    --platform linux \
    --archive "$ARCHIVE" \
    --game-dir "$GAME" \
    --config-file "$CUSTOM_INI" \
    --install-dir "$INSTALL"
assert_contains 'searchAreaPos1X=123' "$INSTALL/EasyFishing.ini"
assert_count 1 'EasyFishing.ba2' "$CUSTOM_INI"

bash "$INSTALLER" \
    --platform linux \
    --game-dir "$GAME" \
    --config-file "$CUSTOM_INI" \
    --install-dir "$INSTALL" \
    --uninstall

[ ! -f "$DATA/EasyFishing.ba2" ] || fail 'EasyFishing.ba2 should be removed by uninstall'
assert_contains 'sResourceIndexFileList=Other.ba2,Another.ba2' "$CUSTOM_INI"
assert_count 0 'EasyFishing.ba2' "$CUSTOM_INI"
find "$DATA" -maxdepth 1 -name 'EasyFishing.ba2.bak-easyfishing-uninstall-*' -print -quit |
    grep -q . || fail 'uninstall backup was not created'

# The archive guard must reject zip-slip paths before extraction.
BAD_ARCHIVE="$TEST_ROOT/unsafe.zip"
python3 - "$BAD_ARCHIVE" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as bundle:
    bundle.writestr("../escape.txt", "must not be extracted")
PY
if bash "$INSTALLER" \
    --platform linux \
    --archive "$BAD_ARCHIVE" \
    --game-dir "$GAME" \
    --config-file "$CUSTOM_INI" \
    --install-dir "$INSTALL" \
    --dry-run; then
    fail 'unsafe archive should have been rejected'
fi
[ ! -f "$TEST_ROOT/escape.txt" ] || fail 'unsafe archive escaped its extraction directory'

printf 'EasyFishing installer tests passed.\n'
