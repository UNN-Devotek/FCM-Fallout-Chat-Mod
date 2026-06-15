#!/usr/bin/env python3
"""Apply the FCM two-way-chat injection to a decompiled HUDMenu.as (ffdec export).
Works on both the vanilla and HUDModLoader bases (anchors auto-detect param style).
Usage: python3 apply-patch.py <path/to/decompiled/HUDMenu.as>
Then recompile:  ffdec -replace <HUDMenu.swf> <out.swf> HUDMenu <patched HUDMenu.as>
Reproducible build; never commit Bethesda's HUDMenu source/SWF (IP)."""
import sys, re, os
HERE = os.path.dirname(os.path.abspath(__file__))

def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)

f = sys.argv[1]
src = open(f, encoding="latin1").read()

# ---------------------------------------------------------------------------
# IMPORTS — inject flash.display.Loader, flash.net.URLRequest, flash.system.*,
# and flash.text.TextFormat when not already present (needed for standalone build).
# The vanilla ffdec export omits these; the HUDModLoader base already has Loader/URLRequest.
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
# Improvement 4: _fcmInpRef cache for fcmFindByText result.
# Improvement 7: INI-loaded position fields.
# ---------------------------------------------------------------------------
FIELDS = ('      \n'
          '      public var _fcmLegacy:Object = null;\n      \n'
          '      public var _fcmZfe:Object = null;\n      \n'
          '      public var _fcmInited:Boolean = false;\n      \n'
          '      public var _fcmHelloSent:Boolean = false;\n      \n'
          '      public var _fcmLastEvent:String = "";\n      \n'
          '      public var _fcmChannelId:String = "00000000-0000-0000-0000-000000000005";\n      \n'
          '      public var _fcmChannelIdx:int = 0;\n      \n'
          '      public var _fcmInpRef:* = null;\n      \n'
          '      public var _fcmIniLoaded:Boolean = false;\n      \n'
          '      public var _fcmIniX:int = 0;\n      \n'
          '      public var _fcmIniY:int = 0;\n      \n'
          '      public var _fcmIniW:int = 0;\n      \n'
          '      public var _fcmIniH:int = 0;\n      \n'
          '      public var _fcmIniFontSize:int = 0;\n      \n'
          '      public var _fcmIniOpenKey:String = "";')

# Improvement 6: assert all injection points; exit with clear error if not found.

# Anchor 1: field declarations after HUDChatBase_mc
a1 = '      public var HUDChatBase_mc:MovieClip;'
if a1 not in src:
    die("Anchor 1 (HUDChatBase_mc field) not found in " + f)
src = src.replace(a1, a1 + FIELDS, 1)

# Anchor 2: fcmInit call after BSUIDataManager Subscribe
a2 = '         BSUIDataManager.Subscribe("CharacterInfoData",this.onCharacterInfoUpdate);'
if a2 not in src:
    die("Anchor 2 (CharacterInfoData Subscribe) not found in " + f)
src = src.replace(a2, a2 + '\n         this.fcmInit();', 1)

# Anchor 3: inject our methods before enterChatMode
methods = open(os.path.join(HERE, 'fcm-inject.as'), encoding="latin1").read().rstrip() + '\n      \n'
# enterChatMode is 'internal' on vanilla, 'public' on HUDModLoader — match either.
m3 = re.search(r'      (?:internal|public) function enterChatMode\(\) : \*', src)
if not m3:
    die("Anchor 3 (enterChatMode function) not found in " + f)
src = src.replace(m3.group(0), methods + m3.group(0), 1)

# Anchor 4: sendChatMessage forward — match either named (Message) or HUDModLoader (param1) arg.
# Improvement 1: fcmForward now does truncation internally (in fcm-inject.as).
m4 = re.search(r'(BSUIDataManager\.dispatchEvent\(new NetworkedUIEvent\("networked::UIEVENT","ChatMessage",[^,]+,"All",(\w+)\)\);)', src)
if not m4:
    die("Anchor 4 (sendChatMessage dispatch) not found in " + f)
src = src.replace(m4.group(1), m4.group(1) + '\n            this.fcmForward(' + m4.group(2) + ');', 1)

# Anchor 5: ProcessUserEvent diagnostic hook — the engine delivers NAMED actions here (the only
# input channel that fires for HUDMenu). Log every action so we see which key maps to what.
m5 = re.search(r'(public function ProcessUserEvent\((\w+):String, (\w+):Boolean\) : Boolean\n      \{)', src)
if not m5:
    die("Anchor 5 (ProcessUserEvent) not found in " + f)
src = src.replace(m5.group(1), m5.group(1) + '\n         this.fcmEvent(String(' + m5.group(2) + '),' + m5.group(3) + ');', 1)

# Anchor 6: chatEntryKeyUp probe — confirm the native chat field receives typed keys once open.
# Improvement 8: also call fcmCheckLength for live red/amber color feedback.
m6 = re.search(r'(internal function chatEntryKeyUp\((\w+):KeyboardEvent\) : void\n      \{)', src)
if not m6:
    die("Anchor 6 (chatEntryKeyUp) not found in " + f)
hook6 = ('\n         this.fcmLog("info","type","kc=" + ' + m6.group(2) + '.keyCode);'
         '\n         this.fcmCheckLength();')
src = src.replace(m6.group(1), m6.group(1) + hook6, 1)

open(f, "w", encoding="latin1").write(src)
print("patched", f)
