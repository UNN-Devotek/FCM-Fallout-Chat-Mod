#!/usr/bin/env bash
# build.sh — Build FCM-standalone.ba2 for dev or prod.
#
# Usage:
#   ./build.sh --target dev --hudmenu-sha256 <fresh-vanilla-hash>
#   ./build.sh --target prod --hudmenu-sha256 <fresh-vanilla-hash>
#
# Tool-path overrides (env or staged defaults):
#   BUILDTOOLS_ROOT directory containing the staged compiler/runtime tools
#   HAXE      path to the haxe binary   (default: staged buildtools haxe_*)
#   JAVA      path to java binary        (default: staged buildtools jdk-17*/bin/java)
#   FFDEC     path to ffdec.jar          (default: staged buildtools ffdec/ffdec.jar)
#
# The vanilla HUDMenu.swf is extracted from the live game installation at:
#   $GAME/Data/SeventySix - Interface.ba2
# Override via GAME env var if the game is installed elsewhere.

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
TARGET=""
HUDMENU_SHA256="${FCM_HUDMENU_SHA256:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) TARGET="$2"; shift 2 ;;
        --hudmenu-sha256) HUDMENU_SHA256="$2"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done
if [[ "$TARGET" != "dev" && "$TARGET" != "prod" ]]; then
    echo "Usage: $0 --target dev|prod --hudmenu-sha256 <64-hex-hash>" >&2
    exit 1
fi
if [[ ! "$HUDMENU_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: a SHA-256 hash of the freshly extracted vanilla HUDMenu.swf is required" >&2
    echo "       pass --hudmenu-sha256 <hash> or set FCM_HUDMENU_SHA256" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Tool paths — prefer env overrides, fall back to staged buildtools
# ---------------------------------------------------------------------------
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"   # game-mods/FCMBridge/
BUILDTOOLS_ROOT="${BUILDTOOLS_ROOT:-$SRC_DIR/buildtools}"

if [[ -z "${HAXE:-}" ]]; then
    HX_DIR=$(ls -d "$BUILDTOOLS_ROOT"/haxe_* 2>/dev/null | head -1)
    if [[ -z "$HX_DIR" ]]; then echo "ERROR: HAXE not set and staged haxe not found under $BUILDTOOLS_ROOT" >&2; exit 1; fi
    HAXE="$HX_DIR/haxe"
    export HAXE_STD_PATH="$HX_DIR/std"
fi

if [[ -z "${JAVA:-}" ]]; then
    JAVA_DIR=$(ls -d "$BUILDTOOLS_ROOT"/jdk-17*-jre 2>/dev/null | head -1)
    if [[ -z "$JAVA_DIR" ]]; then echo "ERROR: JAVA not set and staged JDK not found under $BUILDTOOLS_ROOT" >&2; exit 1; fi
    JAVA="$JAVA_DIR/bin/java"
fi

if [[ -z "${FFDEC:-}" ]]; then
    FFDEC="$BUILDTOOLS_ROOT/ffdec/ffdec.jar"
    if [[ ! -f "$FFDEC" ]]; then echo "ERROR: FFDEC not set and staged ffdec.jar not found at $FFDEC" >&2; exit 1; fi
fi

GAME="${GAME:-$HOME/.local/share/Steam/steamapps/common/Fallout76}"

# ---------------------------------------------------------------------------
# Endpoint by target
# ---------------------------------------------------------------------------
if [[ "$TARGET" == "dev" ]]; then
    ENDPOINT="wss://dev.falloutchatmod.com/relay"
    BUILD_STAMP="chatv1-dev"
else
    ENDPOINT="wss://falloutchatmod.com/relay"
    BUILD_STAMP="chatv1-prod"
fi

# ---------------------------------------------------------------------------
# Build directory
# ---------------------------------------------------------------------------
OUT="$(mktemp -d /tmp/fcm-build-XXXXXX)"
trap 'rm -rf "$OUT"' EXIT

echo "==> FCM-standalone.ba2 build [target=$TARGET endpoint=$ENDPOINT]"
echo "    SRC=$SRC_DIR"
echo "    OUT=$OUT"
echo "    GAME=$GAME"
echo "    HUDMenu vanilla SHA-256 pin=$HUDMENU_SHA256"

# ---------------------------------------------------------------------------
# Step a: Compile FCMBridge.hx -> FCMBridge.swf (CWS, any version)
# ---------------------------------------------------------------------------
echo ""
echo "--- a: haxe compile FCMBridge.hx"
(cd "$SRC_DIR" && "$HAXE" --main FCMBridge --swf "$OUT/FCMBridge.swf" --swf-version 32)
echo "    compiled: $(wc -c < "$OUT/FCMBridge.swf") bytes (pre-decompress)"

# ---------------------------------------------------------------------------
# Step b: CWS -> FWS v32 (Scaleform requires uncompressed FWS, version byte 32)
# ---------------------------------------------------------------------------
echo ""
echo "--- b: CWS->FWS v32 conversion"
python3 - "$OUT/FCMBridge.swf" <<'PYEOF'
import zlib, struct, sys
path = sys.argv[1]
d = open(path, 'rb').read()
if d[:3] == b'CWS':
    body = zlib.decompress(d[8:])
else:
    body = d[8:]
data = b'FWS' + bytes([32]) + struct.pack('<I', 8 + len(body)) + body
open(path, 'wb').write(data)
print("    FWS v" + str(data[3]) + " length=" + str(len(data)))
PYEOF

FCM_BRIDGE_SIZE=$(wc -c < "$OUT/FCMBridge.swf")
echo "    FCMBridge.swf: $FCM_BRIDGE_SIZE bytes, version=$(python3 -c "print(open('$OUT/FCMBridge.swf','rb').read(4)[3])")"
python3 "$SRC_DIR/tools/validate_swf.py" "$OUT/FCMBridge.swf" \
    --require-signature FWS --require-version 32

# ---------------------------------------------------------------------------
# Step c: Extract vanilla HUDMenu.swf from SeventySix - Interface.ba2
# ---------------------------------------------------------------------------
echo ""
echo "--- c: extract HUDMenu_vanilla.swf from SeventySix - Interface.ba2"
python3 "$SRC_DIR/hudmenu-chat/ba2tool.py" extract \
    "$GAME/Data/SeventySix - Interface.ba2" \
    "interface/HUDMenu.swf" \
    "$OUT/HUDMenu_vanilla.swf"
echo "    extracted: $(wc -c < "$OUT/HUDMenu_vanilla.swf") bytes"
ACTUAL_HUDMENU_SHA256=$(sha256sum "$OUT/HUDMenu_vanilla.swf" | awk '{print $1}')
if [[ "$ACTUAL_HUDMENU_SHA256" != "${HUDMENU_SHA256,,}" ]]; then
    echo "ERROR: extracted HUDMenu.swf hash mismatch" >&2
    echo "       expected: ${HUDMENU_SHA256,,}" >&2
    echo "       actual:   $ACTUAL_HUDMENU_SHA256" >&2
    exit 1
fi
echo "    hash verified: $ACTUAL_HUDMENU_SHA256"

# ---------------------------------------------------------------------------
# Step d: Decompile HUDMenu_vanilla.swf -> AS3 source
# ---------------------------------------------------------------------------
echo ""
echo "--- d: ffdec decompile HUDMenu_vanilla.swf"
"$JAVA" -jar "$FFDEC" -export script "$OUT/src" "$OUT/HUDMenu_vanilla.swf" \
    2>&1 | tail -5
HUDMENU_AS=$(find "$OUT/src" -name "HUDMenu.as" | head -1)
if [[ -z "$HUDMENU_AS" ]]; then
    echo "ERROR: HUDMenu.as not found in ffdec export under $OUT/src" >&2
    exit 1
fi
echo "    decompiled: $HUDMENU_AS"

# ---------------------------------------------------------------------------
# Step e: Verify anchors on fresh decompile
# ---------------------------------------------------------------------------
echo ""
echo "--- e: test_anchors.py"
python3 "$SRC_DIR/hudmenu-chat/test_anchors.py" "$HUDMENU_AS"

# ---------------------------------------------------------------------------
# Step f: Apply FCM patch (inject fcm-inject.as into HUDMenu.as)
# ---------------------------------------------------------------------------
echo ""
echo "--- f: apply-patch.py"
python3 "$SRC_DIR/hudmenu-chat/apply-patch.py" "$HUDMENU_AS" \
    --source-swf "$OUT/HUDMenu_vanilla.swf" \
    --expected-sha256 "$HUDMENU_SHA256"

# ---------------------------------------------------------------------------
# Step g: ffdec recompile patched HUDMenu.as -> HUDMenu.swf
# ---------------------------------------------------------------------------
echo ""
echo "--- g: ffdec recompile patched HUDMenu.as"
"$JAVA" -jar "$FFDEC" \
    -replace "$OUT/HUDMenu_vanilla.swf" "$OUT/HUDMenu.swf" \
    HUDMenu "$HUDMENU_AS" \
    2>&1 | tail -5
echo "    recompiled: $(wc -c < "$OUT/HUDMenu.swf") bytes"

# ---------------------------------------------------------------------------
# Step h: Patch version byte to 32
# ---------------------------------------------------------------------------
echo ""
echo "--- h: patch HUDMenu.swf version byte -> 32"
python3 -c "
d = bytearray(open('$OUT/HUDMenu.swf','rb').read())
d[3] = 32
open('$OUT/HUDMenu.swf','wb').write(d)
print('    version byte:', d[3])
"
HUD_SIZE=$(wc -c < "$OUT/HUDMenu.swf")
echo "    HUDMenu.swf: $HUD_SIZE bytes"
python3 "$SRC_DIR/tools/validate_swf.py" "$OUT/HUDMenu.swf" \
    --require-signature FWS --require-version 32

# ---------------------------------------------------------------------------
# Step i: Pack FCM-standalone.ba2 (blob-swap: reuse vanilla archive records)
#   Also write endpoint into Data/ZFE/TextChat/fragments/FCM.ini (packed inside ba2)
#   and emit Data/configuration/zfe.ini snippet as a standalone file for install.
# ---------------------------------------------------------------------------
echo ""
echo "--- i: write endpoint into FCM.ini (target=$TARGET)"

# Write a target-specific FCM.ini with the correct endpoint stamped in.
FRAGMENT_SRC="$SRC_DIR/Data/ZFE/TextChat/fragments/FCM.ini"
FRAGMENT_OUT="$OUT/FCM.ini"
python3 - "$FRAGMENT_SRC" "$FRAGMENT_OUT" "$ENDPOINT" "$BUILD_STAMP" <<'PYEOF'
import sys, re
src_path, dst_path, endpoint, stamp = sys.argv[1:]
txt = open(src_path, encoding='utf-8').read()
# Replace the Endpoint= line (any value) with the target endpoint.
txt = re.sub(r'^Endpoint=.*$', 'Endpoint=' + endpoint, txt, flags=re.MULTILINE)
# Stamp the build (append a comment after [TextChat] header line).
if '; BUILD=' not in txt:
    txt = txt.replace('[TextChat]\n', '[TextChat]\n; BUILD=' + stamp + '\n', 1)
else:
    txt = re.sub(r'; BUILD=.*\n', '; BUILD=' + stamp + '\n', txt)
open(dst_path, 'w', encoding='utf-8').write(txt)
print('    FCM.ini Endpoint=' + endpoint + ' BUILD=' + stamp)
PYEOF

# Pack the ba2: swap both SWFs and the stamped FCM.ini into the backup ba2.
BA2_BACKUP="$GAME/Data/FCM-standalone.ba2.bak-fcmhud1"
BA2_OUT="$OUT/FCM-standalone.ba2"
echo ""
echo "--- i: pack FCM-standalone.ba2 via blobswap"
python3 "$SRC_DIR/hudmenu-chat/ba2tool.py" blobswap \
    "$BA2_BACKUP" \
    "$BA2_OUT" \
    "interface/hudmenu.swf=$OUT/HUDMenu.swf" \
    "interface/FCMBridge.swf=$OUT/FCMBridge.swf" \
    "Data/ZFE/TextChat/fragments/FCM.ini=$OUT/FCM.ini"
BA2_SIZE=$(wc -c < "$BA2_OUT")
echo "    FCM-standalone.ba2: $BA2_SIZE bytes"

# ---------------------------------------------------------------------------
# Emit Data/configuration/zfe.ini snippet for install
# (The TextChat fragment is gated by hudmodloader.ini — absent in standalone.
#  zfe.ini overrides always apply regardless of hudmodloader.ini, so the
#  endpoint must also be written there for the no-HUDModLoader standalone path.)
# ---------------------------------------------------------------------------
ZFE_INI_SNIPPET="$OUT/zfe-textchat-endpoint.ini"
cat > "$ZFE_INI_SNIPPET" <<INIEOF
[TextChat]
Endpoint=$ENDPOINT
; BUILD=$BUILD_STAMP
INIEOF
echo ""
echo "--- endpoint override snippet written: $ZFE_INI_SNIPPET"
echo "    (install step will merge this into \$GAME/Data/configuration/zfe.ini)"

# ---------------------------------------------------------------------------
# Promote artifacts to the source tree for install step
# ---------------------------------------------------------------------------
cp "$BA2_OUT" "$SRC_DIR/FCMBridge.ba2"
cp "$OUT/FCMBridge.swf" "$SRC_DIR/FCMBridge.swf"
echo ""
echo "==> Build complete [BUILD=$BUILD_STAMP]"
echo "    FCMBridge.swf : $(wc -c < "$SRC_DIR/FCMBridge.swf") bytes"
echo "    FCM-standalone.ba2 : $(wc -c < "$SRC_DIR/FCMBridge.ba2") bytes"
echo "    endpoint : $ENDPOINT"
echo ""

# ---------------------------------------------------------------------------
# Install — guarded by game-not-running check
# ---------------------------------------------------------------------------
if pgrep -i fallout76 > /dev/null 2>&1; then
    echo "NOTICE: Fallout76 is running — skipping install."
    echo "        Stop the game, then run:"
    echo "          cp '$SRC_DIR/FCMBridge.ba2' '$GAME/Data/FCM-standalone.ba2'"
    echo "          (and merge [TextChat] Endpoint=$ENDPOINT into \$GAME/Data/configuration/zfe.ini)"
    exit 0
fi

echo "--- install: game not running — installing ba2 and zfe.ini"

# Back up current ba2.
if [[ -f "$GAME/Data/FCM-standalone.ba2" ]]; then
    cp "$GAME/Data/FCM-standalone.ba2" "$GAME/Data/FCM-standalone.ba2.bak-prev"
    echo "    backed up current ba2 -> FCM-standalone.ba2.bak-prev"
fi

cp "$SRC_DIR/FCMBridge.ba2" "$GAME/Data/FCM-standalone.ba2"
echo "    installed: FCM-standalone.ba2"

# Merge [TextChat] Endpoint= into Data/configuration/zfe.ini.
# If the section is absent, append it.  If it is present, update the Endpoint key.
ZFE_INI="$GAME/Data/configuration/zfe.ini"
python3 - "$ZFE_INI" "$ENDPOINT" "$BUILD_STAMP" <<'PYEOF'
import sys, os, re
ini_path, endpoint, stamp = sys.argv[1:]
try:
    txt = open(ini_path, encoding='utf-8').read()
except FileNotFoundError:
    txt = ""
if '[TextChat]' in txt:
    if re.search(r'^Endpoint=', txt, re.MULTILINE):
        txt = re.sub(r'^Endpoint=.*$', 'Endpoint=' + endpoint, txt, flags=re.MULTILINE)
    else:
        # Append Endpoint key after [TextChat] header.
        txt = re.sub(r'(\[TextChat\][^\[]*)', lambda m: m.group(1).rstrip('\n') + '\nEndpoint=' + endpoint + '\n', txt)
else:
    txt = txt.rstrip('\n') + '\n[TextChat]\nEndpoint=' + endpoint + '\n'
open(ini_path, 'w', encoding='utf-8').write(txt)
print("    zfe.ini [TextChat] Endpoint=" + endpoint)
PYEOF

echo ""
echo "==> Install complete."
echo "    $GAME/Data/FCM-standalone.ba2  ($BA2_SIZE bytes)"
echo "    $ZFE_INI  ([TextChat] Endpoint=$ENDPOINT)"
echo ""
echo "Look for in zfe.log on next launch:"
echo "  hostZfe=found            (HUDMenu passed __ZFE to FCMBridge)"
echo "  FCMBridge loaded         (BUILD=$BUILD_STAMP)"
echo "  zfe-chat-online-v1 OK    (capability check passed)"
echo "  chat.v1.connect          (relay connected)"
echo "  register -> link code    (if account not yet linked)"
echo ""
echo "If you see hostZfe=absent, __ZFE is not present at the HUDMenu level"
echo "either — ZFE may not be loading at all, or dxgi.dll is not installed."
