import flash.display.MovieClip;
import flash.display.Shape;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.events.IOErrorEvent;

/**
 * FCMChatWidget — HUDModLoader widget for Fallout Chat Mod.
 *
 * Transport: ZFE chat.v1 native API (ZFE 0.9.8+).
 *   __ZFE.call("chat.v1.connect",    payload)   — register + connect
 *   __ZFE.call("chat.v1.pollEvents", payload)   — cursor-based event poll
 *   __ZFE.call("chat.v1.sendMessage",payload)   — send a message
 *   __ZFE.call("chat.v1.getAuthState","{}") — connection/auth health
 *
 * Input path: SharedHUDTools.TextEdit / FormatTextEdit — the HUDModLoader-native
 * text-entry mechanism. All SharedHUDTools usage (FormatTextEdit, TextEdit,
 * Register, RegisterMenu) is kept intact from the pre-chat.v1 build.
 *
 * ZFE API discovery: widget runs in HUDModLoader's ApplicationDomain (shared with
 * HUDMenu). ZFE attaches __ZFE to the HUDMenu top-level frame — findZfeApi()
 * walks parent/root/stage to find it. No env vars or child_bridge_access needed
 * because the widget is a sibling of HUDMenu, not a child SWF.
 *
 * Channel slugs (AllowedChannels in Data/ZFE/TextChat/fragments/FCM.ini):
 *   global, trade, server, events, raids, infests
 * DefaultChannel: global
 *
 * worldId self-read (#293, EULA §4(F)-safe — UI layer only, no memory reads):
 * BSUIDataManager.GetDataFromClient("AccountInfoData") exposes worldId.
 * A control message (sentinel prefix + worldId + HMAC-SHA256) is sent over
 * chat.v1.sendMessage (channel "server") and intercepted by the relay.
 *
 * Auth state:
 *   "authenticated" — player may send.
 *   "limited"       — account not yet linked; receive only; pinned link-code notice shown.
 *
 * SWF CRASH HARD RULES (violations crashed the game in production):
 *   1. NO GlowFilter / DropShadow or any .filters assignment on MovieClip/Sprite.
 *   2. NO raw HTML entities (&amp; etc.) in htmlText — use numeric refs only.
 *   3. Live content is zfeSafe()d server-side; renderRecords() trusts that.
 *   4. Debug text: tf.text (plain), NEVER tf.htmlText.
 *   5. Extensions.enabled = true before ANY scaleform.gfx.* call.
 *   6. embedFonts = true + a real embedded/known font; text goes blank otherwise.
 *   7. No fl.motion.*, shaders, gradient masks, networking classes.
 *   8. No TextField update per-frame; event-driven only.
 *
 * Docs:
 *   docs/overlay/zfe/native-chat-relay/protocol-spec.md  — chat.v1 call surface
 *   docs/overlay/zfe/native-chat-relay/fcm-integration.md — FCM relay adapter + worldId
 */
class FCMChatWidget extends MovieClip {

    // ── Widget identity ────────────────────────────────────────────────────────
    static inline var VENDOR:String   = "FCMChatWidget";
    static inline var VERSION:String  = "2.0.3";  // fix: minimal safe findZfeApi (no BFS traversal)
    // Expose for HUDModLoader hot-reload
    public var isReloadable:Bool      = true;

    // ── chat.v1 poll / connect timing ─────────────────────────────────────────
    static inline var POLL_MS:Int          = 2000;
    static inline var CONNECT_RETRY_MS:Int = 3000;
    static inline var CONNECT_MAX_MS:Int   = 30000;
    // worldId re-read interval (ms)
    static inline var WORLD_POLL_MS:Int    = 5000;

    // ── Chat UX ───────────────────────────────────────────────────────────────
    static inline var MAX_MSGS:Int      = 100;   // ring buffer cap
    static inline var MAX_SEND_LEN:Int  = 225;   // truncate before send

    // ── Channel tables ────────────────────────────────────────────────────────
    // Slugs match AllowedChannels in Data/ZFE/TextChat/fragments/FCM.ini.
    // "server" (index 5) is the world-session channel — not directly selectable.
    static var CHAN_SLUGS:Array<String> = ["global", "trade", "events", "infests", "raids", "server"];
    static var CHAN_NAMES:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS", "SERVER"];

    // ── Default layout (overridden by FCMChat.ini) ────────────────────────────
    static inline var DEFAULT_X:Int        = 10;
    static inline var DEFAULT_Y:Int        = 10;
    static inline var DEFAULT_W:Int        = 480;
    static inline var DEFAULT_H:Int        = 330;
    static inline var DEFAULT_FONT_SIZE:Int = 14;
    static inline var INPUT_H:Int           = 28;
    static inline var HDR_H:Int             = 24;
    static inline var TAB_H:Int             = 22;
    static inline var SUB_H:Int             = 20;
    static inline var STATUS_H:Int          = 18;

    // ── Design tokens — amber Pip-Boy theme ───────────────────────────────────
    static inline var BG_COLOR:Int             = 0x0A0907;
    static inline var CHROME_COLOR:Int         = 0x0C0A08;
    static inline var PRIMARY:Int              = 0xF5CB5B;
    static inline var PRIMARY_HEX:String       = "#F5CB5B";
    static inline var PRIMARY_HEX_NOHASH:String= "F5CB5B";
    static inline var TEXT_HEX:String          = "#FAF4DA";
    static inline var INACTIVE_HEX:String      = "#B49544";
    static inline var DIM_HEX:String           = "#AC9043";
    static inline var CHANNEL_HEX:String       = "#8FBC8F";
    static inline var BG_ALPHA:Float           = 0.94;

    // ── HMAC-SHA256 shared secret (worldId control message) ───────────────────
    // Matches WORLD_HMAC_SECRET in FCMBridge.hx and the relay.
    static inline var WORLD_HMAC_SECRET:String = "fcm-world-v1-dev-placeholder";
    static inline var WORLD_CTRL_PREFIX:String = "\x00fcm.world.v1\x00";

    // ── Config ────────────────────────────────────────────────────────────────
    var _cfgX:Int          = DEFAULT_X;
    var _cfgY:Int          = DEFAULT_Y;
    var _cfgW:Int          = DEFAULT_W;
    var _cfgH:Int          = DEFAULT_H;
    var _cfgFontSize:Int   = DEFAULT_FONT_SIZE;
    // Matches ZFE fragment OpenChatKey=PAGE_DOWN so one key opens both ZFE layer and HUDTools input.
    var _cfgOpenKey:String = "PAGE_DOWN";

    // ── Display objects ───────────────────────────────────────────────────────
    var _bg:Shape;
    var _logTf:TextField;
    var _inputPromptTf:TextField;
    var _hdrTf:TextField;
    var _tabTf:TextField;
    var _subTf:TextField;
    var _statusTf:TextField;
    var _fmt:TextFormat;

    // ── Chat render state ─────────────────────────────────────────────────────
    var _records:Array<String>   = [];
    var _bScrolling:Bool         = false;
    var _newWhileScrolled:Int    = 0;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int             = 0;   // 0=global

    // ── chat.v1 session state ─────────────────────────────────────────────────
    var _api:Dynamic             = null;
    var _connected:Bool          = false;
    var _userId:String           = "";
    var _relayUserId:String      = "";
    var _displayName:String      = "Wanderer";
    var _connectDelay:Int        = CONNECT_RETRY_MS;
    var _connectAttempts:Int     = 0;
    var _cursor:Int              = 0;
    var _pollTimer:Timer         = null;
    var _connectTimer:Timer      = null;
    var _worldTimer:Timer        = null;
    var _lastWorldId:String      = "";

    // ── ZFE search retry ──────────────────────────────────────────────────────
    var _zfeSearchTimer:Timer    = null;
    var _zfeSearchTries:Int      = 0;
    static inline var ZFE_SEARCH_MS:Int    = 1000;
    static inline var ZFE_SEARCH_MAX:Int   = 30;

    // ── Auth state ────────────────────────────────────────────────────────────
    var _authState:String        = "limited";
    var _pinnedSystemBody:String = "";

    // ── SharedHUDTools (HUDModLoader input API) ───────────────────────────────
    var _hudTools:Dynamic        = null;
    var _inputOpen:Bool          = false;

    // ─────────────────────────────────────────────────────────────────────────

    static function main():Void {
        flash.Lib.current.addChild(new FCMChatWidget());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    // =========================================================================
    // Stage ready — load config then build panel
    // =========================================================================

    function onStage(e:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onStage);
        loadConfig();
    }

    function loadConfig():Void {
        var ul:URLLoader = new URLLoader();
        ul.addEventListener(Event.COMPLETE, onConfigLoaded);
        ul.addEventListener(IOErrorEvent.IO_ERROR, function(_) { afterConfig(); });
        try {
            ul.load(new URLRequest("../FCMChat.ini"));
        } catch (e:Dynamic) {
            afterConfig();
        }
    }

    function onConfigLoaded(e:Event):Void {
        var ul:URLLoader = cast e.target;
        parseIni(Std.string(ul.data));
        afterConfig();
    }

    function parseIni(raw:String):Void {
        var lines:Array<String> = raw.split("\n");
        var inSection:Bool = false;
        for (l in lines) {
            l = StringTools.trim(l);
            if (l.length == 0 || l.charAt(0) == ";") continue;
            if (l == "[FCMChat]") { inSection = true; continue; }
            if (l.charAt(0) == "[") { inSection = false; continue; }
            if (!inSection) continue;
            var eq:Int = l.indexOf("=");
            if (eq < 0) continue;
            var key:String = StringTools.trim(l.substr(0, eq)).toLowerCase();
            var val:String = StringTools.trim(l.substr(eq + 1));
            switch (key) {
                case "x":         _cfgX        = Std.parseInt(val);
                case "y":         _cfgY        = Std.parseInt(val);
                case "width":     _cfgW        = Std.parseInt(val);
                case "height":    _cfgH        = Std.parseInt(val);
                case "fontsize":  _cfgFontSize = Std.parseInt(val);
                case "openkey":   _cfgOpenKey  = val;
            }
        }
    }

    function afterConfig():Void {
        buildPanel();
        attachHUDModListeners();
        // Delay ZFE init 3 s — ZFE API may not be ready at SWF load time.
        var t:Timer = new Timer(3000, 1);
        t.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { init(); });
        t.start();
    }

    // =========================================================================
    // Panel chrome
    // =========================================================================

    function buildPanel():Void {
        var w:Int = _cfgW;
        var h:Int = _cfgH;
        var logH:Int = h - HDR_H - TAB_H - SUB_H - STATUS_H - INPUT_H;

        _bg = new Shape();
        var g = _bg.graphics;
        g.beginFill(BG_COLOR, BG_ALPHA);
        g.lineStyle(1, PRIMARY, 0.3);
        g.drawRect(0, 0, w, h);
        g.endFill();
        g.lineStyle();
        g.beginFill(CHROME_COLOR, 0.98);
        g.drawRect(1, 1, w - 2, HDR_H - 1);
        g.endFill();
        g.beginFill(0x080705, 0.98);
        g.drawRect(1, HDR_H, w - 2, TAB_H);
        g.endFill();
        g.beginFill(0x080705, 0.85);
        g.drawRect(1, HDR_H + TAB_H, w - 2, SUB_H);
        g.endFill();
        g.lineStyle(1, PRIMARY, 0.5);
        g.moveTo(0, HDR_H); g.lineTo(w, HDR_H);
        g.lineStyle(1, PRIMARY, 0.3);
        g.moveTo(0, HDR_H + TAB_H); g.lineTo(w, HDR_H + TAB_H);
        g.lineStyle(1, PRIMARY, 0.2);
        g.moveTo(0, HDR_H + TAB_H + SUB_H); g.lineTo(w, HDR_H + TAB_H + SUB_H);
        g.lineStyle(1, PRIMARY, 0.25);
        g.moveTo(0, HDR_H + TAB_H + SUB_H + logH); g.lineTo(w, HDR_H + TAB_H + SUB_H + logH);
        g.lineStyle(1, PRIMARY, 0.4);
        g.moveTo(0, h - INPUT_H); g.lineTo(w, h - INPUT_H);
        addChild(_bg);

        _hdrTf = makeChromeTf(8, 4, w - 16, HDR_H - 4);
        _hdrTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + PRIMARY_HEX + '"><b> FCM COMMUNITY CHAT</b></font>'
            + '<font face="$$MAIN_Font" size="11" color="' + INACTIVE_HEX + '">  v' + VERSION + '</font>';
        addChild(_hdrTf);

        _tabTf = makeChromeTf(8, HDR_H + 2, w - 16, TAB_H - 2);
        renderMainTabs();
        addChild(_tabTf);

        _subTf = makeChromeTf(8, HDR_H + TAB_H + 2, w - 16, SUB_H - 2);
        renderSubTabs();
        addChild(_subTf);

        var logY:Int = HDR_H + TAB_H + SUB_H + 4;
        _logTf = new TextField();
        _logTf.x = 6;
        _logTf.y = logY;
        _logTf.width  = w - 12;
        _logTf.height = logH - 6;
        _logTf.multiline  = true;
        _logTf.wordWrap   = true;
        _logTf.selectable = false;
        _logTf.mouseEnabled = false;
        _logTf.embedFonts = true;
        _fmt = new TextFormat();
        _fmt.font    = "$$MAIN_Font";
        _fmt.size    = _cfgFontSize;
        _fmt.color   = 0xFAF4DA;
        _fmt.leading = 3;
        _logTf.defaultTextFormat = _fmt;
        setLogText("connecting...");
        addChild(_logTf);

        _statusTf = makeChromeTf(6, h - INPUT_H - STATUS_H + 2, w - 12, STATUS_H - 2);
        setStatus("chat.v1: init");
        addChild(_statusTf);

        _inputPromptTf = makeChromeTf(6, h - INPUT_H + 4, w - 12, INPUT_H - 6);
        setInputPrompt(idlePrompt());
        addChild(_inputPromptTf);

        x = _cfgX;
        y = _cfgY;
    }

    function makeChromeTf(tx:Float, ty:Float, tw:Float, th:Float):TextField {
        var tf:TextField = new TextField();
        tf.x = tx; tf.y = ty;
        tf.width = tw; tf.height = th;
        tf.selectable = false;
        tf.mouseEnabled = false;
        tf.embedFonts = true;
        return tf;
    }

    function renderMainTabs():Void {
        if (_tabTf == null) return;
        _tabTf.htmlText =
            '<font face="$$MAIN_Font" size="13" color="' + PRIMARY_HEX + '"><b>[ FALLOUT 76 ]</b></font>'
            + '<font face="$$MAIN_Font" size="13" color="' + INACTIVE_HEX + '">  PARTY</font>';
    }

    function renderSubTabs():Void {
        if (_subTf == null) return;
        // Show only the first 5 (non-server) channels in the tab strip.
        var displayNames:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS"];
        var html:Array<String> = [];
        for (i in 0...displayNames.length) {
            var color:String = (i == _chanIdx) ? PRIMARY_HEX : INACTIVE_HEX;
            html.push('<font face="$$MAIN_Font" size="12" color="' + color + '"><b>' + displayNames[i] + '</b></font>');
        }
        _subTf.htmlText = html.join('<font face="$$MAIN_Font" size="12" color="' + INACTIVE_HEX + '">  </font>');
    }

    function idlePrompt():String {
        return '<font face="$$MAIN_Font" size="13" color="' + DIM_HEX + '">&#x203A; Press ['
            + _cfgOpenKey + '] to open chat  |  [NextPage] to switch channel</font>';
    }

    function setLogText(s:String):Void {
        if (_logTf == null) return;
        _logTf.htmlText = '<font face="$$MAIN_Font" size="' + _cfgFontSize + '" color="' + TEXT_HEX + '">' + s + '</font>';
    }

    function setStatus(s:String):Void {
        if (_statusTf == null) return;
        _statusTf.htmlText = '<font face="$$MAIN_Font" size="11" color="' + INACTIVE_HEX + '">' + s + '</font>';
    }

    function setInputPrompt(html:String):Void {
        if (_inputPromptTf == null) return;
        _inputPromptTf.htmlText = html;
    }

    // =========================================================================
    // HUDModLoader listeners — SharedHUDTools + stage user-event
    // =========================================================================

    function attachHUDModListeners():Void {
        try {
            stage.addEventListener("HUDMod::UserEvent", onUserEvent);
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "stageListenerFailed: " + Std.string(e));
        }
        constructHudTools();
    }

    /**
     * Construct a SharedHUDTools instance.
     *
     * SharedHUDTools is an INSTANCE class: new SharedHUDTools(modName, hudMode).
     * The class lives in HUDModLoader's ApplicationDomain (shared with all widgets).
     * We call Register(callback) to subscribe to the HUDTools IPC bus, which is
     * required before FormatTextEdit/TextEdit will work.
     * We call RegisterMenu to appear in the F12 HUDTools menu.
     */
    function constructHudTools():Void {
        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            if (cls != null) {
                _hudTools = untyped __new__(cls, VENDOR, "All");
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "Register"),
                    [function(sender:String, msg:String):Void { onHudMessage(sender, msg); }]);
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "RegisterMenu"),
                    [function(parentItem:String):Void { onBuildMenu(parentItem); },
                     function(item:String):Void { onSelectMenu(item); }]);
                zfeLog("info", "hud", "SharedHUDTools constructed + registered");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "SharedHUDToolsMissing: " + Std.string(e));
            setInputPrompt('<font face="$$MAIN_Font" size="12" color="' + DIM_HEX
                + '">&#x203A; Input unavailable (HUDModLoader not detected)</font>');
        }
    }

    function onHudMessage(sender:String, msg:String):Void {
        zfeLog("info", "hud", "msg from=" + sender + " body=" + msg.substr(0, 80));
    }

    function onBuildMenu(parentItem:Dynamic):Void {
        // No sub-items for now — widget just appears as a top-level entry.
    }

    function onSelectMenu(item:Dynamic):Void {
        // No menu items to handle yet.
    }

    /**
     * HUDMod::UserEvent handler.
     * event.EventName (String), event.IsKeyDown (Boolean) per HUDModUserEvent.as.
     */
    function onUserEvent(e:Dynamic):Void {
        var action:String = "";
        var isDown:Bool   = false;
        try { action = Std.string(e.EventName); }  catch (_:Dynamic) {}
        try { isDown = (e.IsKeyDown == true); }    catch (_:Dynamic) {}

        if (!isDown) {
            if (action == _cfgOpenKey || action == "Console"
                    || action == "ConsoleToggles" || action == "TeamChat") {
                if (!_inputOpen) openInput();
                return;
            }
            // NextPage (Page Down — dead in FO76 HUD) → cycle channel.
            if (action == "NextPage") {
                cycleChannel();
                return;
            }
        }
    }

    // =========================================================================
    // Channel switching
    // =========================================================================

    function cycleChannel():Void {
        // Cycle over the first 5 channels (skip "server" at index 5).
        _chanIdx = (_chanIdx + 1) % 5;
        _records = [];
        renderSubTabs();
        zfeLog("info", "chan", "switched to " + CHAN_SLUGS[_chanIdx]);
    }

    /**
     * Slash-command channel switching.
     * Returns true if the command matched (pure channel-switch — do not send as msg).
     */
    function switchChannelBySlash(cmd:String):Bool {
        cmd = cmd.toLowerCase();
        var idx:Int = -1;
        if      (cmd == "g" || cmd == "gen"     || cmd == "general")  idx = 0;
        else if (cmd == "t" || cmd == "trade"   || cmd == "trading")  idx = 1;
        else if (cmd == "e" || cmd == "event"   || cmd == "events")   idx = 2;
        else if (cmd == "i" || cmd == "inf"     || cmd == "infests")  idx = 3;
        else if (cmd == "r" || cmd == "raid"    || cmd == "raids")    idx = 4;
        if (idx < 0) return false;
        _chanIdx = idx;
        _records = [];
        renderSubTabs();
        zfeLog("info", "chan", "slash switched to " + CHAN_SLUGS[idx]);
        return true;
    }

    // =========================================================================
    // SharedHUDTools.TextEdit — open / submit
    // =========================================================================

    function openInput():Void {
        if (_inputOpen) return;
        if (_hudTools == null) {
            constructHudTools();
            if (_hudTools == null) return;
        }
        _inputOpen = true;
        setInputPrompt('<font face="$$MAIN_Font" size="13" color="' + PRIMARY_HEX + '">&#x203A; typing...</font>');

        var editX:Float = x + 6;
        var editY:Float = y + _cfgH - INPUT_H + 4;
        var editW:Float = _cfgW - 12;
        var editH:Float = INPUT_H - 6;

        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatTextEdit"),
                [editX, editY, editW, editH,
                 "$$MAIN_Font", _cfgFontSize,
                 PRIMARY_HEX_NOHASH,
                 "0C0A08",
                 0.96]);
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "FormatTextEdit threw: " + Std.string(e));
        }

        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "TextEdit"),
                [onInputSubmit, ""]);
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "TextEdit threw: " + Std.string(e));
            _inputOpen = false;
            setInputPrompt(idlePrompt());
        }
    }

    function onInputSubmit(text:Dynamic):Void {
        _inputOpen = false;
        setInputPrompt(idlePrompt());
        var s:String = (text == null) ? "" : Std.string(text);
        s = StringTools.trim(s);
        if (s.length == 0) return;
        sendMessage(s);
    }

    // =========================================================================
    // Send path — chat.v1
    // =========================================================================

    function sendMessage(raw:String):Void {
        if (_api == null || !_connected) {
            zfeLog("warn", "send", "not connected; cannot send");
            return;
        }
        if (_authState != "authenticated") {
            zfeLog("warn", "send", "send blocked; authState=" + _authState + " (account not linked)");
            // Show the link-code notice in the input bar.
            var hint:String = (_pinnedSystemBody.length > 0) ? _pinnedSystemBody : "Link your account at falloutchatmod.com/link to chat";
            setInputPrompt('<font face="$$MAIN_Font" size="12" color="#FF8C00">' + hint + '</font>');
            return;
        }

        // Slash-command channel switching: "/cmd" or "/cmd rest" or ".cmd" alias.
        if (raw.length > 1 && (raw.charAt(0) == "/" || raw.charAt(0) == ".")) {
            var spaceIdx:Int = raw.indexOf(" ");
            var slashCmd:String = (spaceIdx > 0) ? raw.substr(1, spaceIdx - 1) : raw.substr(1);
            if (switchChannelBySlash(slashCmd)) {
                var rest:String = (spaceIdx > 0) ? StringTools.trim(raw.substr(spaceIdx + 1)) : "";
                if (rest.length == 0) return;
                raw = rest;
            }
        }

        if (raw.length > MAX_SEND_LEN) raw = raw.substr(0, MAX_SEND_LEN);
        raw = fcmClean(raw);
        if (raw.length == 0) return;

        var slug:String = CHAN_SLUGS[_chanIdx];
        var payload:String = '{"channel":"' + jsonEscape(slug) + '","targetUserId":"","body":"' + jsonEscape(raw) + '"}';
        try {
            _api.call("chat.v1.sendMessage", payload);
            zfeLog("info", "send", "sent ch=" + slug + " len=" + raw.length);
        } catch (e:Dynamic) {
            zfeLog("warn", "send", "sendMessage threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // ZFE API discovery + chat.v1 boot
    // =========================================================================

    /**
     * init() — entry point called 3 s after stage attach.
     *
     * ZFE installs __ZFE on the HUDMenu root a few seconds after dxgi.dll loads.
     * The widget may init before that happens, so we retry every ZFE_SEARCH_MS ms
     * up to ZFE_SEARCH_MAX times (~30 s total). Each tick calls findZfeApi() which
     * does an exhaustive multi-strategy tree walk (see below).
     *
     * Once found we run the capability gate (chat.v1.getRuntimeInfo) then startConnect().
     */
    function init():Void {
        _zfeSearchTries = 0;
        tryFindZfe();
    }

    function tryFindZfe():Void {
        _zfeSearchTries++;
        _api = findZfeApi(this);
        if (_api != null) {
            onZfeFound();
            return;
        }
        if (_zfeSearchTries >= ZFE_SEARCH_MAX) {
            setLogText("ZFE not found\nInstall dxgi.dll + zfe.ini");
            setStatus("chat.v1: no ZFE after " + ZFE_SEARCH_MAX + "s");
            return;
        }
        setStatus("chat.v1: searching ZFE (" + _zfeSearchTries + "/" + ZFE_SEARCH_MAX + ")...");
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }
        _zfeSearchTimer = new Timer(ZFE_SEARCH_MS, 1);
        _zfeSearchTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _zfeSearchTimer = null;
            tryFindZfe();
        });
        _zfeSearchTimer.start();
    }

    function onZfeFound():Void {
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }

        // Capability gate: chat.v1.getRuntimeInfo returns {"capabilities":["zfe-chat-online-v1",...]}.
        // Do NOT use getRuntimeInfo (general) — that returns zfe-chat-v1 but NOT the chat-online
        // capability string. Verified from protocol-spec.md and dxgi.dll binary.
        try {
            var info:String = Std.string(_api.call("chat.v1.getRuntimeInfo", "{}"));
            if (info.indexOf("zfe-chat-online-v1") < 0) {
                zfeLog("warn", "startup", "zfe-chat-online-v1 not present; need ZFE 0.9.8+");
                setLogText("ZFE 0.9.8+ required\nfor chat.v1");
                setStatus("chat.v1: capability missing");
                return;
            }
            zfeLog("info", "startup", VENDOR + " " + VERSION + " loaded");
            zfeLog("info", "startup", "BUILD=chatv1-widget");
            zfeLog("info", "startup", "zfe-chat-online-v1 OK");
            zfeLog("info", "startup", "found after " + _zfeSearchTries + " attempt(s)");
        } catch (e:Dynamic) {
            zfeLog("warn", "startup", "getRuntimeInfo threw: " + Std.string(e));
        }

        _displayName = readDisplayName();
        startConnect();
    }

    // =========================================================================
    // chat.v1 connect / reconnect
    // =========================================================================

    function startConnect():Void {
        if (_api == null) return;
        _connectAttempts++;
        zfeLog("info", "connect", "attempt=" + _connectAttempts + " displayName=" + _displayName);
        setStatus("chat.v1: connecting...");

        var payload:String = '{"displayName":"' + jsonEscape(_displayName) + '","autoRegister":true}';
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.connect", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "connect", "call threw: " + Std.string(e));
            scheduleConnectRetry();
            return;
        }

        var rs:String = Std.string(result);
        if (rs.indexOf('"success":true') < 0 && rs.indexOf('success:true') < 0) {
            zfeLog("warn", "connect", "failed: " + rs.substr(0, 200));
            scheduleConnectRetry();
            return;
        }

        _connected = true;
        _connectDelay = CONNECT_RETRY_MS;
        zfeLog("info", "connect", "connected");
        setStatus("chat.v1: connected");
        setLogText("connected. loading...");

        refreshAuthState();
        _cursor = 0;
        startPollTimer();
        startWorldTimer();
    }

    function scheduleConnectRetry():Void {
        if (_connectTimer != null) return;
        _connectTimer = new Timer(_connectDelay, 1);
        _connectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _connectTimer = null;
            _connectDelay = Std.int(Math.min(_connectDelay * 2, CONNECT_MAX_MS));
            startConnect();
        });
        _connectTimer.start();
        setStatus("chat.v1: retrying in " + Std.int(_connectDelay / 1000) + "s...");
    }

    // =========================================================================
    // chat.v1 auth state
    // =========================================================================

    function refreshAuthState():Void {
        if (_api == null) return;
        try {
            var state:String = Std.string(_api.call("chat.v1.getAuthState", "{}"));
            var uid:String = extractJsonString(state, "userId");
            if (uid.length > 0) {
                _userId = uid;
                _relayUserId = uid;
                zfeLog("info", "auth", "userId=" + uid.substr(0, 16) + "...");
            }
            var prevAuth:String = _authState;
            if (state.indexOf('"state":"authenticated"') >= 0 || state.indexOf('state:"authenticated"') >= 0) {
                _authState = "authenticated";
            } else {
                _authState = "limited";
            }
            if (_authState != prevAuth) {
                zfeLog("info", "auth", "authState=" + _authState);
                renderRecords();
            }
            if (_authState != "authenticated" && _connected) {
                zfeLog("warn", "auth", "state not authenticated; reconnecting");
                _connected = false;
                stopPollTimer();
                scheduleConnectRetry();
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "auth", "getAuthState threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // chat.v1 poll events
    // =========================================================================

    function startPollTimer():Void {
        stopPollTimer();
        _pollTimer = new Timer(POLL_MS);
        _pollTimer.addEventListener(TimerEvent.TIMER, function(_) { pollEvents(); });
        _pollTimer.start();
        pollEvents(); // immediate first poll for history
    }

    function stopPollTimer():Void {
        if (_pollTimer != null) { _pollTimer.stop(); _pollTimer = null; }
    }

    function pollEvents():Void {
        if (_api == null || !_connected) return;
        var payload:String = '{"max":64,"cursor":' + _cursor + '}';
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.pollEvents", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "poll", "call threw: " + Std.string(e));
            return;
        }

        var rs:String = Std.string(result);
        if (rs.indexOf('"success":false') >= 0 || rs.indexOf('success:false') >= 0) {
            if (rs.indexOf('auth_token_invalid') >= 0 || rs.indexOf('auth_token_revoked') >= 0
                    || rs.indexOf('user_banned') >= 0) {
                zfeLog("warn", "poll", "auth error; reconnecting");
                _connected = false;
                stopPollTimer();
                scheduleConnectRetry();
            }
            return;
        }

        parseAndRenderEvents(rs);
    }

    function parseAndRenderEvents(rs:String):Void {
        var evStart:Int = rs.indexOf('"events":[');
        if (evStart < 0) evStart = rs.indexOf('events:[');
        if (evStart < 0) return;

        var newRecords:Bool = false;
        var i:Int = evStart;
        while (i < rs.length) {
            var objStart:Int = rs.indexOf('{', i);
            if (objStart < 0) break;
            var depth:Int = 0;
            var j:Int = objStart;
            while (j < rs.length) {
                var c:String = rs.charAt(j);
                if (c == '{') depth++;
                else if (c == '}') { depth--; if (depth == 0) break; }
                j++;
            }
            if (j >= rs.length) break;
            var obj:String = rs.substring(objStart, j + 1);
            i = j + 1;

            if (obj.indexOf('"chat.message"') < 0 && obj.indexOf('chat.message') < 0) {
                updateCursorFromEvent(obj);
                continue;
            }

            var channel:String      = extractJsonString(obj, "channel");
            var senderUserId:String = extractJsonString(obj, "senderUserId");
            var displayName:String  = extractJsonString(obj, "senderDisplayName");
            var body:String         = extractJsonString(obj, "body");
            var evId:Int            = extractJsonInt(obj, "id");

            if (evId > _cursor) _cursor = evId;
            if (body.length == 0) continue;

            // System channel — pinned link-code notice.
            if (channel == "system" || senderUserId == "system") {
                _pinnedSystemBody = body;
                zfeLog("info", "system", "pinned system notice updated");
                newRecords = true;
                continue;
            }

            // Filter to active channel (server channel always passes through).
            var activeSlug:String = CHAN_SLUGS[_chanIdx];
            if (channel != activeSlug && channel != "server") continue;

            // Record format: "#COLOR~channel~displayName~body"
            // Use PRIMARY_HEX for normal messages.
            _records.push(PRIMARY_HEX + "~" + channel + "~" + displayName + "~" + body);
            while (_records.length > MAX_MSGS) _records.shift();
            newRecords = true;
        }

        if (newRecords) renderRecords();
    }

    function updateCursorFromEvent(obj:String):Void {
        var evId:Int = extractJsonInt(obj, "id");
        if (evId > _cursor) _cursor = evId;
    }

    // =========================================================================
    // worldId self-read + HMAC control message (#293)
    // =========================================================================

    function startWorldTimer():Void {
        if (_worldTimer != null) { _worldTimer.stop(); _worldTimer = null; }
        _worldTimer = new Timer(WORLD_POLL_MS);
        _worldTimer.addEventListener(TimerEvent.TIMER, function(_) { checkWorldId(); });
        _worldTimer.start();
        checkWorldId();
    }

    function checkWorldId():Void {
        if (_api == null || !_connected) return;
        var worldId:String = readWorldId();
        if (worldId.length == 0 || worldId == _lastWorldId) return;
        _lastWorldId = worldId;
        zfeLog("info", "world", "worldId changed; sending control message");
        sendWorldIdControl(worldId);
    }

    function sendWorldIdControl(worldId:String):Void {
        if (_api == null || !_connected) return;
        var ts:String = Std.string(Std.int(flash.Lib.getTimer() / 1000));
        var sigData:String = worldId + _relayUserId + ts;
        var hmac:String = hmacSha256Hex(WORLD_HMAC_SECRET, sigData);
        var body:String = WORLD_CTRL_PREFIX + worldId + "|" + _relayUserId + "|" + ts + "|" + hmac;
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + jsonEscape(body) + '"}';
        try {
            _api.call("chat.v1.sendMessage", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "world", "sendMessage threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // Render
    // =========================================================================

    function renderRecords():Void {
        if (_logTf == null) return;

        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        var html:Array<String> = [];
        var fs:Int = _cfgFontSize;

        // Pinned system notice — shown above feed when auth is limited.
        if (_authState != "authenticated" && _pinnedSystemBody.length > 0) {
            html.push('<font face="$$MAIN_Font" size="' + fs + '" color="#FF8C00">** '
                + _pinnedSystemBody + ' **</font>');
        }

        for (rec in _records) {
            var f:Array<String> = rec.split("~");
            if (f.length < 4) continue;
            var col:String  = ~/^#[0-9a-fA-F]{6}$/.match(f[0]) ? f[0] : PRIMARY_HEX;
            var ch:String   = f[1];
            var user:String = f[2];
            var msg:String  = f.slice(3).join("~");
            html.push(
                '<font face="$$MAIN_Font" size="' + fs + '">'
                + '<font color="' + CHANNEL_HEX + '">[' + ch + ']</font> '
                + '<b><font color="' + col + '">' + user + ':</font></b> '
                + '<font color="' + TEXT_HEX + '">' + msg + '</font>'
                + '</font>');
        }

        if (html.length == 0) { setLogText("no messages yet"); return; }
        _logTf.htmlText = html.join("<br/>");

        if (!_bScrolling) {
            try { _logTf.setSelection(_logTf.length, _logTf.length); } catch (e:Dynamic) {}
        }
    }

    // =========================================================================
    // Scroll
    // =========================================================================

    public function scrollUp():Void {
        if (_logTf == null) return;
        if (_logTf.scrollV > 1) { _logTf.scrollV--; _bScrolling = true; updateScrollIndicator(); }
    }

    public function scrollDown():Void {
        if (_logTf == null) return;
        _logTf.scrollV++;
        if (_logTf.scrollV >= _logTf.maxScrollV) {
            _bScrolling = false; _newWhileScrolled = 0; updateScrollIndicator();
        }
    }

    public function scrollToBottom():Void {
        if (_logTf == null) return;
        try { _logTf.setSelection(_logTf.length, _logTf.length); } catch (e:Dynamic) {}
        _bScrolling = false; _newWhileScrolled = 0; updateScrollIndicator();
    }

    function updateScrollIndicator():Void {
        if (_newWhileScrolled > 0) {
            setStatus("chat.v1: live  |  +" + _newWhileScrolled + " new"
                + (_newWhileScrolled == 1 ? " message" : " messages") + " below");
        } else if (_connected) {
            setStatus("chat.v1: live");
        }
    }

    // =========================================================================
    // BSUIDataManager reads — displayName + worldId
    // =========================================================================

    function readDisplayName():String {
        try {
            var a:Dynamic = untyped __global__["BSUIDataManager"].GetDataFromClient("AccountInfoData");
            if (a != null && a.data != null && a.data.name != null) {
                var n:String = Std.string(a.data.name);
                if (n.length > 0) return jsonEscape(n.substr(0, 64));
            }
        } catch (e:Dynamic) {}
        return "Wanderer";
    }

    function readWorldId():String {
        try {
            var a:Dynamic = untyped __global__["BSUIDataManager"].GetDataFromClient("AccountInfoData");
            if (a != null && a.data != null && a.data.worldId != null) {
                var w:String = Std.string(a.data.worldId);
                if (w.length > 0) return w;
            }
        } catch (e:Dynamic) {}
        return "";
    }

    // =========================================================================
    // HMAC-SHA256 — same implementation as FCMBridge.hx
    // =========================================================================

    static function hmacSha256Hex(key:String, data:String):String {
        var keyBytes:Array<Int>  = stringToBytes(key);
        var dataBytes:Array<Int> = stringToBytes(data);
        if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
        while (keyBytes.length < 64) keyBytes.push(0);
        var ipad:Array<Int> = [];
        var opad:Array<Int> = [];
        for (i in 0...64) { ipad.push(keyBytes[i] ^ 0x36); opad.push(keyBytes[i] ^ 0x5c); }
        var inner:Array<Int> = sha256(ipad.concat(dataBytes));
        var outer:Array<Int> = sha256(opad.concat(inner));
        return bytesToHex(outer);
    }

    static var K:Array<Int> = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    static function sha256(bytes:Array<Int>):Array<Int> {
        var msg:Array<Int> = bytes.copy();
        var len:Int = msg.length;
        msg.push(0x80);
        while ((msg.length % 64) != 56) msg.push(0);
        var bits:Float = len * 8;
        msg.push(0); msg.push(0); msg.push(0); msg.push(0);
        msg.push(Std.int(bits / 0x1000000) & 0xff);
        msg.push(Std.int(bits / 0x10000)   & 0xff);
        msg.push(Std.int(bits / 0x100)     & 0xff);
        msg.push(Std.int(bits)             & 0xff);

        var h0:Int = 0x6a09e667; var h1:Int = 0xbb67ae85;
        var h2:Int = 0x3c6ef372; var h3:Int = 0xa54ff53a;
        var h4:Int = 0x510e527f; var h5:Int = 0x9b05688c;
        var h6:Int = 0x1f83d9ab; var h7:Int = 0x5be0cd19;

        var chunk:Int = 0;
        while (chunk < msg.length) {
            var w:Array<Int> = [];
            for (i in 0...16) {
                w.push((msg[chunk+i*4]<<24)|(msg[chunk+i*4+1]<<16)|(msg[chunk+i*4+2]<<8)|msg[chunk+i*4+3]);
            }
            for (i in 16...64) {
                var s0:Int = ror32(w[i-15],7)  ^ ror32(w[i-15],18) ^ (w[i-15]>>>3);
                var s1:Int = ror32(w[i-2],17)  ^ ror32(w[i-2],19)  ^ (w[i-2]>>>10);
                w.push(add32(add32(add32(w[i-16], s0), w[i-7]), s1));
            }
            var a=h0; var b=h1; var c=h2; var d=h3;
            var e=h4; var f=h5; var g=h6; var h=h7;
            for (i in 0...64) {
                var S1:Int  = ror32(e,6)  ^ ror32(e,11) ^ ror32(e,25);
                var ch:Int  = (e & f) ^ ((~e) & g);
                var temp1:Int = add32(add32(add32(add32(h, S1), ch), K[i]), w[i]);
                var S0:Int  = ror32(a,2)  ^ ror32(a,13) ^ ror32(a,22);
                var maj:Int = (a & b) ^ (a & c) ^ (b & c);
                var temp2:Int = add32(S0, maj);
                h=g; g=f; f=e; e=add32(d,temp1);
                d=c; c=b; b=a; a=add32(temp1,temp2);
            }
            h0=add32(h0,a); h1=add32(h1,b); h2=add32(h2,c); h3=add32(h3,d);
            h4=add32(h4,e); h5=add32(h5,f); h6=add32(h6,g); h7=add32(h7,h);
            chunk += 64;
        }
        var out:Array<Int> = [];
        for (v in [h0,h1,h2,h3,h4,h5,h6,h7]) {
            out.push((v>>>24)&0xff); out.push((v>>>16)&0xff);
            out.push((v>>>8)&0xff);  out.push(v&0xff);
        }
        return out;
    }

    static inline function add32(a:Int, b:Int):Int { return untyped (a + b) | 0; }
    static inline function ror32(x:Int, n:Int):Int { return (x >>> n) | (x << (32 - n)); }

    static function stringToBytes(s:String):Array<Int> {
        var out:Array<Int> = [];
        for (i in 0...s.length) {
            var c:Int = s.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6));
                out.push(0x80 | (c & 0x3f));
            } else {
                out.push(0xe0 | (c >> 12));
                out.push(0x80 | ((c >> 6) & 0x3f));
                out.push(0x80 | (c & 0x3f));
            }
        }
        return out;
    }

    static function bytesToHex(bytes:Array<Int>):String {
        var hex:String = "0123456789abcdef";
        var out:String = "";
        for (b in bytes) { out += hex.charAt((b >> 4) & 0xf); out += hex.charAt(b & 0xf); }
        return out;
    }

    // =========================================================================
    // JSON helpers — minimal string scanning, no parser dependency
    // =========================================================================

    static function extractJsonString(json:String, key:String):String {
        var needle:String = '"' + key + '":"';
        var idx:Int = json.indexOf(needle);
        if (idx < 0) {
            needle = key + ':"';
            idx = json.indexOf(needle);
            if (idx < 0) return "";
        }
        var start:Int = idx + needle.length;
        var i:Int = start;
        while (i < json.length) {
            var c:String = json.charAt(i);
            if (c == '\\') { i += 2; continue; }
            if (c == '"')  break;
            i++;
        }
        return json.substring(start, i);
    }

    static function extractJsonInt(json:String, key:String):Int {
        var needle:String = '"' + key + '":';
        var idx:Int = json.indexOf(needle);
        if (idx < 0) {
            needle = key + ':';
            idx = json.indexOf(needle);
            if (idx < 0) return 0;
        }
        var start:Int = idx + needle.length;
        while (start < json.length && json.charAt(start) == ' ') start++;
        var end:Int = start;
        while (end < json.length && "0123456789-".indexOf(json.charAt(end)) >= 0) end++;
        if (end == start) return 0;
        return Std.parseInt(json.substring(start, end));
    }

    static function jsonEscape(s:String):String {
        if (s == null) return "";
        s = s.split("\\").join("\\\\");
        s = s.split('"').join('\\"');
        s = s.split("\r").join("\\r");
        s = s.split("\n").join("\\n");
        s = s.split("\t").join("\\t");
        return s;
    }

    static function fcmClean(s:String):String {
        if (s == null) return "";
        s = s.split("~").join(" ");
        s = s.split("\r").join(" ");
        s = s.split("\n").join(" ");
        s = s.split("\x00").join("");
        s = StringTools.trim(s);
        return s;
    }

    // =========================================================================
    // ZFE log
    // =========================================================================

    function zfeLog(level:String, category:String, message:String):Void {
        if (_api == null) return;
        try {
            _api.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level
                + '","category":"' + category + '","message":"' + jsonEscape(message) + '"}');
        } catch (e:Dynamic) {}
    }

    // =========================================================================
    // findZfeApi — minimal, bulletproof ZFE bridge discovery
    // =========================================================================

    /**
     * findZfeApi — finds the ZFE bridge object on the HUDMenu root.
     *
     * ARCHITECTURE:
     * ZFE (dxgi.dll) installs __ZFE on the HUDMenu root (stage.getChildAt(0)).
     * The widget display chain is: widget → Loader content root → Loader → HUDMenu root.
     * hudmodloader.as line 31: `this.topLevel = stage.getChildAt(0)` — same pattern used here.
     *
     * SAFETY RULES (crashes are real — GFx hard-crashes on bad dynamic property access):
     *   - Every single property read and child access is in its own try/catch.
     *   - NO getChildAt loop on arbitrary objects (only stage.getChildAt(0), guarded).
     *   - NO BFS over stage descendants — native Scaleform objects crash on numChildren/getChildAt.
     *   - NO hard casts (MovieClip(...), etc.) — dynamic untyped access only.
     *   - NO scope.stage[nm] or scope.root[nm] as dynamic property bags (crashes native objs).
     *   - parent-chain walk: each step in its own try/catch; loop does NOT propagate throws.
     *
     * Strategies (in order):
     *   1. stage.getChildAt(0)    — the HUDMenu root itself; most reliable.
     *   2. parent-chain walk      — up to 25 levels; each step independently guarded.
     *   3. scope.root             — widget's Loader content root (some ZFE configs).
     *   4. scope.stage            — stage object direct property (fallback).
     *
     * Returns bridge object with non-null .call, or null (caller retries via tryFindZfe).
     */
    static function findZfeApi(scope:Dynamic):Dynamic {
        var NAMES:Array<String> = ["__ZFE", "ZFECodeObj", "__SFCodeObj"];

        // check() probes one object for any of the known bridge property names.
        // Every access is individually guarded — a throw on one name never stops the others.
        function check(obj:Dynamic):Dynamic {
            if (obj == null) return null;
            for (nm in NAMES) {
                try {
                    var z:Dynamic = untyped obj[nm];
                    if (z != null) {
                        try { if (untyped z.call != null) return z; } catch (_:Dynamic) {}
                    }
                } catch (_:Dynamic) {}
            }
            return null;
        }

        // ── Strategy 1: stage.getChildAt(0) = HUDMenu root ───────────────────
        // This is the EXACT object ZFE installs __ZFE on. hudmodloader.as line 31
        // uses `stage.getChildAt(0)` to get its own topLevel reference.
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var hudMenuRoot:Dynamic = null;
                try { hudMenuRoot = st.getChildAt(0); } catch (_:Dynamic) {}
                if (hudMenuRoot != null) {
                    var z:Dynamic = check(hudMenuRoot);
                    if (z != null) return z;
                }
            }
        } catch (_:Dynamic) {}

        // ── Strategy 2: parent-chain walk (up to 25 levels) ──────────────────
        // Widget chain: widget → Loader content root → Loader → HUDMenu root.
        // Each parent step and each check() call is independently guarded.
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            var z:Dynamic = check(cur);
            if (z != null) return z;
            var next:Dynamic = null;
            try { next = cur.parent; } catch (_:Dynamic) {}
            cur = next;
            depth++;
        }

        // ── Strategy 3: scope.root ────────────────────────────────────────────
        // The widget SWF's own Loader content root. Some ZFE builds attach there.
        try {
            var r:Dynamic = null;
            try { r = scope.root; } catch (_:Dynamic) {}
            if (r != null) {
                var z:Dynamic = check(r);
                if (z != null) return z;
            }
        } catch (_:Dynamic) {}

        // ── Strategy 4: scope.stage direct property ───────────────────────────
        // Last resort — ZFE may register globally on the stage object itself.
        try {
            var st:Dynamic = null;
            try { st = scope.stage; } catch (_:Dynamic) {}
            if (st != null) {
                var z:Dynamic = check(st);
                if (z != null) return z;
            }
        } catch (_:Dynamic) {}

        return null;
    }
}
