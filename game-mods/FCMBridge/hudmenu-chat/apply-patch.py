#!/usr/bin/env python3
"""Apply the FCM chat.v1 injection to a decompiled HUDMenu.as (ffdec export).
Works on both the vanilla and HUDModLoader bases (anchors auto-detect param style).
Usage: python3 apply-patch.py <path/to/decompiled/HUDMenu.as> \
    --source-swf <fresh/HUDMenu.swf> --expected-sha256 <hash>
Then recompile:  ffdec -replace <HUDMenu.swf> <out.swf> HUDMenu <patched HUDMenu.as>
Reproducible build; never commit Bethesda's HUDMenu source/SWF (IP).

The hash is the freshly extracted vanilla HUDMenu.swf. Requiring it prevents applying this
source patch to an unverified or stale game-build export.

Transport: ZFE chat.v1 (ZFE 0.9.8+). The legacy __SFCodeObj bridge layer
(writeUTFBytes/readUTFBytes/register/connect) is fully removed. Sends now go
through FCMBridge.fcmSendMessage which calls chat.v1.sendMessage via __ZFE."""
import sys, re, os, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))

def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)

def parse_args():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        die("usage: apply-patch.py <HUDMenu.as> --expected-sha256 <64-hex-hash>")
    path = args[0]
    expected = os.environ.get("FCM_HUDMENU_SHA256", "").strip().lower()
    source_swf = os.environ.get("FCM_HUDMENU_SWF", "").strip()
    i = 1
    while i < len(args):
        if args[i] == "--expected-sha256" and i + 1 < len(args):
            expected = args[i + 1].strip().lower()
            i += 2
        elif args[i] == "--source-swf" and i + 1 < len(args):
            source_swf = args[i + 1]
            i += 2
        else:
            die("unknown or incomplete argument: " + args[i])
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        die("a verified vanilla HUDMenu.swf SHA-256 is required via --expected-sha256 or FCM_HUDMENU_SHA256")
    if not source_swf:
        die("the fresh vanilla HUDMenu.swf path is required via --source-swf or FCM_HUDMENU_SWF")
    return path, source_swf, expected

f, source_swf, expected_sha256 = parse_args()
with open(source_swf, "rb") as raw_file:
    actual_sha256 = hashlib.sha256(raw_file.read()).hexdigest()
if actual_sha256 != expected_sha256:
    die("HUDMenu.as source cannot be verified against the extracted HUDMenu.swf hash; "
        "expected " + expected_sha256 + ", got " + actual_sha256)
src = open(f, encoding="latin1").read()

# ---------------------------------------------------------------------------
# IMPORTS — inject flash.display.Loader, flash.net.URLRequest, flash.system.*,
# and flash.text.TextFormat when not already present.
# The vanilla ffdec export omits these; the HUDModLoader base already has them.
# ---------------------------------------------------------------------------
IMPORT_ANCHOR = '   import flash.utils.setTimeout;'
EXTRA_IMPORTS = ('   import flash.display.Loader;\n'
                 '   import flash.net.URLRequest;\n'
                 '   import flash.system.ApplicationDomain;\n'
                 '   import flash.system.LoaderContext;\n'
                 '   import flash.text.TextFormat;')
if IMPORT_ANCHOR in src:
    if 'import flash.text.TextFormat' not in src:
        src = src.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + '\n' + EXTRA_IMPORTS, 1)

# ---------------------------------------------------------------------------
# FIELDS — add all FCM state variables after the native HUDChatBase_mc decl.
#
# chat.v1 changes vs FCMHUD/1:
#   - Removed: _fcmHelloSent (no HELLO verb in chat.v1)
#   - Replaced: _fcmChannelId (UUID) with _fcmChannelSlug (slug string)
#   - Added:    _fcmBridge (reference to the loaded FCMBridge instance)
#
# _fcmBridge is the key new field: fcm-inject.as delegates sendMessage and
# channel switching to FCMBridge (which holds the chat.v1 ZFE connection) via
# fcmBridge.fcmSendMessage() and fcmBridge.fcmSwitchChannelTo().
# ---------------------------------------------------------------------------
FIELDS = ('      \n'
          '      public var _fcmZfe:Object = null;\n      \n'
          '      public var _fcmLogger:Object = null;\n      \n'
          '      public var _fcmBridge:* = null;\n      \n'
          '      public var _fcmInited:Boolean = false;\n      \n'
          '      public var _fcmLastEvent:String = "";\n      \n'
          '      public var _fcmNavigationAction:String = "";\n      \n'
          '      public var _fcmNavigationDown:Array = [];\n      \n'
          '      public var _fcmModernWidgetActive:Boolean = false;\n      \n'
          '      public var _fcmInputActive:Boolean = false;\n      \n'
          '      public var _fcmChannelSlug:String = "global";\n      \n'
          '      public var _fcmChannelIdx:int = 0;\n      \n'
          '      public var _fcmInpRef:* = null;\n      \n'
          '      public var _fcmIniLoaded:Boolean = false;\n      \n'
          '      public var _fcmIniX:int = 0;\n      \n'
          '      public var _fcmIniY:int = 0;\n      \n'
          '      public var _fcmIniW:int = 0;\n      \n'
          '      public var _fcmIniH:int = 0;\n      \n'
          '      public var _fcmIniFontSize:int = 0;\n      \n'
          '      public var _fcmIniOpenKey:String = "";\n      \n'
          '      public var _fcmWorldTimer:* = null;\n      \n'
          '      public var _fcmSelfLoadTimer:* = null;')

# ---------------------------------------------------------------------------
# Anchor assertions — all 6 must be present; script exits with a clear error
# message if any is missing (e.g. after a Bethesda HUDMenu patch renames
# something). Fix the anchor and re-run after any FO76 update.
# ---------------------------------------------------------------------------

# Anchor 1: field declarations after HUDChatBase_mc
a1 = '      public var HUDChatBase_mc:MovieClip;'
if a1 not in src:
    die("Anchor 1 (HUDChatBase_mc field) not found in " + f)
src = src.replace(a1, a1 + FIELDS, 1)

# Anchor 2: fcmInit call after BSUIDataManager Subscribe (CharacterInfoData)
a2 = '         BSUIDataManager.Subscribe("CharacterInfoData",this.onCharacterInfoUpdate);'
if a2 not in src:
    die("Anchor 2 (CharacterInfoData Subscribe) not found in " + f)
src = src.replace(a2, a2 + '\n         this.fcmInitSafe();', 1)

# Anchor 3: inject our methods before enterChatMode.
# enterChatMode is 'internal' on vanilla, 'public' on HUDModLoader — match either.
methods = open(os.path.join(HERE, 'fcm-inject.as'), encoding="latin1").read().rstrip() + '\n      \n'
m3 = re.search(r'      (?:internal|public) function enterChatMode\(\) : \*', src)
if not m3:
    die("Anchor 3 (enterChatMode function) not found in " + f)
src = src.replace(m3.group(0), methods + m3.group(0), 1)

# Anchor 4: sendChatMessage forward — match either named (Message) or HUDModLoader (param1) arg.
# fcmForward delegates to FCMBridge.fcmSendMessage via chat.v1 (no direct writeUTFBytes).
m4 = re.search(r'(BSUIDataManager\.dispatchEvent\(new NetworkedUIEvent\("networked::UIEVENT","ChatMessage",[^,]+,"All",(\w+)\)\);)', src)
if not m4:
    die("Anchor 4 (sendChatMessage dispatch) not found in " + f)
src = src.replace(m4.group(1), m4.group(1) + '\n            this.fcmForwardSafe(' + m4.group(2) + ');', 1)

# Anchor 5: ProcessUserEvent — engine delivers NAMED actions here (only input channel
# for HUDMenu). Wire fcmEvent after vanilla initializes its local consumed flag. The
# hook must run before HUDModUserEvent dispatch and must be able to set that flag, otherwise
# TeamChat can open the native editor after FCM already opened SharedHUDTools.
m5 = re.search(
    r'(public function ProcessUserEvent\((\w+):String, (\w+):Boolean\) : Boolean\n'
    r'      \{\n)(.*?)(var (\w+):(?:\*|Boolean) = false;)',
    src,
    re.DOTALL,
)
if not m5:
    die("Anchor 5 (ProcessUserEvent) not found in " + f)
hook5 = (m5.group(1) + m5.group(4) + m5.group(5)
         + '\n         if(this.fcmEventSafe(String(' + m5.group(2) + '),' + m5.group(3)
         + ')) { ' + m5.group(6) + ' = true; }')
src = src.replace(m5.group(0), hook5, 1)

# Anchor 6: chatEntryKeyUp — confirm the native chat field receives typed keys
# and provide live red/amber length feedback.
m6 = re.search(r'(internal function chatEntryKeyUp\((\w+):KeyboardEvent\) : void\n      \{)', src)
if not m6:
    die("Anchor 6 (chatEntryKeyUp) not found in " + f)
hook6 = ('\n         if (' + m6.group(2) + '.keyCode == 13 || ' + m6.group(2) + '.keyCode == 27)'
         '\n         { this._fcmInputActive = false; this.fcmResetNavigation(); }'
         '\n         this.fcmLog("info","type","kc=" + ' + m6.group(2) + '.keyCode);'
         '\n         this.fcmCheckLength();')
src = src.replace(m6.group(1), m6.group(1) + hook6, 1)

open(f, "w", encoding="latin1").write(src)
print("patched", f)
