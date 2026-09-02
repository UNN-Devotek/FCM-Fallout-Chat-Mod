#!/usr/bin/env python3
"""Anchor assertions for apply-patch.py (chat.v1 build).

Verifies that all 6 injection anchors used by apply-patch.py are present in a
decompiled HUDMenu.as. Run this against a fresh ffdec export before patching to
confirm the game's HUDMenu has not moved any injection point.

Also verifies that fcm-inject.as contains the chat.v1 call surface and does NOT
contain the removed FCMHUD/1 socket verbs (writeUTFBytes / HELLO~ / SEND~).

Usage:
    python3 test_anchors.py <path/to/decompiled/HUDMenu.as>

Exit codes:
    0 — all assertions pass
    1 — one or more assertions fail (details printed to stderr)

Run without arguments to test fcm-inject.as alone (anchor checks are skipped).
"""
import sys, re, os
HERE = os.path.dirname(os.path.abspath(__file__))
INJECT_AS = os.path.join(HERE, 'fcm-inject.as')
WIDGET_HX = os.path.join(HERE, '..', 'hudmodloader-chat', 'FCMChatWidget.hx')
WIDGET_CONFIG_HX = os.path.join(HERE, '..', 'hudmodloader-chat', 'FcmConfig.hx')
WIDGET_INI = os.path.join(HERE, '..', 'hudmodloader-chat', 'FCMChatWidget.ini')

errors = []
warnings = []

def check(condition, label):
    if not condition:
        errors.append("FAIL: " + label)
    else:
        print("PASS: " + label)

def warn(condition, label):
    if not condition:
        warnings.append("WARN: " + label)

# ---------------------------------------------------------------------------
# 1. Verify fcm-inject.as — chat.v1 API presence + FCMHUD/1 removal
# ---------------------------------------------------------------------------
try:
    inject_src = open(INJECT_AS, encoding="latin1").read()
except FileNotFoundError:
    errors.append("FAIL: fcm-inject.as not found at " + INJECT_AS)
    inject_src = ""

if inject_src:
    # chat.v1 API must be present (delegated to FCMBridge).
    check("fcmSendMessage" in inject_src,
          "fcm-inject.as delegates to FCMBridge.fcmSendMessage (chat.v1)")
    check("_fcmBridge" in inject_src,
          "fcm-inject.as references _fcmBridge field")
    check("fcmSwitchChannelTo" in inject_src,
          "fcm-inject.as calls fcmSwitchChannelTo for channel switching")
    check("fcmChannelSlug" in inject_src,
          "fcm-inject.as uses channel slugs (not UUIDs)")
    check("_fcmChannelSlug" in inject_src,
          "fcm-inject.as tracks active channel as slug string")

    # OpenChatKey must use PAGE_DOWN (matches FCM.ini fragment).
    check('"PAGE_DOWN"' in inject_src,
          'fcm-inject.as default OpenChatKey is PAGE_DOWN (matches FCM.ini)')

    # FCMHUD/1 socket verbs must be GONE.
    check("writeUTFBytes" not in inject_src,
          "fcm-inject.as does NOT contain writeUTFBytes (FCMHUD/1 removed)")
    check('"HELLO~"' not in inject_src and "'HELLO~'" not in inject_src,
          "fcm-inject.as does NOT contain HELLO~ verb (FCMHUD/1 removed)")
    check('"SEND~"' not in inject_src and "'SEND~'" not in inject_src,
          "fcm-inject.as does NOT contain SEND~ verb (FCMHUD/1 removed)")
    check('"CHAN~"' not in inject_src and "'CHAN~'" not in inject_src,
          "fcm-inject.as does NOT contain CHAN~ verb (FCMHUD/1 removed)")
    check("_fcmHelloSent" not in inject_src,
          "fcm-inject.as does NOT contain _fcmHelloSent (HELLO not needed)")

    # Legacy bridge lookup (for socket) must be gone; ZFE lookup kept.
    # Check for function DEFINITIONS, not comment references.
    check("function fcmFindBridge" not in inject_src,
          "fcm-inject.as does NOT define fcmFindBridge function (legacy socket bridge removed)")
    check("fcmFindZfe" in inject_src,
          "fcm-inject.as still contains fcmFindZfe (__ZFE API lookup)")

    # Field declarations that apply-patch.py writes.
    check("_fcmBridge" in inject_src,
          "fcm-inject.as references _fcmBridge (relay bridge instance)")

    # Self-loader is retained (HUDModLoader-absent standalone path).
    check("fcmSelfLoadBridge" in inject_src,
          "fcm-inject.as retains fcmSelfLoadBridge (standalone self-loader)")
    check("FCMBridge.swf" in inject_src,
          "fcm-inject.as loads FCMBridge.swf via Loader (standalone path)")

    # ZFE host-pass: HUDMenu shares __ZFE with the child bridge (ZFE 0.9.8
    # child_bridge_access=disabled fix).
    check("fcmPassZfeToBridge" in inject_src,
          "fcm-inject.as defines fcmPassZfeToBridge (host ZFE pass-down for child_bridge_access=disabled)")
    check("hostZfe" in inject_src,
          "fcm-inject.as discovers hostZfe at HUDMenu level before passing")
    check("fcmSetZfe" in inject_src,
          "fcm-inject.as calls fcmSetZfe on the bridge (injects __ZFE reference)")
    check("__SFECodeObj" in inject_src and "fcmSetNativeApi" in inject_src,
          "fcm-inject.as passes the xScal chat bridge when ZFE is absent")

    # Channel table uses slugs, not UUIDs.
    check('"global"' in inject_src or "'global'" in inject_src,
          "fcm-inject.as channel table contains 'global' slug")
    check('"trade"' in inject_src or "'trade'" in inject_src,
          "fcm-inject.as channel table contains 'trade' slug")
    check('"events"' in inject_src or "'events'" in inject_src,
          "fcm-inject.as channel table contains 'events' slug")
    check('"infests"' in inject_src or "'infests'" in inject_src,
          "fcm-inject.as channel table contains 'infests' slug")
    check('"raids"' in inject_src or "'raids'" in inject_src,
          "fcm-inject.as channel table contains 'raids' slug")

    # UUID constants must be gone (they lived in the old fcmChannelUuid table).
    # Slugs ship to ZFE; the relay owns the UUID mapping.
    check("000000000005" not in inject_src,
          "fcm-inject.as does NOT contain raw channel UUIDs (relay owns mapping)")

# ---------------------------------------------------------------------------
# 2. Verify apply-patch.py FIELDS block uses chat.v1 field names
# ---------------------------------------------------------------------------
PATCH_PY = os.path.join(HERE, 'apply-patch.py')
try:
    patch_src = open(PATCH_PY, encoding="latin1").read()
except FileNotFoundError:
    errors.append("FAIL: apply-patch.py not found at " + PATCH_PY)
    patch_src = ""

if patch_src:
    check("_fcmBridge" in patch_src,
          "apply-patch.py FIELDS includes _fcmBridge")
    check("_fcmChannelSlug" in patch_src,
          "apply-patch.py FIELDS includes _fcmChannelSlug (slug, not UUID)")
    # These fields were removed in the chat.v1 rewrite; they must not appear in
    # the FIELDS constant (the generated AS3 code block). The FIELDS string is
    # delimited by triple-quotes; check it specifically, not the whole file.
    import ast
    fields_block = ""
    m_fields = re.search(r"^FIELDS\s*=\s*\(([^)]+)\)", patch_src, re.MULTILINE | re.DOTALL)
    if m_fields:
        # Reconstruct the string value by evaluating the concat safely.
        try:
            fields_block = eval(m_fields.group(0).split("=", 1)[1].strip())
        except Exception:
            fields_block = m_fields.group(1)
    check("_fcmHelloSent" not in fields_block,
          "apply-patch.py FIELDS constant does NOT include _fcmHelloSent (removed)")
    check("_fcmChannelId:" not in fields_block and '"_fcmChannelId"' not in fields_block,
          "apply-patch.py FIELDS constant does NOT include _fcmChannelId (UUID field removed)")

# ---------------------------------------------------------------------------
# 3. Verify TextChat fragment — FCM.ini
# ---------------------------------------------------------------------------
FRAGMENT_INI = os.path.join(HERE, '..', 'Data', 'ZFE', 'TextChat', 'fragments', 'FCM.ini')
try:
    ini_src = open(FRAGMENT_INI, encoding="utf-8").read()
except FileNotFoundError:
    errors.append("FAIL: FCM.ini fragment not found at " + os.path.normpath(FRAGMENT_INI))
    ini_src = ""

if ini_src:
    check("[TextChat]" in ini_src,
          "FCM.ini has [TextChat] section")
    check("AllowedChannels=" in ini_src,
          "FCM.ini has AllowedChannels key")
    check("DefaultChannel=global" in ini_src,
          "FCM.ini DefaultChannel is global")
    check("OpenChatKey=PAGE_DOWN" in ini_src,
          "FCM.ini OpenChatKey is PAGE_DOWN")
    check("EnableTimestamps=true" in ini_src,
          "FCM.ini EnableTimestamps=true")
    check("Endpoint=" in ini_src,
          "FCM.ini has Endpoint placeholder")
    # AllowedChannels must contain all 6 FCM slugs.
    for slug in ("global", "trade", "server", "events", "raids", "infests"):
        check(slug in ini_src,
              "FCM.ini AllowedChannels contains slug: " + slug)

# ---------------------------------------------------------------------------
# 4. Verify FCMBridge.hx — chat.v1 API presence + FCMHUD/1 removal
# ---------------------------------------------------------------------------
BRIDGE_HX = os.path.join(HERE, '..', 'FCMBridge.hx')
try:
    bridge_src = open(BRIDGE_HX, encoding="utf-8").read()
except FileNotFoundError:
    errors.append("FAIL: FCMBridge.hx not found at " + os.path.normpath(BRIDGE_HX))
    bridge_src = ""

if bridge_src:
    # chat.v1 API calls.
    check('"chat.v1.connect"' in bridge_src,
          "FCMBridge.hx calls chat.v1.connect")
    check('"chat.v1.pollEvents"' in bridge_src,
          "FCMBridge.hx calls chat.v1.pollEvents")
    check('"chat.v1.sendMessage"' in bridge_src,
          "FCMBridge.hx calls chat.v1.sendMessage")
    check('"chat.v1.getAuthState"' in bridge_src,
          "FCMBridge.hx calls chat.v1.getAuthState")

    # worldId self-read via BSUIDataManager (EULA-safe).
    check("BSUIDataManager" in bridge_src,
          "FCMBridge.hx reads worldId from BSUIDataManager (EULA §4(F)-safe)")
    check("worldId" in bridge_src,
          "FCMBridge.hx references worldId for server channel binding")
    check("HMAC" in bridge_src.upper() or "hmacSha256" in bridge_src,
          "FCMBridge.hx includes HMAC-SHA256 for worldId control message")
    check("WORLD_CTRL_PREFIX" in bridge_src,
          "FCMBridge.hx defines WORLD_CTRL_PREFIX sentinel for relay intercept")

    # Public send method called by fcm-inject.as.
    check("fcmSendMessage" in bridge_src,
          "FCMBridge.hx exposes public fcmSendMessage()")
    check("fcmSwitchChannelTo" in bridge_src,
          "FCMBridge.hx exposes public fcmSwitchChannelTo()")

    # Channel slugs used (not UUIDs).
    check("CHANNEL_SLUGS" in bridge_src,
          "FCMBridge.hx has CHANNEL_SLUGS array")
    for slug in ("global", "trade", "server", "events", "raids", "infests"):
        check('"' + slug + '"' in bridge_src,
              "FCMBridge.hx CHANNEL_SLUGS contains: " + slug)

    # Legacy socket layer must be GONE.
    check("readUTFBytes" not in bridge_src,
          "FCMBridge.hx does NOT contain readUTFBytes (legacy bridge removed)")
    check("writeUTFBytes" not in bridge_src,
          "FCMBridge.hx does NOT contain writeUTFBytes (legacy bridge removed)")
    check("findLegacyBridge" not in bridge_src,
          "FCMBridge.hx does NOT contain findLegacyBridge (legacy bridge removed)")
    check("isLegacyBridge" not in bridge_src,
          "FCMBridge.hx does NOT contain isLegacyBridge (legacy bridge removed)")
    check('"FCMHUD/1"' not in bridge_src,
          "FCMBridge.hx does NOT reference FCMHUD/1 protocol string")

    # zfe-chat-online-v1 capability check.
    check("zfe-chat-online-v1" in bridge_src,
          "FCMBridge.hx checks for zfe-chat-online-v1 capability at startup")

    # Auth state gate — limited-state rendering + input gate (#device-link).
    check("_authState" in bridge_src,
          "FCMBridge.hx tracks _authState field")
    check('"authenticated"' in bridge_src,
          'FCMBridge.hx compares against "authenticated" authState value')
    check('"limited"' in bridge_src,
          'FCMBridge.hx references "limited" authState value')
    check("fcmCanSend" in bridge_src,
          "FCMBridge.hx exposes public fcmCanSend() for input gate")
    check("fcmLinkHint" in bridge_src,
          "FCMBridge.hx exposes public fcmLinkHint() for hint text")

    # Pinned system notice — relay push of link-code as system channel event.
    check("_pinnedSystemBody" in bridge_src,
          "FCMBridge.hx stores _pinnedSystemBody for link-code pin")
    check('"system"' in bridge_src,
          'FCMBridge.hx special-cases channel == "system" (pinned notice)')
    check("senderUserId" in bridge_src,
          "FCMBridge.hx also checks senderUserId == system for system events")
    check("pinned system notice" in bridge_src.lower() or "pinnedSystemBody" in bridge_src,
          "FCMBridge.hx renders pinned system notice above feed")

    # The legacy renderer assigns the final feed string to GFx htmlText. Keep
    # the same numeric-reference escaping contract as FcmConfig.htmlEscape:
    # named entities are rejected by the Fallout 76 Scaleform parser.
    check('static function htmlEscape(s:String):String' in bridge_src,
          "FCMBridge.hx defines numeric-reference htmlEscape")
    for source, escaped, label in (
        ('StringTools.replace(s, "&", "&#38;")', "&#38;", "ampersand"),
        ('StringTools.replace(s, "<", "&#60;")', "&#60;", "less-than"),
        ('StringTools.replace(s, ">", "&#62;")', "&#62;", "greater-than"),
        ('''StringTools.replace(s, '"', "&#34;")''', "&#34;", "double-quote"),
    ):
        check(source in bridge_src and escaped in bridge_src,
              "FCMBridge.hx htmlEscape covers " + label + " with numeric reference")
    render_match = re.search(r"function renderRecords\(records:Array<String>\):Void \{(.*?)\n    \}\n\n    function setText", bridge_src, re.DOTALL)
    check(render_match is not None,
          "FCMBridge.hx renderRecords body is inspectable for escaping coverage")
    if render_match is not None:
        render_body = render_match.group(1)
        check("htmlEscape(_pinnedSystemBody)" in render_body,
              "FCMBridge.hx escapes the pinned system body before htmlText")
        check("htmlEscape(name)" in render_body and "htmlEscape(body)" in render_body,
              "FCMBridge.hx escapes remote sender and body before htmlText")

    # Gate in fcmSendMessage must block when not authenticated.
    check("send blocked" in bridge_src or "_authState != \"authenticated\"" in bridge_src,
          "FCMBridge.hx fcmSendMessage blocks send when authState != authenticated")

    # worldId sends must still be unblocked by the auth gate (HMAC channel, not normal send).
    # The sendWorldIdControl call goes directly to _api.call, bypassing the _authState check.
    check("sendWorldIdControl" in bridge_src,
          "FCMBridge.hx sendWorldIdControl is separate from gated fcmSendMessage")

    # ZFE host-inject: fcmSetZfe lets the parent SWF share __ZFE with the child
    # (child_bridge_access=disabled fix for ZFE 0.9.8).
    check("fcmSetZfe" in bridge_src,
          "FCMBridge.hx exposes public fcmSetZfe() for host-injected ZFE reference")
    check("postDiscoveryInit" in bridge_src,
          "FCMBridge.hx has postDiscoveryInit() helper (shared by self-discovery and host-inject paths)")
    check("_zfeInjectedByHost" in bridge_src,
          "FCMBridge.hx tracks _zfeInjectedByHost to guard against double-init")
    check("FcmNativeApi.discover" in bridge_src and "fcmSetNativeApi" in bridge_src,
          "FCMBridge.hx discovers and accepts either native chat provider")

# ---------------------------------------------------------------------------
# 4c. Verify FCMChatWidget tab renderer lifecycle
# ---------------------------------------------------------------------------
# The widget previously rendered the borderless TextField tab strip at startup,
# then added HUDButton tabs in the exact same row on a SERVER-tab transition.
# This source-level guard keeps the mutually-exclusive renderer invariant in the
# CI job that already validates game-mod sources.
try:
    widget_src = open(WIDGET_HX, encoding="utf-8").read()
except FileNotFoundError:
    errors.append("FAIL: FCMChatWidget.hx not found at " + os.path.normpath(WIDGET_HX))
    widget_src = ""

if widget_src:
    check("static inline var USE_NATIVE_INPUT:Bool = true;" in widget_src,
          "FCMChatWidget attempts native input lazily on open")
    check('if (low == "false" || low == "true") return "";' in widget_src,
          "FCMChatWidget never renders bare boolean input responses as chat text")
    check("runStartupProbe()" not in widget_src,
          "FCMChatWidget never activates native input during startup")
    native_open = re.search(
        r"function openInputNative\(\):Bool \{(.*?)\n    \}",
        widget_src,
        re.DOTALL,
    )
    if native_open is None:
        check(False, "FCMChatWidget defines the lazy native input open path")
    else:
        native_body = native_open.group(1)
        clear_pos = native_body.find('callTop("clearChatInput", "{}")')
        read_pos = native_body.find('callTop("readChatInput", "{}")')
        visible_pos = native_body.find("_inputOpen   = true;")
        check(clear_pos >= 0 and read_pos > clear_pos and visible_pos > read_pos,
              "FCMChatWidget clears and verifies native input before showing it")
        check("activation buffer not clear; falling back" in native_body,
              "FCMChatWidget falls back when native activation leaves text behind")
    check("function openInputSharedHudTools" in widget_src,
          "FCMChatWidget retains the SharedHUDTools fallback")
    check("_nativeInputCommandFailed" in widget_src
          and "closeInputNative(true)" in widget_src
          and "_nativeInputUsable = false;" in widget_src,
          "FCMChatWidget disables native input after an in-session helper failure")
    check('var finalRaw:String = callTop("readChatInput", "{}");' in widget_src
          and "final read helper failed; dropping submit" in widget_src,
          "FCMChatWidget drops a submit when the final native buffer read fails")
    check("ev = untyped __new__(cls, 0, false, 0);" in widget_src,
          "FCMChatWidget supports the three-argument PlatformChangeEvent API")
    check("function showHudLoaderMenu" in widget_src
          and 'Reflect.field(_hudTools, "ShowMenu")' in widget_src
          and 'Reflect.field(_hudTools, "CloseMenu")' in widget_src
          and 'active && !_inputOpen' in widget_src
          and 'action == "F11"' in widget_src,
          "FCMChatWidget toggles the HUDModLoader menu on F11")
    rebuild_match = re.search(
        r"function rebuildChannelTabs\(\):Void \{(.*?)\n    \}",
        widget_src,
        re.DOTALL,
    )
    check(rebuild_match is not None,
          "FCMChatWidget defines rebuildChannelTabs")
    if rebuild_match is not None:
        rebuild_body = rebuild_match.group(1)
        check("buildChannelTabs()" not in rebuild_body,
              "FCMChatWidget never overlays HUDButtons on the static tab strip")
        check("renderSubTabs()" in rebuild_body,
              "FCMChatWidget rebuilds the static tab strip on world changes")

    check("hmacSha256Hex" not in widget_src,
          "FCMChatWidget does not ship a forgeable relay-control HMAC secret")
    check("jsonObjectEnd" in widget_src,
          "FCMChatWidget uses string-aware JSON object boundaries")
    check("findBSUI()" in widget_src,
          "FCMChatWidget resolves BSUIDataManager through the HUDModLoader-safe finder")
    check("function readLocalPlayerNameFromData" in widget_src
          and "isLocalPlayer" in widget_src
          and "characterName" in widget_src,
          "FCMChatWidget can inspect the local PlayerListData character candidate")
    check("function readNamedData" in widget_src
          and "CharacterInfoData" in widget_src,
          "FCMChatWidget can inspect the CharacterInfoData character candidate")
    check("function readAccountDisplayName" in widget_src
          and 'getBSUIData(mgr, "AccountInfoData")' in widget_src,
          "FCMChatWidget reads the public Fallout handle from AccountInfoData")
    check(re.search(r"^\s*function readDisplayNameWithAccountFallback", widget_src,
                    re.MULTILINE) is None,
          "FCMChatWidget has no obsolete compatibility resolver")
    check('static inline var VERSION:String  = "2.10.33";' in widget_src,
          "FCMChatWidget bumps the automatic provider selection build to version 2.10.33")
    check("FcmNativeApi.discover" in widget_src and "supportsNativeInput" in widget_src,
          "FCMChatWidget selects the provider and avoids ZFE-only input on xScal")
    check('MENU_ACTION_TIMEOUT_MS' in widget_src
          and 'true, false, MENU_ACTION_TIMEOUT_MS' in widget_src,
          "FCMChatWidget uses a positive repeatable HUDTools menu timeout")
    check('closeHudLoaderMenuAfterStateChange();' in widget_src
          and 'Auto-hide: ON' in widget_src and 'Auto-hide: OFF' in widget_src,
          "FCMChatWidget refreshes the auto-hide label after toggling")
    check('normalizeDiscordEmojiMarkup' in widget_src
          and 'displayBody' in widget_src,
          "FCMChatWidget normalizes Discord custom emoji for HUD rendering")
    check('FcmCommand.isRelink(s)' in widget_src
          and 'function requestRelink' in widget_src
          and 'CLEAR_AUTH_COMMAND:String = "clearChatAuth"' in widget_src,
          "FCMChatWidget exposes a guarded local-auth relink command")
    check('FcmConfig.hudTransportHasStar(hudTransport)' in widget_src
          and 'FcmConfig.hudTransportStarColor(hudTransport)' in widget_src,
          "FCMChatWidget decodes native-known HUD cosmetics transport")
    check('extractJsonBool(obj, "supporterStar")' in widget_src
          and 'supporterStarPresent' in widget_src
          and 'customTagHtml' in widget_src
          and 'SupporterStarBitmap' not in widget_src
          and 'setImageSubstitutions' not in widget_src
          and 'function makeSupporterStar' in widget_src
          and 'function positionStarOverlays' in widget_src
          and 'getCharBoundaries' in widget_src
          and 'FcmConfig.supporterStarColor' in widget_src
          and widget_src.find('moderationRefHtml =') < widget_src.find('if (rawTag.length > 0) rowPrefix')
          and 'U+2605' in widget_src,
          "FCMChatWidget renders supporter stars as guarded vector geometry, never as a HUD glyph or image")
    check('function isOwnEcho' in widget_src
          and 'ownEchoMatched=' in widget_src,
          "FCMChatWidget reconciles self-sends against authoritative live events")
    check('var ackSupporterStar:Bool = FcmConfig.supporterStarPresent(' in widget_src
          and 'FcmConfig.hudTransportHasStar(ackHudTransport)' in widget_src
          and 'FcmConfig.hudTransportStarColor(ackHudTransport)' in widget_src
          and 'awaiting authoritative live echo' in widget_src
          and 'ackCosmetics=' in widget_src,
          "FCMChatWidget waits for authoritative live cosmetics after a stripped send acknowledgement")
    check('function renderLogHtml(lines:Array<String>):Bool' in widget_src
          and 'Reflect.field(ext, "appendHtml")' in widget_src
          and '_logTf.htmlText = ""' in widget_src,
          "FCMChatWidget rebuilds the feed through guarded TextFieldEx.appendHtml fragments")
    check('static inline var LOG_INPUT_GAP:Int     = 4;' in widget_src
          and 'var logBottom:Int = h - INPUT_H - LOG_INPUT_GAP;' in widget_src
          and '_logTf.height = logHeight;' in widget_src
          and 'var editY:Float = y + _cfg.height - INPUT_H + 4;' in widget_src,
          "FCMChatWidget keeps the feed clip rectangle above the top-level HUDTools input")
    check('function snapLogToBottom():Void' in widget_src
          and '_logTf.setSelection(_logTf.length, _logTf.length)' in widget_src
          and 'snapLogToBottom();' in widget_src,
          "FCMChatWidget snaps new messages to the visible area above the input")
    check('function scheduleEchoPoll():Void' in widget_src
          and '_sendEchoPollTimer' in widget_src
          and 'scheduleEchoPoll();' in widget_src,
          "FCMChatWidget polls immediately after a successful send for the authoritative echo")
    fallout_name_match = re.search(
        r"function readFalloutDisplayName\([^)]*\):String \{(.*?)\n    \}\n\n    function hasResolvedDisplayName",
        widget_src,
        re.DOTALL,
    )
    check(fallout_name_match is not None,
          "FCMChatWidget defines an inspectable Fallout public-name resolver")
    if fallout_name_match is not None:
        fallout_name_body = fallout_name_match.group(1)
        check("readAccountDisplayName(mgr)" in fallout_name_body
              and "readLocalPlayerNameFromData" in fallout_name_body
              and 'readNamedData(mgr, "CharacterInfoData")' in fallout_name_body
              and "selectFalloutDisplayName(accountName, localName, characterInfoName)" in fallout_name_body,
              "FCMChatWidget makes AccountInfoData authoritative over character candidates")
    ready_match = re.search(
        r"function hasResolvedDisplayName\(\):Bool \{(.*?)\n    \}\n\n    /\*\*",
        widget_src,
        re.DOTALL,
    )
    check(ready_match is not None,
          "FCMChatWidget defines an inspectable Fallout identity readiness gate")
    if ready_match is not None:
        ready_body = ready_match.group(1)
        check("_falloutIdentityReady" in ready_body
              and "isUsableFalloutDisplayName" in ready_body
              and "_characterIdentityReady" not in ready_body,
              "FCMChatWidget readiness gate requires the Fallout account handle")
    check("function hasResolvedDisplayName():Bool" in widget_src,
          "FCMChatWidget has an explicit non-placeholder identity gate")
    start_connect_match = re.search(
        r"function startConnect\(\):Void \{(.*?)\n    \}\n\n    /\*\*",
        widget_src,
        re.DOTALL,
    )
    check(start_connect_match is not None,
          "FCMChatWidget defines an inspectable connect lifecycle")
    if start_connect_match is not None:
        start_connect_body = start_connect_match.group(1)
        reset_identity = start_connect_body.find("resetFalloutIdentity();")
        refresh_identity = start_connect_body.find("refreshDisplayName();")
        identity_gate = start_connect_body.find("if (!hasResolvedDisplayName())")
        identity_retry = start_connect_body.find("scheduleConnectRetry()", identity_gate)
        native_connect = start_connect_body.find('call("chat.v1.connect"', identity_gate)
        check(reset_identity >= 0 and refresh_identity > reset_identity,
              "FCMChatWidget resets cached Fallout identity before each connect probe")
        check(identity_gate >= 0 and identity_retry > identity_gate and native_connect > identity_retry,
              "FCMChatWidget defers native connect until HUD identity is resolved")
    refresh_match = re.search(
        r"function refreshDisplayName\([^)]*\):Void \{(.*?)\n    \}\n\n    // BSUIDataManager",
        widget_src,
        re.DOTALL,
    )
    check(refresh_match is not None,
          "FCMChatWidget defines an inspectable HUD identity refresh path")
    if refresh_match is not None:
        refresh_body = refresh_match.group(1)
        check("readFalloutDisplayName" in refresh_body
              and "readDisplayNameWithAccountFallback" not in refresh_body
              and "chat.v1.connect" not in refresh_body
              and "reconcileDisplayName" not in refresh_body,
              "FCMChatWidget keeps refreshDisplayName account-authoritative and observation-only")
    check("_lastSentDisplayName" not in widget_src
          and "reconcileDisplayName" not in widget_src,
          "FCMChatWidget has no cached late-identity native reconnect path")
    check("_editTextLockOwned" in widget_src,
          "FCMChatWidget tracks ownership of the game-input edit lock")
    check("if (!start && !_editTextLockOwned)" in widget_src,
          "FCMChatWidget never sends EndEditText without owning StartEditText")
    check("function releaseEditTextLock" in widget_src
          and "if (_editTextLockOwned) releaseEditTextLock()" in widget_src,
          "FCMChatWidget retries a failed EndEditText until the owned lock is released")
    check('Reflect.field(e, "actionName")' in widget_src
          and 'Reflect.field(e, "isDown")' in widget_src
          and 'Reflect.field(e, "EventName")' in widget_src
          and 'Reflect.field(e, "IsKeyDown")' in widget_src,
          "FCMChatWidget accepts current and legacy HUDModLoader event field names")
    check("action == _cfg.channelNextKey" in widget_src
          and "action == _cfg.channelPrevKey" in widget_src
          and "function isExternalInputAction" in widget_src,
          "FCMChatWidget handles channel actions and external focus recovery")
    check("function mergeNativeInputText" in widget_src
          and "_inProgress + observed" in widget_src,
          "FCMChatWidget preserves native drafts when ZFE returns one character at a time")
    check("applyServerControlResult" in widget_src
          and "_serverSessionReady" in widget_src,
          "FCMChatWidget gates SERVER on an acknowledged relay control")
    check("blank worldId ignored; fresh roster session remains authoritative" in widget_src,
          "FCMChatWidget keeps a fresh roster room when legacy worldId is blank")
    check('WORLD_ROSTER_PREFIX:String = "FCMCTL/1/ROSTER:"' in widget_src
          and 'var body:String = WORLD_ROSTER_PREFIX + namesField;' in widget_src,
          "FCMChatWidget sends printable roster controls")
    check('NUL:String      = ctrlChar(0)' in widget_src
          and 'UNIT_SEP:String = ctrlChar(31)' in widget_src,
          "FCMChatWidget builds compatibility control bytes at runtime, not in the SWF string pool")
    check('"HUDTools message received bodyLen=" + bodyLen' in widget_src
          and '"msg from=" + sender + " body="' not in widget_src
          and '"relay identity available"' in widget_src,
          "FCMChatWidget diagnostics avoid logging HUD text and relay identifiers")
    check('"FCMCTL/1/RESYNC"' in widget_src and 'function requestHistoryResync' in widget_src,
          "FCMChatWidget requests history replay after HUD reload")
    check('function shouldRenderReplayMessage' in widget_src and '_seenMessageIds' in widget_src,
          "FCMChatWidget deduplicates replayed history records")
    check('return FcmConfig.extractJsonString(json, key);' in widget_src
          and 'extractJsonString' in widget_src,
          "FCMChatWidget accepts whitespace-formatted JSON string members")
    check("Shared.AS3.Events.CustomEvent" in widget_src,
          "FCMChatWidget resolves the game-qualified CustomEvent for the edit lock")
    check("startTypeMirror" not in widget_src,
          "FCMChatWidget does not overlap the HUDTools entry with a duplicate typing mirror")
    check('["cz_reset",   "Reset all settings"' in widget_src,
          "FCMChatWidget exposes Reset all settings in the Customize submenu")
    check("_cfg = FcmConfig.resetToDefaults(_cfg);" in widget_src
          and 'if (id == "cz_reset")' in widget_src,
          "FCMChatWidget applies the authoritative defaults for the reset action")
    check('callTop("writeStorage", payload)' in widget_src
          and 'callTop("readStorage", payload)' in widget_src,
          "FCMChatWidget persists Customize settings in vendor-scoped ZFE storage")
    check('"chat.v1.moderationAction"' in widget_src
          and 'function handleModerationCommand' in widget_src,
          "FCMChatWidget exposes a HUD moderation command surface")
    check('"canKickUser"' in widget_src
          and '"canMuteUser"' in widget_src
          and '"canBanUser"' in widget_src,
          "FCMChatWidget renders moderation controls only from relay permissions")
    check('function resolveModerationTarget' in widget_src
          and 'StringTools.trim(rec.user).toLowerCase()' in widget_src
          and 'rec.messageId.substr(0, 8)' in widget_src
          and 'rec.senderUserId' in widget_src,
          "FCMChatWidget resolves visible names locally to immutable relay record IDs")
    check('tsHtml' not in widget_src
          and 'showTimestamps' not in widget_src
          and 'createdAt:String' not in widget_src,
          "FCMChatWidget never renders or depends on message timestamps")

try:
    widget_ini_src = open(WIDGET_INI, encoding="utf-8").read()
except FileNotFoundError:
    errors.append("FAIL: FCMChatWidget.ini not found at " + os.path.normpath(WIDGET_INI))
    widget_ini_src = ""

if widget_ini_src:
    check("OpenChatKey=INSERT" in widget_ini_src,
          "FCMChatWidget.ini uses INSERT as the native open-chat key")
    check("Endpoint=wss://falloutchatmod.com/relay" in widget_ini_src,
          "FCMChatWidget.ini targets the production /relay endpoint")
    endpoint_lines = [line.strip() for line in widget_ini_src.splitlines()
                      if line.strip().startswith("Endpoint=")]
    check(all("/zfe-relay" not in line for line in endpoint_lines),
          "FCMChatWidget.ini does not configure the obsolete /zfe-relay path")

# ---------------------------------------------------------------------------
# 4b. Verify fcm-inject.as auth gate additions
# ---------------------------------------------------------------------------
if inject_src:
    # Auth gate in fcmForward — must call fcmCanSend before forwarding.
    check("fcmCanSend" in inject_src,
          "fcm-inject.as calls fcmCanSend() to gate sending (limited-state check)")
    check("fcmLinkHint" in inject_src,
          "fcm-inject.as calls fcmLinkHint() to get hint text when send is blocked")
    check("fcmShowAuthHint" in inject_src,
          "fcm-inject.as defines and calls fcmShowAuthHint() to display link notice")
    check("falloutchatmod.com/link" in inject_src,
          "fcm-inject.as fallback hint references falloutchatmod.com/link")

    # Gated send must return before calling fcmSendMessage when not linked.
    check("canSend" in inject_src or "fcmCanSend" in inject_src,
          "fcm-inject.as checks canSend variable before fcmSendMessage call")

# ---------------------------------------------------------------------------
# 5. HUDMenu.as anchor checks (only when a file path is provided)
# ---------------------------------------------------------------------------
if len(sys.argv) > 1:
    hudmenu_path = sys.argv[1]
    try:
        hm_src = open(hudmenu_path, encoding="latin1").read()
    except (FileNotFoundError, IOError) as e:
        errors.append("FAIL: Cannot open HUDMenu.as: " + str(e))
        hm_src = ""

    if hm_src:
        print("\n--- HUDMenu.as anchor checks ---")

        # Anchor 1: HUDChatBase_mc field.
        check('public var HUDChatBase_mc:MovieClip;' in hm_src,
              "Anchor 1: HUDChatBase_mc field present")

        # Anchor 2: CharacterInfoData Subscribe.
        check('BSUIDataManager.Subscribe("CharacterInfoData",this.onCharacterInfoUpdate);' in hm_src,
              "Anchor 2: CharacterInfoData Subscribe present")

        # Anchor 3: enterChatMode function (vanilla or HUDModLoader variant).
        m3 = re.search(r'      (?:internal|public) function enterChatMode\(\) : \*', hm_src)
        check(m3 is not None,
              "Anchor 3: enterChatMode function present (internal or public)")

        # Anchor 4: sendChatMessage dispatch.
        m4 = re.search(r'BSUIDataManager\.dispatchEvent\(new NetworkedUIEvent\("networked::UIEVENT","ChatMessage",[^,]+,"All",(\w+)\)\);', hm_src)
        check(m4 is not None,
              'Anchor 4: sendChatMessage dispatch (NetworkedUIEvent "ChatMessage") present')

        # Anchor 5: ProcessUserEvent.
        m5 = re.search(r'public function ProcessUserEvent\((\w+):String, (\w+):Boolean\) : Boolean\n      \{', hm_src)
        check(m5 is not None,
              "Anchor 5: ProcessUserEvent function present")

        # Anchor 6: chatEntryKeyUp.
        m6 = re.search(r'internal function chatEntryKeyUp\((\w+):KeyboardEvent\) : void\n      \{', hm_src)
        check(m6 is not None,
              "Anchor 6: chatEntryKeyUp function present")

        if m3 is not None:
            warn("'flash.utils.setTimeout'" in hm_src,
                 "import flash.utils.setTimeout present (import anchor for EXTRA_IMPORTS)")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print()
if warnings:
    for w in warnings:
        print(w, file=sys.stderr)
if errors:
    for e in errors:
        print(e, file=sys.stderr)
    print("\n" + str(len(errors)) + " assertion(s) FAILED", file=sys.stderr)
    sys.exit(1)
else:
    print("All assertions passed.")
