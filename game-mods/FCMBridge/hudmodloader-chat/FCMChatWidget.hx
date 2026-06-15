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
 * Adds an amber-themed interactive chat UI (scrolling message log + text input)
 * as a HUDModLoader widget. Unlike FCMBridge.hx (receive-only feed display),
 * this widget also sends messages via the ZFE legacy bridge.
 *
 * Input path: HUDModUserEvent ("HUDMod::UserEvent") → SharedHUDTools instance TextEdit
 * — the HUDModLoader-native text-entry mechanism, which handles the
 * ControlMap::StartEditText / EndEditText cycle and gamepad OSK for us.
 *
 * SharedHUDTools API (from github.com/GitCrazy-wc/hudmodloader HUDTools/scripts/SharedHUDTools.as):
 *   - SharedHUDTools is an INSTANCE class: new SharedHUDTools(modName, hudMode)
 *   - Register(callback) — must be called once to register with HUDTools IPC bus
 *   - FormatTextEdit(x,y,w,h, font,size, hexColorStr, bgHexColorStr, bgAlpha) — color args are
 *     hex strings like "F5CB5B" (no leading #), bgAlpha is Number (-1 = no bg)
 *   - TextEdit(callback, startText) — opens input box; callback(text) fires on submit/cancel
 *     (null = cancel); callback fires once then is nulled by SharedHUDTools
 * HUDModUserEvent API (from HUDTools/scripts/HUDModUserEvent.as):
 *   - event.EventName (String) — the control-map action name (NOT "actionName")
 *   - event.IsKeyDown (Boolean) — true = key down (NOT "isDown")
 *   - Dispatched as "HUDMod::UserEvent" on stage (bubbling) by hudmodloader's ProcessUserEvent
 *
 * Receive path: shares the same ZFE legacy __SFCodeObj bridge and FCMHUD/1
 * line protocol as FCMBridge.hx. Both widgets drain the same socket; the
 * backend broadcasts once per message and both pick it up.
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
 */
class FCMChatWidget extends MovieClip {

    // ── Widget identity ────────────────────────────────────────────────────────
    static inline var VENDOR:String   = "FCMChatWidget";
    static inline var VERSION:String  = "1.0.0";
    // Expose for HUDModLoader hot-reload
    public var isReloadable:Bool      = true;

    // ── Socket constants (mirror FCMBridge.hx) ────────────────────────────────
    static inline var DRAIN_MS:Int          = 100;
    static inline var WATCHDOG_MS:Int       = 180000;
    static inline var RECONNECT_INIT_MS:Int = 2000;
    static inline var RECONNECT_MAX_MS:Int  = 60000;
    static inline var STALE_NUDGE_MS:Int    = 30000;
    static inline var BUF_CAP:Int           = 8192;

    // ── Chat UX ───────────────────────────────────────────────────────────────
    static inline var MAX_MSGS:Int      = 100;   // ring buffer cap
    static inline var MAX_SEND_LEN:Int  = 225;   // truncate before send

    // ── Channel tables (mirrors fcm-inject.as fcmChannelUuid/fcmChannelName) ──
    // General aggregate = 0005; individual channels are 0001-0004
    static var CHAN_NAMES:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS"];
    static var CHAN_UUIDS:Array<String> = [
        "00000000-0000-0000-0000-000000000005", // General aggregate
        "00000000-0000-0000-0000-000000000002", // Trading
        "00000000-0000-0000-0000-000000000003", // Events
        "983995c1-f9ab-44c0-9b78-8b4cbf497273", // Infests
        "00000000-0000-0000-0000-000000000004"  // Raids
    ];

    // ── Default layout (overridden by FCMChat.ini) ────────────────────────────
    static inline var DEFAULT_X:Int        = 10;
    static inline var DEFAULT_Y:Int        = 10;
    static inline var DEFAULT_W:Int        = 480;
    static inline var DEFAULT_H:Int        = 330;
    static inline var DEFAULT_FONT_SIZE:Int = 14;
    static inline var INPUT_H:Int           = 28;  // input bar height
    static inline var HDR_H:Int             = 24;  // header chrome height
    static inline var TAB_H:Int             = 22;  // main tab row height
    static inline var SUB_H:Int             = 20;  // sub-tab row height
    static inline var STATUS_H:Int          = 18;  // status strip height

    // ── Design tokens — amber Pip-Boy theme ───────────────────────────────────
    static inline var BG_COLOR:Int         = 0x0A0907;
    static inline var CHROME_COLOR:Int     = 0x0C0A08;
    static inline var PRIMARY:Int          = 0xF5CB5B;
    static inline var PRIMARY_HEX:String   = "#F5CB5B";
    static inline var PRIMARY_HEX_NOHASH:String = "F5CB5B";  // for SharedHUDTools
    static inline var TEXT_HEX:String      = "#FAF4DA";
    static inline var INACTIVE_HEX:String  = "#B49544";
    static inline var DIM_HEX:String       = "#AC9043";
    static inline var PENDING_HEX:String   = "#7A6A30";
    static inline var CHANNEL_HEX:String   = "#8FBC8F";
    static inline var BG_ALPHA:Float       = 0.94;

    // ── Config (loaded from FCMChat.ini, fallback to defaults) ────────────────
    var _cfgX:Int         = DEFAULT_X;
    var _cfgY:Int         = DEFAULT_Y;
    var _cfgW:Int         = DEFAULT_W;
    var _cfgH:Int         = DEFAULT_H;
    var _cfgFontSize:Int  = DEFAULT_FONT_SIZE;
    var _cfgOpenKey:String   = "Console";

    // ── Display objects ───────────────────────────────────────────────────────
    var _bg:Shape;
    var _logTf:TextField;         // scrolling message log
    var _inputPromptTf:TextField; // faux input row (idle hint / "typing...")
    var _hdrTf:TextField;         // header label
    var _tabTf:TextField;         // main tab row (FALLOUT 76 | PARTY)
    var _subTf:TextField;         // sub-tab row (GENERAL TRADING EVENTS ...)
    var _statusTf:TextField;      // status strip
    var _fmt:TextFormat;

    // ── Chat state ────────────────────────────────────────────────────────────
    var _records:Array<String>    = [];
    var _bScrolling:Bool          = false;
    var _newWhileScrolled:Int     = 0;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int      = 0;   // 0=General aggregate
    var _activeChannel:String = "general"; // driven by ACTIVECHAN from backend

    // ── Identity ──────────────────────────────────────────────────────────────
    var _accountName:String    = "";
    var _characterName:String  = "";
    var _helloSent:Bool        = false;

    // ── Socket (same pattern as FCMBridge.hx) ────────────────────────────────
    var _zfeApi:Dynamic        = null;
    var _legacy:Dynamic        = null;
    var _sock:Dynamic          = null;
    var _lineBuf:String        = "";
    var _liveActive:Bool       = false;
    var _lastLineAt:Float      = 0;
    var _reconnectDelay:Int    = RECONNECT_INIT_MS;
    var _drainTimer:Timer      = null;
    var _reconnectTimer:Timer  = null;
    var _connectAttempts:Int   = 0;
    var _connectIssuedAt:Float = 0;
    var _bufResetLogged:Bool   = false;

    // ── SharedHUDTools instance (HUDModLoader IPC) ────────────────────────────
    // SharedHUDTools is an INSTANCE class — new SharedHUDTools(modName, hudMode).
    // We construct it via getDefinitionByName to avoid a compile-time hard reference.
    // The class lives in HUDModLoader's ApplicationDomain (shared with all widgets).
    var _hudTools:Dynamic   = null;
    var _inputOpen:Bool     = false;

    // ─────────────────────────────────────────────────────────────────────────

    static function main():Void {
        flash.Lib.current.addChild(new FCMChatWidget());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    // =========================================================================
    // Stage ready — load config then build
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
    // Panel chrome — header + main tabs + sub-tabs + log + status + input bar
    // =========================================================================

    function buildPanel():Void {
        var w:Int = _cfgW;
        var h:Int = _cfgH;
        var logH:Int = h - HDR_H - TAB_H - SUB_H - STATUS_H - INPUT_H;

        // ── Background + border + chrome header bar ──
        _bg = new Shape();
        var g = _bg.graphics;
        g.beginFill(BG_COLOR, BG_ALPHA);
        g.lineStyle(1, PRIMARY, 0.3);
        g.drawRect(0, 0, w, h);
        g.endFill();
        g.lineStyle();
        // Header chrome bar
        g.beginFill(CHROME_COLOR, 0.98);
        g.drawRect(1, 1, w - 2, HDR_H - 1);
        g.endFill();
        // Main tab row background
        g.beginFill(0x080705, 0.98);
        g.drawRect(1, HDR_H, w - 2, TAB_H);
        g.endFill();
        // Sub-tab row background
        g.beginFill(0x080705, 0.85);
        g.drawRect(1, HDR_H + TAB_H, w - 2, SUB_H);
        g.endFill();
        // Dividers
        g.lineStyle(1, PRIMARY, 0.5);
        g.moveTo(0, HDR_H); g.lineTo(w, HDR_H);
        g.lineStyle(1, PRIMARY, 0.3);
        g.moveTo(0, HDR_H + TAB_H); g.lineTo(w, HDR_H + TAB_H);
        g.lineStyle(1, PRIMARY, 0.2);
        g.moveTo(0, HDR_H + TAB_H + SUB_H); g.lineTo(w, HDR_H + TAB_H + SUB_H);
        // Log / status divider
        g.lineStyle(1, PRIMARY, 0.25);
        g.moveTo(0, HDR_H + TAB_H + SUB_H + logH); g.lineTo(w, HDR_H + TAB_H + SUB_H + logH);
        // Status / input divider
        g.lineStyle(1, PRIMARY, 0.4);
        g.moveTo(0, h - INPUT_H); g.lineTo(w, h - INPUT_H);
        addChild(_bg);

        // ── Header label ──
        _hdrTf = makeChromeTf(8, 4, w - 16, HDR_H - 4);
        _hdrTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + PRIMARY_HEX + '"><b> FCM COMMUNITY CHAT</b></font>'
            + '<font face="$$MAIN_Font" size="11" color="' + INACTIVE_HEX + '">  v' + VERSION + '</font>';
        addChild(_hdrTf);

        // ── Main tab row: FALLOUT 76 (active) | PARTY ──
        _tabTf = makeChromeTf(8, HDR_H + 2, w - 16, TAB_H - 2);
        renderMainTabs();
        addChild(_tabTf);

        // ── Sub-tab row: GENERAL TRADING EVENTS INFESTS RAIDS ──
        _subTf = makeChromeTf(8, HDR_H + TAB_H + 2, w - 16, SUB_H - 2);
        renderSubTabs();
        addChild(_subTf);

        // ── Scrolling message log ──
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

        // ── Status strip ──
        _statusTf = makeChromeTf(6, h - INPUT_H - STATUS_H + 2, w - 12, STATUS_H - 2);
        setStatus("socket: init");
        addChild(_statusTf);

        // ── Faux input bar ──
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

    /**
     * Main tab row: "[ FALLOUT 76 ]  PARTY"
     * Always shows FALLOUT 76 as active (PARTY is future — not yet wired).
     */
    function renderMainTabs():Void {
        if (_tabTf == null) return;
        _tabTf.htmlText =
            '<font face="$$MAIN_Font" size="13" color="' + PRIMARY_HEX + '"><b>[ FALLOUT 76 ]</b></font>'
            + '<font face="$$MAIN_Font" size="13" color="' + INACTIVE_HEX + '">  PARTY</font>';
    }

    /**
     * Sub-tab row: GENERAL TRADING EVENTS INFESTS RAIDS.
     * Active channel highlighted in PRIMARY_HEX; inactive in INACTIVE_HEX.
     * _activeChannel is the lowercase channel name driven by ACTIVECHAN backend lines.
     */
    function renderSubTabs():Void {
        if (_subTf == null) return;
        var html:Array<String> = [];
        for (ch in CHAN_NAMES) {
            var isActive:Bool = (ch.toLowerCase() == _activeChannel.toLowerCase());
            var color:String = isActive ? PRIMARY_HEX : INACTIVE_HEX;
            html.push('<font face="$$MAIN_Font" size="12" color="' + color + '"><b>' + ch + '</b></font>');
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
    // HUDModLoader listeners — attach stage event + construct SharedHUDTools
    // =========================================================================

    /**
     * Attach the HUDMod::UserEvent stage listener.
     * Note: event.EventName and event.IsKeyDown (capitalized) per HUDModUserEvent.as.
     * Then construct a SharedHUDTools instance if available.
     */
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
     * SharedHUDTools is an INSTANCE class (not static).
     * Constructor: new SharedHUDTools(modName:String, hudMode:String = "")
     * We call Register(onHudMessage) to subscribe to the HUDTools IPC bus.
     * This is required before FormatTextEdit/TextEdit will work.
     *
     * The class lives in HUDModLoader's ApplicationDomain (shared via addChild
     * into HUDMenu). We instantiate via getDefinitionByName to avoid a
     * compile-time hard class reference (absent without HUDModLoader).
     */
    function constructHudTools():Void {
        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            if (cls != null) {
                _hudTools = untyped __new__(cls, VENDOR, "All");
                // Register to participate in HUDTools IPC message routing.
                // The callback receives (senderName, messageText) for any SendMessage directed to us.
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "Register"),
                    [function(sender:String, msg:String):Void { onHudMessage(sender, msg); }]);
                zfeLog("info", "hud", "SharedHUDTools constructed + registered");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "SharedHUDToolsMissing: " + Std.string(e));
            setInputPrompt('<font face="$$MAIN_Font" size="12" color="' + DIM_HEX
                + '">&#x203A; Input unavailable (HUDModLoader not detected)</font>');
        }
    }

    /** HUDTools IPC message callback — not used for chat but required by Register. */
    function onHudMessage(sender:String, msg:String):Void {
        zfeLog("info", "hud", "msg from=" + sender + " body=" + msg);
    }

    /**
     * HUDMod::UserEvent handler.
     *
     * Per HUDModUserEvent.as the correct field names are:
     *   event.EventName  — String (the control-map action)
     *   event.IsKeyDown  — Boolean (true = key-down, false = key-up)
     *
     * Open chat on key-UP (to avoid the open-key leaking into the input field).
     * Channel cycle on NextPage key-UP.
     */
    function onUserEvent(e:Dynamic):Void {
        var action:String = "";
        var isDown:Bool   = false;
        try { action = Std.string(e.EventName); }  catch (_:Dynamic) {}
        try { isDown = (e.IsKeyDown == true); }    catch (_:Dynamic) {}

        if (!isDown) {
            // Open chat input
            if (action == _cfgOpenKey || action == "Console"
                    || action == "ConsoleToggles" || action == "TeamChat") {
                if (!_inputOpen) openInput();
                return;
            }
            // Channel cycle: NextPage (Page Down — dead in FO76 HUD = safe to claim)
            if (action == "NextPage") {
                cycleChannel();
                return;
            }
        }
    }

    // =========================================================================
    // Channel switching
    // =========================================================================

    /**
     * Cycle active channel: General → Trading → Events → Infests → Raids → General.
     * Mirrors fcm-inject.as fcmSwitchChannel().
     */
    function cycleChannel():Void {
        _chanIdx = (_chanIdx + 1) % CHAN_NAMES.length;
        sendChan();
    }

    /**
     * Switch to a named channel. Accepts full name or short aliases.
     * /g /general → 0 (General)
     * /t /trading  → 1 (Trading)
     * /e /events   → 2 (Events)
     * /i /infests  → 3 (Infests)
     * /r /raids    → 4 (Raids)
     */
    function switchChannelBySlash(cmd:String):Bool {
        cmd = cmd.toLowerCase();
        var idx:Int = -1;
        if      (cmd == "g" || cmd == "general")   idx = 0;
        else if (cmd == "t" || cmd == "trading")   idx = 1;
        else if (cmd == "e" || cmd == "events")    idx = 2;
        else if (cmd == "i" || cmd == "infests")   idx = 3;
        else if (cmd == "r" || cmd == "raids")     idx = 4;
        if (idx < 0) return false;
        _chanIdx = idx;
        sendChan();
        return true;
    }

    /**
     * Send CHAN~<uuid> to the backend and update the sub-tab UI.
     * The backend responds with an ACTIVECHAN control line which clears the ring
     * and sets _activeChannel, triggering renderSubTabs().
     */
    function sendChan():Void {
        var uuid:String = CHAN_UUIDS[_chanIdx];
        bridgeWrite("CHAN~" + uuid + "\n");
        zfeLog("info", "chan", "CHAN sent idx=" + _chanIdx + " name=" + CHAN_NAMES[_chanIdx]);
        // Optimistic local update (backend will confirm via ACTIVECHAN)
        _activeChannel = CHAN_NAMES[_chanIdx].toLowerCase();
        renderSubTabs();
    }

    // =========================================================================
    // SharedHUDTools.TextEdit — open / submit
    // =========================================================================

    /**
     * Open the HUDModLoader text-entry overlay.
     *
     * API (from SharedHUDTools.as):
     *   FormatTextEdit(x, y, w, h, font, size, hexColorStr, bgHexColorStr, bgAlpha)
     *     — color args are hex strings WITHOUT # (e.g. "F5CB5B"), bgAlpha is Number (-1=no bg)
     *   TextEdit(callback, startText)
     *     — callback(text:String) fires once on submit; null = user cancelled
     *
     * Both calls go through Reflect on the _hudTools INSTANCE (not static class).
     */
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
            // Color args are hex strings without # per the actual FormatTextEdit source.
            // bgAlpha -1 = no background override (let HUDTools use default).
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
    // Send path
    // =========================================================================

    function sendMessage(raw:String):Void {
        if (_legacy == null) {
            zfeLog("warn", "send", "noBridge: cannot send");
            return;
        }

        // ── Slash command interception ─────────────────────────────────────
        // "/cmd rest" or "/cmd" — intercept first token before any send.
        if (raw.length > 1 && raw.charAt(0) == "/") {
            var spaceIdx:Int = raw.indexOf(" ");
            var slashCmd:String = (spaceIdx > 0) ? raw.substr(1, spaceIdx - 1) : raw.substr(1);
            if (switchChannelBySlash(slashCmd)) {
                // Pure channel-switch slash — do not send as a message.
                return;
            }
            // Unknown slash command: fall through and send as text.
        }

        // ── Truncate + sanitize ────────────────────────────────────────────
        if (raw.length > MAX_SEND_LEN) raw = raw.substr(0, MAX_SEND_LEN);
        raw = fcmClean(raw);
        if (raw.length == 0) return;

        // ── Local echo as a dim pending record ─────────────────────────────
        var pendingLine:String = PENDING_HEX + "~FCM~" + displayName() + "~" + raw;
        pushRecord(pendingLine);
        renderRecords();

        // ── HELLO on first send (identity establish) ───────────────────────
        if (!_helloSent) {
            readIdentity();
            bridgeWrite("HELLO~" + _accountName + "~" + _characterName + "\n");
            _helloSent = true;
        }

        bridgeWrite("SEND~" + CHAN_UUIDS[_chanIdx] + "~" + raw + "\n");
        zfeLog("info", "send", "sent len=" + raw.length);
    }

    /**
     * Strip chars that break tilde-delimited protocol lines or HTML rendering.
     * Mirrors backend zfeSafe() contract and fcm-inject.as.
     */
    static function fcmClean(s:String):String {
        var parts:Array<String> = s.split("~");   s = parts.join(" ");
        parts = s.split("\n");                     s = parts.join(" ");
        parts = s.split("\r");                     s = parts.join(" ");
        parts = s.split("\x00");                   s = parts.join("");
        parts = s.split("<");                      s = parts.join(" ");
        parts = s.split(">");                      s = parts.join(" ");
        parts = s.split("&");                      s = parts.join("and");
        parts = s.split('"');                      s = parts.join("'");
        s = StringTools.trim(s);
        return s;
    }

    function displayName():String {
        if (_characterName.length > 0) return _characterName;
        if (_accountName.length > 0) return _accountName;
        return "Wastelander";
    }

    function readIdentity():Void {
        if (_accountName.length > 0) return;
        try {
            var bui:Dynamic = untyped __global__["BSUIDataManager"];
            if (bui != null) {
                var acct:Dynamic = bui.GetDataFromClient("AccountInfoData");
                if (acct != null && acct.data != null && acct.data.name != null)
                    _accountName = Std.string(acct.data.name);
                var ch:Dynamic = bui.GetDataFromClient("CharacterInfoData");
                if (ch != null && ch.data != null && ch.data.name != null)
                    _characterName = Std.string(ch.data.name);
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "identity", "readFailed: " + Std.string(e));
        }
    }

    function bridgeWrite(line:String):Void {
        if (_legacy == null) return;
        try {
            Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["writeUTFBytes", line]);
        } catch (e:Dynamic) {
            zfeLog("warn", "send", "writeUTFBytes threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // ZFE API + socket init (mirrors FCMBridge.hx init / initSocket)
    // =========================================================================

    function init():Void {
        _zfeApi = findZfeApi(this);
        if (_zfeApi == null) {
            setLogText("ZFE not found\nInstall dxgi.dll + zfe.ini");
            setStatus("socket: no ZFE");
            return;
        }
        zfeLog("info", "startup", VENDOR + " " + VERSION + " loaded");
        initSocket();
    }

    function initSocket():Void {
        _legacy = findLegacyBridge(this);
        if (_legacy == null) {
            zfeLog("warn", "socket", "legacyMissing: receive-only");
            setStatus("socket: no bridge");
            return;
        }
        zfeLog("info", "socket", "legacyFound");

        _sock = {connected: false, bytesAvailable: 0};
        try {
            Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["register", _sock]);
            zfeLog("info", "socket", "registered");
        } catch (e:Dynamic) {
            zfeLog("warn", "socket", "register threw: " + Std.string(e));
            _legacy = null;
            setStatus("socket: register failed");
            return;
        }

        socketConnect();

        _drainTimer = new Timer(DRAIN_MS);
        _drainTimer.addEventListener(TimerEvent.TIMER, onDrainTick);
        _drainTimer.start();
        setStatus("socket: connecting...");
    }

    // =========================================================================
    // Bridge discovery — exact mirror of FCMBridge.hx
    // =========================================================================

    function findLegacyBridge(scope:Dynamic):Dynamic {
        var node:Dynamic = scope;
        var depth:Int = 0;
        while (node != null && depth < 12) {
            var candidate:Dynamic = getSFCodeObj(node);
            if (candidate != null && isLegacyBridge(candidate)) return candidate;
            var next:Dynamic = null;
            try { next = node.parent; } catch (e:Dynamic) {}
            if (next == node || next == null) break;
            node = next;
            depth++;
        }
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        var c1:Dynamic = getSFCodeObj(child);
                        if (c1 != null && isLegacyBridge(c1)) return c1;
                        var m:Int = 0;
                        try { m = child.numChildren; } catch (e2:Dynamic) {}
                        for (j in 0...m) {
                            try {
                                var gc:Dynamic = child.getChildAt(j);
                                var c2:Dynamic = getSFCodeObj(gc);
                                if (c2 != null && isLegacyBridge(c2)) return c2;
                            } catch (e2:Dynamic) {}
                        }
                    } catch (e2:Dynamic) {}
                }
            }
        } catch (e:Dynamic) {}
        return null;
    }

    static function getSFCodeObj(node:Dynamic):Dynamic {
        try { var v:Dynamic = untyped node["__SFCodeObj"]; if (v != null) return v; } catch (e:Dynamic) {}
        return null;
    }

    static function isLegacyBridge(obj:Dynamic):Bool {
        var callFn:Dynamic = null;
        try { callFn = Reflect.field(obj, "call"); } catch (e:Dynamic) {}
        if (callFn == null || (untyped __typeof__(callFn)) != "function") return false;
        try {
            var ret:Dynamic = Reflect.callMethod(obj, callFn, ["__zfe_probe"]);
            if (ret == null) return false;
            if ((untyped __typeof__(ret)) == "boolean") return ret == false;
            var rs:String = Std.string(ret);
            if (rs.indexOf("unsupported_command") >= 0) return false;
            return true;
        } catch (e:Dynamic) {}
        return false;
    }

    // =========================================================================
    // Socket connect / reconnect
    // =========================================================================

    function socketConnect():Void {
        if (_legacy == null) return;
        _connectAttempts++;
        _connectIssuedAt = flash.Lib.getTimer();
        zfeLog("info", "socket", "connectAttempt n=" + _connectAttempts);
        try {
            Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["connect"]);
        } catch (e:Dynamic) {
            zfeLog("warn", "socket", "connect threw: " + Std.string(e));
        }
    }

    function scheduleReconnect():Void {
        if (_reconnectTimer != null) return;
        _reconnectTimer = new Timer(_reconnectDelay, 1);
        _reconnectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _reconnectTimer = null;
            socketConnect();
            _reconnectDelay = Std.int(Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS));
        });
        _reconnectTimer.start();
        setStatus("socket: reconnecting in " + Std.int(_reconnectDelay / 1000) + "s...");
    }

    // =========================================================================
    // Drain timer — receive path (mirrors FCMBridge.hx)
    // =========================================================================

    function onDrainTick(e:TimerEvent):Void {
        if (_legacy == null || _sock == null) return;

        var connected:Bool = false;
        try { connected = (_sock.connected == true); } catch (e2:Dynamic) {}

        if (!connected) {
            if (!_liveActive) scheduleReconnect();
            return;
        }

        _reconnectDelay = RECONNECT_INIT_MS;

        var avail:Int = 0;
        try { avail = Std.int(_sock.bytesAvailable); } catch (e2:Dynamic) {}

        if (avail <= 0) {
            if (_liveActive && (flash.Lib.getTimer() - _lastLineAt) > WATCHDOG_MS) {
                zfeLog("warn", "socket", "watchdogDead");
                _liveActive = false;
                scheduleReconnect();
                setStatus("socket: watchdog — reconnecting...");
            }
            if (!_liveActive && _lastLineAt == 0 && _connectIssuedAt > 0
                && (flash.Lib.getTimer() - _connectIssuedAt) > STALE_NUDGE_MS) {
                try { Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["close"]); } catch (_:Dynamic) {}
                socketConnect();
            }
            return;
        }

        var chunk:String = "";
        try {
            var ret:Dynamic = Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["readUTFBytes"]);
            if (ret != null) chunk = Std.string(ret);
        } catch (e2:Dynamic) {
            zfeLog("warn", "socket", "readUTFBytes threw: " + Std.string(e2));
            return;
        }

        if (chunk.length == 0) return;

        _lineBuf += chunk;
        if (_lineBuf.length > BUF_CAP) {
            if (!_bufResetLogged) {
                zfeLog("warn", "socket", "bufReset: exceeded " + BUF_CAP + " bytes");
                _bufResetLogged = true;
            }
            _lineBuf = "";
            return;
        }

        var parts:Array<String> = _lineBuf.split("\n");
        _lineBuf = parts.pop();

        var hadRecords:Bool = false;
        for (line in parts) {
            if (line.length == 0) continue;

            _lastLineAt = flash.Lib.getTimer();

            if (!_liveActive) {
                _liveActive = true;
                zfeLog("info", "socket", "liveActive=true");
                setStatus("socket: live");
            }

            // ── Control lines (< 4 tilde fields) ──────────────────────────
            if (line.split("~").length < 4) {
                // ACTIVECHAN~<channelName>: backend cleared feed; records that
                // follow are for this channel. Mirror FCMBridge.hx exactly.
                if (line.length > 10 && line.substr(0, 10) == "ACTIVECHAN") {
                    var tildePos:Int = line.indexOf("~");
                    if (tildePos >= 0) {
                        var chanName:String = line.substr(tildePos + 1);
                        if (chanName.length > 0) {
                            _records = [];
                            _activeChannel = chanName;
                            renderSubTabs();
                            renderRecords();
                            zfeLog("info", "socket", "ACTIVECHAN=" + chanName + "; feed cleared");
                        }
                    }
                }
                continue;
            }

            // ── Record line ────────────────────────────────────────────────
            pushRecord(line);
            hadRecords = true;
        }

        if (hadRecords) renderRecords();
    }

    // =========================================================================
    // Ring buffer + render
    // =========================================================================

    function pushRecord(line:String):Void {
        _records.push(line);
        while (_records.length > MAX_MSGS) _records.shift();
        if (_bScrolling) {
            _newWhileScrolled++;
            updateScrollIndicator();
        }
    }

    /**
     * Rebuild the log TextField from _records.
     * Pattern from scaleform-ui-guide.md §4:
     *   - htmlText rebuilt from scratch (ring is small: ≤100 records).
     *   - Auto-scroll: setSelection(length,length) = caret-to-end trick.
     *   - bScrolling flag suppresses auto-scroll while user reads back.
     * 3 color spans per message: CHANNEL_HEX tag / PRIMARY_HEX name / TEXT_HEX content.
     */
    function renderRecords():Void {
        if (_logTf == null) return;
        if (_records.length == 0) {
            setLogText("");
            return;
        }

        // Enable scaleform extensions before any gfx call (rule 5)
        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        var html:Array<String> = [];
        var fs:Int = _cfgFontSize;
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

        _logTf.htmlText = html.join("<br/>");

        if (!_bScrolling) {
            _logTf.setSelection(_logTf.length, _logTf.length);
        }
    }

    // =========================================================================
    // Manual scroll support (keybind wiring is a follow-up)
    // =========================================================================

    public function scrollUp():Void {
        if (_logTf == null) return;
        if (_logTf.scrollV > 1) {
            _logTf.scrollV--;
            _bScrolling = true;
            updateScrollIndicator();
        }
    }

    public function scrollDown():Void {
        if (_logTf == null) return;
        _logTf.scrollV++;
        if (_logTf.scrollV >= _logTf.maxScrollV) {
            _bScrolling = false;
            _newWhileScrolled = 0;
            updateScrollIndicator();
        }
    }

    public function scrollToBottom():Void {
        if (_logTf == null) return;
        _logTf.setSelection(_logTf.length, _logTf.length);
        _bScrolling = false;
        _newWhileScrolled = 0;
        updateScrollIndicator();
    }

    function updateScrollIndicator():Void {
        if (_newWhileScrolled > 0) {
            setStatus("socket: live  |  +" + _newWhileScrolled + " new"
                + (_newWhileScrolled == 1 ? " message" : " messages") + " below");
        } else if (_liveActive) {
            setStatus("socket: live");
        }
    }

    // =========================================================================
    // ZFE logger
    // =========================================================================

    function zfeLog(level:String, category:String, message:String):Void {
        if (_zfeApi == null) return;
        try {
            _zfeApi.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level
                + '","category":"' + category + '","message":"' + message + '"}');
        } catch (e:Dynamic) {}
    }

    // =========================================================================
    // findZfeApi — exact mirror of FCMBridge.hx (do not diverge)
    // =========================================================================

    static function findZfeApi(scope:Dynamic):Dynamic {
        try { var z:Dynamic = untyped scope["__ZFE"]; if (z != null) return z; } catch (e:Dynamic) {}
        try { if (scope.parent != null) { var z:Dynamic = untyped scope.parent["__ZFE"]; if (z != null) return z; } } catch (e:Dynamic) {}
        try { if (scope.root != null) { var z:Dynamic = untyped scope.root["__ZFE"]; if (z != null) return z; } } catch (e:Dynamic) {}
        try { var z:Dynamic = untyped __global__["ZFECodeObj"]; if (z != null) return z; } catch (e:Dynamic) {}
        try { var z:Dynamic = untyped __global__["__SFCodeObj"]; if (z != null) return z; } catch (e:Dynamic) {}
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        var z:Dynamic = untyped child["__ZFE"]; if (z != null) return z;
                        var m:Int = 0; try { m = child.numChildren; } catch (e2:Dynamic) {}
                        for (j in 0...m) {
                            try { var gc:Dynamic = child.getChildAt(j); var z2:Dynamic = untyped gc["__ZFE"]; if (z2 != null) return z2; } catch (e2:Dynamic) {}
                        }
                    } catch (e2:Dynamic) {}
                }
            }
        } catch (e:Dynamic) {}
        return null;
    }
}
