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
 * Font: GFx engine-registered HUDModLoader aliases — NO embed.
 *   `$MAIN_Font_Light` (body) and `$MAIN_Font_Bold` (bold/headers/tab labels) are
 *   font aliases registered by HUDModLoader at the GFx engine level (see HUDTools.as
 *   entry_tf / HUDButton.as label TextFields). Unlike HUDMenu.swf's per-movie symbol
 *   `$$MAIN_Font` (NOT resolvable in a child widget SWF), and unlike a Flash-@:font
 *   embedded TTF (GFx IGNORES child-SWF embedded TTFs — this is why the v2.3.0
 *   DejaVuSans embed still rendered tofu), these aliases DO resolve inside any child
 *   widget SWF loaded into ApplicationDomain.currentDomain — proven by HUDButton /
 *   HUDTools / HUDKeyboard, which render with them. embedFonts=true is kept on every
 *   TextField (the HUDTools entry_tf precedent); the aliases resolve fine with it.
 *   FONT_BODY is also passed to FormatTextEdit (matches HUDTools' entry_tf default).
 *
 * Input path (v2.5.3): DECODED native chat-input API. The verbs are TOP-LEVEL ZFE
 *   commands that take BARE-VALUE payloads (not JSON) and return bare booleans/strings:
 *     setChatInputActive payload "true" -> true (ACTIVATES); "false" deactivates.
 *       (JSON {} / {"active":true} return false / do nothing — use bare "true"/"false".)
 *     consumeChatInputSubmitted -> bare BOOLEAN (true = Enter pressed since last check);
 *       the MESSAGE TEXT comes from readChatInput, NOT from the consume result.
 *     readChatInput -> the in-progress text buffer (bare string).
 *     isChatInputActive -> true/false ; isChatKeyPressed -> true when OpenChatKey
 *       (PAGE_DOWN) pressed ; clearChatInput -> true.
 *   nativeTruthy(raw): trimmed/lowercased == "true" OR == "1" OR contains "success":true.
 *   FLOW (openInputNative): setChatInputActive("true") -> _inputTimer (~100 ms)
 *     pollNativeInput(): readChatInput (show in-progress) ; if consume truthy => SUBMIT
 *       (final text = readChatInput, run through shared handleSubmittedText -> direct
 *       chat.v1.sendMessage, log full raw) ; else if !isChatInputActive => cancel (Esc).
 *     closeInputNative(): clearChatInput + setChatInputActive("false").
 *   OPEN triggers: HUDMod::UserEvent open key, AND a low-rate (~150 ms) pollOpenKey()
 *     that opens on an isChatKeyPressed false->true edge (so PAGE_DOWN opens chat).
 *   _nativeInputUsable is set by a CLEAN self-resetting startup probe (activate, test,
 *     deactivate+clear). If not usable, openInput() falls back to SharedHUDTools so the
 *     user can still type. NEVER run both. sendMessage stays chat.v1.sendMessage ONLY.
 *
 * Input path (FALLBACK): SharedHUDTools.FormatTextEdit + FormatOnScreenKeyboard + TextEdit.
 *   HUDModLoader's HUDTools handles StartEditText/EndEditText and gamepad OSK.
 *   ALL THREE must be called in order:
 *     1. FormatTextEdit(x,y,w,h,font,size,hexColor,bgHexColor,bgAlpha)
 *     2. FormatOnScreenKeyboard(oskX,oskY) — REQUIRED even on KB/mouse
 *     3. TextEdit(callback, startText)
 *   Without FormatOnScreenKeyboard, HUDTools sends ERROR|TXT → callback(null)
 *   immediately (the v2.0.3 "immediately released" bug).
 *
 * ZFE API discovery: widget runs in HUDModLoader's ApplicationDomain (shared with
 * HUDMenu). ZFE attaches __ZFE to the HUDMenu top-level frame — findZfeApi()
 * walks parent/root/stage to find it.
 *
 * Channel slugs (AllowedChannels in Data/ZFE/TextChat/fragments/FCMChatWidget.ini):
 *   global, trade, events, infests, raids, server
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
 *   9. NO getChildAt/numChildren on arbitrary native Scaleform objects (VM crash).
 *  10. NO hard casts (MovieClip(...)) — dynamic untyped access only in findZfeApi.
 *
 * Docs:
 *   docs/overlay/zfe/native-chat-relay/protocol-spec.md  — chat.v1 call surface
 *   docs/overlay/zfe/native-chat-relay/fcm-integration.md — FCM relay adapter + worldId
 *   docs/overlay/zfe/scaleform-ui-guide.md §3,§9 — font embedding, HUDModLoader API
 *   docs/overlay/zfe/textchat-blueprint.md  — Text Chat mod decompile reference
 */

class FCMChatWidget extends MovieClip {

    // ── Widget identity ────────────────────────────────────────────────────────
    static inline var VENDOR:String   = "FCMChatWidget";
    static inline var VERSION:String  = "2.7.7";  // BACKSPACE fix: dispatch PlatformChangeEvent(PC_KB_MOUSE) before SharedHUDTools TextEdit so it uses the native keyboard field (entry_tf), not the off-screen OSK; keyboard editing works + key-lock preserved; + v2.7.0-2.7.6
    // Expose for HUDModLoader hot-reload
    public var isReloadable:Bool      = true;

    // ── Font aliases — HUDModLoader engine-registered GFx fonts (NO embed) ────
    // These are GFx aliases registered by HUDModLoader (HUDTools.as entry_tf uses
    // "$MAIN_Font_Light"; HUDButton.as label TextFields use "$MAIN_Font_Bold").
    // They resolve in child widget SWFs (ApplicationDomain.currentDomain) with
    // embedFonts=true — no @:font embed needed (GFx ignores child-SWF embedded TTFs).
    static inline var FONT_BODY:String = "$MAIN_Font_Light";  // body / feed / messages / prompts / notices
    static inline var FONT_BOLD:String = "$MAIN_Font_Bold";   // tab labels / headers / sender names / active-tab
    // FALLBACK (do NOT ship unless aliases tofu in-game): re-add the @:font embed and
    // set TextFormat.font / the FormatTextEdit font arg to the TTF's DefineFont FAMILY
    // name "DejaVu Sans" (with the space) — NOT the postscript "DejaVuSans". GFx matches
    // the DefineFont family name; the v2.3.0 build used the postscript name, which is the
    // only reason its embed also rendered tofu as a fallback.

    // ── chat.v1 poll / connect timing ─────────────────────────────────────────
    // Event-poll interval moved to FcmConfig.pollMs (tunable via FCMChat.ini `pollMs`,
    // default 5000) — each poll is a fresh wss/TLS handshake under Wine, so the rate is the
    // game-lag knob. See FcmConfig.pollMs.
    static inline var CONNECT_RETRY_MS:Int = 3000;
    static inline var CONNECT_MAX_MS:Int   = 30000;
    // worldId re-read interval (ms)
    static inline var WORLD_POLL_MS:Int    = 5000;

    // ── Chat UX ───────────────────────────────────────────────────────────────
    // ring-buffer cap + send-length cap now live in FcmConfig (_cfg.maxMessages/maxSendLen)

    // ── Channel tables ────────────────────────────────────────────────────────
    // Slugs match AllowedChannels in Data/ZFE/TextChat/fragments/FCMChatWidget.ini.
    // "server" (index 5) is the world-session channel — not directly selectable.
    static var CHAN_SLUGS:Array<String> = ["global", "trade", "events", "infests", "raids", "server"];
    static var CHAN_NAMES:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS", "SERVER"];

    // ── Layout (row heights fixed; user-config deferred to v2 per spec D-04) ───
    // Row order from top: TAB_H (main tab) | SUB_H (channel tabs) | log | INPUT_H
    static inline var INPUT_H:Int           = 28;
    static inline var TAB_H:Int             = 22;
    static inline var SUB_H:Int             = 20;

    // Colors / geometry / limits / keybinds now live in FcmConfig (`_cfg`), parsed
    // from Data/FCMChat.ini. Derive "#RRGGBB" / "RRGGBB" strings from the Int colors
    // via hx() / nh(). Defaults in FcmConfig reproduce the amber Pip-Boy theme.

    // ── HMAC-SHA256 shared secret (worldId control message) ───────────────────
    // Matches WORLD_HMAC_SECRET in FCMBridge.hx and the relay.
    static inline var WORLD_HMAC_SECRET:String = "fcm-world-v1-dev-placeholder";
    static inline var WORLD_CTRL_PREFIX:String = "\x00fcm.world.v1\x00";

    // ── Config (FcmConfig — parsed from Data/FCMChat.ini; see FcmConfig.hx) ─────
    var _cfg:FcmConfig = new FcmConfig();

    // Hex-string helpers for htmlText / setColors / FormatTextEdit (derive from _cfg Ints).
    static inline function hx(c:Int):String { return "#" + StringTools.hex(c, 6); }
    static inline function nh(c:Int):String { return StringTools.hex(c, 6); }

    // ── Display objects ───────────────────────────────────────────────────────
    var _bg:Shape;
    var _logTf:TextField;
    var _tabTf:TextField;
    var _subTf:TextField;
    var _promptTf:TextField;
    var _fmt:TextFormat;

    // ── Chat render state ─────────────────────────────────────────────────────
    var _records:Array<{color:String, channel:String, user:String, body:String, ts:String}> = [];
    var _bScrolling:Bool         = false;
    var _newWhileScrolled:Int    = 0;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int             = 0;   // 0=global

    // ── Hide state (CAP-011) ────────────────────────────────────────────────────
    var _hidden:Bool             = false;   // true while the panel is hidden (/hide, F12, hideKey)
    // Auto-hide: hide after _cfg.autoHideSec of no activity; reveal on a new message. F12-toggleable.
    var _autoHideOn:Bool         = false;
    var _autoHideTimer:Timer     = null;
    var _themeIdx:Int            = 0;       // F12 Customize → cycle color theme

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
    // True once the relay has sent a system link-code notice (sent ONLY to limited/unlinked
    // identities) — the authoritative "not linked" signal (ZFE getAuthState can't tell us).
    var _needsLink:Bool = false;

    // ── Input state ───────────────────────────────────────────────────────────
    var _inputOpen:Bool          = false;
    // v2.5.3: DECODED native chat-input API — bare-value payloads ("true"/"false"),
    // consume=boolean, text from readChatInput. Native is the primary path when usable.
    var _nativeInput:Bool        = false;          // true while a native session owns input
    var _inputTimer:flash.utils.Timer = null;      // in-session native input poll (~100 ms)
    var _inProgress:String       = "";             // last readChatInput buffer text
    var _lastReadRaw:String      = "";             // throttle [nativein] read logging
    var _nativeSubmitInFlight:Bool = false;        // mark a send originating from a native submit (diagnostic log)
    // The startup probe sets _nativeInputUsable; openInput() uses the native flow only
    // when true (else SharedHUDTools fallback so the user can still type).
    var _nativeInputUsable:Bool  = false;          // native chat-input session works (probe result)
    var _probeSent:Bool          = false;          // one-shot startup probe guard
    static inline var INPUT_POLL_MS:Int  = 100;    // in-session native input-poll interval
    // ── Open-key poll (v2.5.3) — open chat on the ZFE OpenChatKey (PAGE_DOWN) edge ─────
    var _openKeyTimer:flash.utils.Timer = null;    // low-rate (~150 ms) open-trigger poll
    static inline var OPEN_KEY_MS:Int = 150;       // open-key poll interval
    var _lastChatKey:Bool        = false;          // last isChatKeyPressed truthiness (edge detect)

    // ── SharedHUDTools (HUDModLoader text-entry + F12 menu integration) ───────
    var _hudTools:Dynamic        = null;

    // ── HUDButton interactive channel tabs ────────────────────────────────────
    var _btnCls:Dynamic          = null;   // resolved HUDButton class (null → text-strip fallback)
    var _chanBtns:Array<Dynamic> = [];     // the 5 channel-tab HUDButton instances

    // ── Optimistic-echo dedup (our just-sent messages) ────────────────────────
    var _pendingEchoes:Array<{key:String, ts:Float}> = [];

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
        _cfg = FcmConfig.parse(Std.string(ul.data));
        afterConfig();
    }

    function afterConfig():Void {
        _autoHideOn = (_cfg != null && _cfg.autoHideSec > 0);   // default from config (60s)
        // attachHUDModListeners → constructHudTools resolves _btnCls (HUDButton),
        // which buildPanel needs to decide tabs-vs-text-strip. Order matters.
        attachHUDModListeners();
        buildPanel();
        // Delay ZFE init 3 s — ZFE API may not be ready at SWF load time.
        var t:Timer = new Timer(3000, 1);
        t.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { init(); });
        t.start();
    }

    // =========================================================================
    // Panel chrome — no header row, no status row
    // =========================================================================

    function buildPanel():Void {
        var w:Int = _cfg.width;
        var h:Int = _cfg.height;
        // Log area gets everything except tab rows and input.
        var logH:Int = h - TAB_H - SUB_H - INPUT_H;

        _bg = new Shape();
        var g = _bg.graphics;
        g.beginFill(_cfg.bgColor, _cfg.bgAlpha);
        g.lineStyle(1, _cfg.borderColor, 0.3);
        g.drawRect(0, 0, w, h);
        g.endFill();
        // Tab rows (main + sub) — ONE fill at a single alpha so there is NO dim seam between
        // the main-tab row and the sub-tab row (user request; the two-alpha fill left a faint line).
        g.lineStyle();
        g.beginFill(_cfg.tabRowColor, 0.98);
        g.drawRect(1, 1, w - 2, TAB_H + SUB_H);
        g.endFill();
        // Sub-tab row bottom divider + log/input separator (full width, overlay parity @0.45).
        g.lineStyle(1, _cfg.borderColor, 0.45);
        g.moveTo(0, TAB_H + SUB_H); g.lineTo(w, TAB_H + SUB_H);
        g.lineStyle(1, _cfg.borderColor, 0.4);
        g.moveTo(0, h - INPUT_H); g.lineTo(w, h - INPUT_H);
        addChild(_bg);

        // Main tab label first so we can measure it to size the outline box.
        _tabTf = makeChromeTf(8, 2, w - 16, TAB_H - 2);
        renderMainTabs();
        addChild(_tabTf);

        // Active main-tab outline (overlay parity, CAP-015/A.7): border TOP+LEFT+RIGHT only
        // (open bottom), sized to the label, and the main-tab-row divider is CUT OUT under
        // the tab so NO line runs beneath the active tab. Solid lines, no fill, no filters.
        var tw:Float = 0.0;
        try { tw = _tabTf.textWidth; } catch (e:Dynamic) {}
        var boxL:Int = 4;
        var boxR:Int = (tw > 20) ? Std.int(8 + tw + 6) : 104;   // fit the text (tight right pad)
        g.lineStyle(1, _cfg.tabActiveColor, 0.5);
        g.moveTo(boxL, 2);     g.lineTo(boxR, 2);       // top
        g.moveTo(boxL, 2);     g.lineTo(boxL, TAB_H);   // left
        g.moveTo(boxR, 2);     g.lineTo(boxR, TAB_H);   // right
        // The ONLY main->sub separator: a yellow line at y=TAB_H across the full width, CUT OUT
        // under the active tab so the outline + this line form one continuous yellow line that
        // WRAPS the active "FALLOUT 76" tab. No dim divider anywhere on this boundary.
        g.moveTo(0, TAB_H);    g.lineTo(boxL, TAB_H);
        g.moveTo(boxR, TAB_H); g.lineTo(w, TAB_H);

        // Channel sub-tabs: plain text strip (NO boxes/borders) — active bright, inactive dim.
        _subTf = makeChromeTf(8, TAB_H + 2, w - 16, SUB_H - 2);
        renderSubTabs();
        addChild(_subTf);

        var logY:Int = TAB_H + SUB_H + 4;
        _logTf = new TextField();
        _logTf.x = 6;
        _logTf.y = logY;
        _logTf.width  = w - 12;
        _logTf.height = logH - 6;
        _logTf.multiline  = true;
        _logTf.wordWrap   = true;
        _logTf.selectable = false;
        _logTf.mouseEnabled = true;   // enable mouse-wheel scroll (CAP-008, VER-2)
        _logTf.embedFonts = true;
        _fmt = new TextFormat();
        _fmt.font    = FONT_BODY;
        _fmt.size    = _cfg.fontSize;
        _fmt.color   = _cfg.textColor;
        _fmt.leading = 3;
        _logTf.defaultTextFormat = _fmt;
        setLogText("connecting...");
        addChild(_logTf);

        // Mouse-wheel over the log scrolls history (CAP-008, VER-2). HUD-availability
        // unverified; F12 "Scroll to newest" + auto-scroll stay the fallback.
        try {
            _logTf.addEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel);
        } catch (e:Dynamic) {}

        // ── Prompt row: idle hint / "typing..." (HUDTools draws its own entry box) ──
        _promptTf = makeChromeTf(6, h - INPUT_H + 4, w - 12, INPUT_H - 6);
        setPrompt(idlePrompt());
        addChild(_promptTf);

        x = _cfg.x;
        y = _cfg.y;
    }

    function makeChromeTf(tx:Float, ty:Float, tw:Float, th:Float):TextField {
        var tf:TextField = new TextField();
        tf.x = tx; tf.y = ty;
        tf.width = tw; tf.height = th;
        tf.selectable = false;
        tf.mouseEnabled = false;
        tf.embedFonts = true;
        // Apply the engine body alias so chrome text resolves (not tofu).
        var fmt:TextFormat = new TextFormat();
        fmt.font  = FONT_BODY;
        fmt.size  = 13;
        fmt.color = _cfg.tabInactiveColor;
        tf.defaultTextFormat = fmt;
        return tf;
    }

    function renderMainTabs():Void {
        if (_tabTf == null) return;
        // #344 / CAP-015 / D-11: single main tab "FALLOUT 76" (no PARTY); the active
        // outline box is drawn in buildPanel() via _bg.graphics (no brackets, no filters).
        _tabTf.htmlText =
            '<font face="' + FONT_BOLD + '" size="13" color="' + hx(_cfg.tabActiveColor) + '"><b>FALLOUT 76</b></font>';
    }

    function renderSubTabs():Void {
        if (_subTf == null) return;
        // Borderless text strip (no boxes). Sub-tabs use the HEADER text colors (same as the
        // "FALLOUT 76" main tab): active channel = tabActiveColor (bright), inactive =
        // tabInactiveColor (dim). Per-channel colors (chat_rooms.color) are applied only to the
        // [Channel] message tags, NOT this tab row. Slash /g /t /e /i /r still switch channels.
        var displayNames:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS"];
        var html:Array<String> = [];
        for (i in 0...displayNames.length) {
            var color:String = (i == _chanIdx) ? hx(_cfg.tabActiveColor) : hx(_cfg.tabInactiveColor);
            html.push('<font face="' + FONT_BOLD + '" size="12" color="' + color + '"><b>' + displayNames[i] + '</b></font>');
        }
        _subTf.htmlText = html.join('<font face="' + FONT_BODY + '" size="12" color="' + hx(_cfg.tabInactiveColor) + '">  </font>');
    }

    function idlePrompt():String {
        // Blank when idle unless showHints (CAP-014); in-progress text still shows while typing.
        if (!_cfg.showHints) return "";
        return '<font face="' + FONT_BODY + '" size="13" color="' + hx(_cfg.promptColor) + '">&#x203A; ['
            + _cfg.openKey + '] chat  |  [/g /t /e /i /r] channel</font>';
    }

    function typingPrompt():String {
        // No help text while typing (user request) — the prompt row shows only the
        // in-progress typed text (pollNativeInput appends it). Blank when nothing typed.
        return "";
    }

    function setLogText(s:String):Void {
        if (_logTf == null) return;
        _logTf.htmlText = '<font face="' + FONT_BODY + '" size="' + _cfg.fontSize + '" color="' + hx(_cfg.textColor) + '">' + s + '</font>';
    }

    function setPrompt(html:String):Void {
        if (_promptTf == null) return;
        _promptTf.htmlText = html;
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
     * Construct a SharedHUDTools instance for text-entry + F12 menu.
     *
     * Register(callback) subscribes to the HUDTools IPC bus (required before
     * TextEdit/FormatTextEdit will work).
     * RegisterMenu(build, select) adds us to the F12 HUDTools menu.
     */
    function constructHudTools():Void {
        // Extensions.enabled is REQUIRED before any scaleform.gfx.* use AND before
        // instantiating HUDButton (it uses TextFieldEx internally).
        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            if (cls != null) {
                _hudTools = untyped __new__(cls, VENDOR, "All");
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "Register"),
                    [function(sender:String, msg:String):Void { onHudMessage(sender, msg); }]);
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "RegisterMenu"),
                    [function(parentItem:String):Void { onBuildMenu(parentItem); },
                     function(item:String):Void { onSelectMenu(item); }]);
                // Position the F12 HUDTools menu just under the channel-tab row.
                try {
                    Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatMenu"),
                        [_cfg.x, _cfg.y + TAB_H, "down"]);
                } catch (e:Dynamic) {}
                zfeLog("info", "hud", "SharedHUDTools registered");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "SharedHUDToolsMissing: " + Std.string(e));
        }

        // Resolve HUDButton once; null → text-strip fallback for channel tabs.
        try {
            _btnCls = untyped __global__["flash.utils.getDefinitionByName"]("HUDButton");
        } catch (e:Dynamic) {
            _btnCls = null;
            zfeLog("warn", "ui", "HUDButton missing");
        }
        if (_btnCls == null) zfeLog("warn", "ui", "HUDButton missing");
    }

    function onHudMessage(sender:String, msg:String):Void {
        zfeLog("info", "hud", "msg from=" + sender + " body=" + msg.substr(0, 80));
    }

    /**
     * F12 HUDTools menu build callback.
     * Adds channel-switch entries, a scroll-to-newest action, and a link action
     * (enabled only while auth is limited).
     * AddMenuItem(id, text, isEnabled=true, isMenu=false, timeout=-1).
     */
    function onBuildMenu(parentItem:Dynamic):Void {
        if (_hudTools == null) return;
        var add:Dynamic = Reflect.field(_hudTools, "AddMenuItem");
        if (add == null) return;
        var p:String = Std.string(parentItem);
        try {
            // Customize submenu (opened when the "customize" isMenu item is selected — HUDTools
            // re-invokes this builder with parentItem = the submenu id).
            if (p == "customize") {
                Reflect.callMethod(_hudTools, add, ["cz_bigger",  "Size +",        true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_smaller", "Size -",        true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_up",      "Move up",       true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_down",    "Move down",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_left",    "Move left",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_right",   "Move right",    true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_up", "Opacity +",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_dn", "Opacity -",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_theme",   "Color theme >", true, false, -1]);
                return;
            }
            // Top-level menu.
            var names:Array<String> = ["General", "Trading", "Events", "Infests", "Raids"];
            for (i in 0...5) {
                Reflect.callMethod(_hudTools, add, ["chan" + i, names[i], true, false, -1]);
            }
            Reflect.callMethod(_hudTools, add, ["scrollbottom", "Scroll to newest", true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["hidechat", "Hide chat", true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["autohide", (_autoHideOn ? "Auto-hide: ON" : "Auto-hide: OFF"), true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["customize", "Customize...", true, true, -1]);   // isMenu=true
            Reflect.callMethod(_hudTools, add, ["relink", "Link account...", _authState != "authenticated", false, -1]);
        } catch (e:Dynamic) {
            zfeLog("warn", "menu", "AddMenuItem threw: " + Std.string(e));
        }
    }

    /**
     * F12 HUDTools menu select callback. id is the AddMenuItem id string.
     */
    function onSelectMenu(item:Dynamic):Void {
        var id:String = Std.string(item);
        if (StringTools.startsWith(id, "cz_")) {
            doCustomize(id);
        } else if (StringTools.startsWith(id, "chan")) {
            selectChannel(Std.parseInt(id.substr(4)));
        } else if (id == "scrollbottom") {
            scrollToBottom();
        } else if (id == "hidechat") {
            hide();
        } else if (id == "autohide") {
            _autoHideOn = !_autoHideOn;
            if (_autoHideOn) { bumpAutoHide(); }
            else { if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; } if (_hidden) show(); }
            zfeLog("info", "menu", "auto-hide " + (_autoHideOn ? "on" : "off"));
        } else if (id == "relink") {
            setLogText(linkHint());
        }
    }

    /**
     * HUDMod::UserEvent handler — control-map ACTIONS only. FO76 collapses every unbound key
     * (INSERT, Page Up/Down, Delete, …) to "Unmapped" with no key info, so this path is reliable
     * ONLY for real named actions. It is just a secondary open-chat trigger for when OpenChatKey
     * is a real action (Console / TeamChat). The primary open AND the channel cycle run off the
     * native isChatKeyPressed poll (pollOpenKey); channel jumps are slash commands (/g /t /e /i /r);
     * hide is /hide. event.EventName (String), event.IsKeyDown (Boolean) per HUDModUserEvent.as.
     */
    function onUserEvent(e:Dynamic):Void {
        var action:String = "";
        var isDown:Bool   = false;
        try { action = Std.string(e.EventName); }  catch (_:Dynamic) {}
        try { isDown = (e.IsKeyDown == true); }    catch (_:Dynamic) {}
        if (isDown) return;

        // Open only on a real action used as the open key (never on "Unmapped", which would
        // open on ANY unbound key). INSERT etc. open via the native poll, not here.
        if (action == "Console" || action == "ConsoleToggles" || action == "TeamChat"
                || (action == _cfg.openKey && action != "Unmapped")) {
            if (_inputOpen && _nativeInput) return;
            if (!_inputOpen) openInput();   // openInput() restores from hidden first (CAP-011)
        }
    }

    // =========================================================================
    // Channel switching
    // =========================================================================

    /**
     * Build the interactive channel-tab row from HUDButton instances.
     * Called from buildPanel() only when _btnCls (HUDButton) resolved.
     * Replaces the _subTf text strip with 5 clickable, gamepad-focusable tabs.
     */
    function buildChannelTabs():Void {
        if (_btnCls == null) return;
        var labels:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS"];
        var cell:Int = Std.int((_cfg.width - 16) / 5);   // per-tab column width
        var bw:Int   = cell - 2;                      // button width (gap between)
        var bh:Int   = SUB_H - 2;
        for (i in 0...5) {
            var ci:Int = i;   // per-iteration capture for the click closure
            try {
                var b:Dynamic = untyped __new__(_btnCls, bw, bh);
                Reflect.setProperty(b, "text", labels[i]);
                b.x = 8 + i * cell;
                b.y = TAB_H + 1;
                // setInfo(id, isEnabled, isMenu, timeout)
                try {
                    Reflect.callMethod(b, Reflect.field(b, "setInfo"), ["chan" + i, true, false, 0]);
                } catch (e:Dynamic) {}
                // setColors(textColor, bgColor, bgAlpha, selectColor, selectBGColor) — hex, no '#'
                try {
                    Reflect.callMethod(b, Reflect.field(b, "setColors"),
                        [nh(_cfg.tabInactiveColor), nh(_cfg.tabRowColor), 0.85, nh(_cfg.tabRowColor), nh(_cfg.tabActiveColor)]);
                } catch (e:Dynamic) {}
                try {
                    b.addEventListener(flash.events.MouseEvent.CLICK,
                        function(_) { selectChannel(ci); });
                } catch (e:Dynamic) {}
                addChild(b);
                _chanBtns.push(b);
            } catch (e:Dynamic) {
                zfeLog("warn", "ui", "HUDButton instantiate threw: " + Std.string(e));
            }
        }
        setSelectedTab(_chanIdx);
    }

    /**
     * Reflect the active channel in the tab row.
     * HUDButton has an isSelected setter; the text-strip fallback re-renders.
     */
    function setSelectedTab(idx:Int):Void {
        if (_chanBtns.length == 0) {
            renderSubTabs();
            return;
        }
        for (k in 0..._chanBtns.length) {
            try { Reflect.setProperty(_chanBtns[k], "isSelected", (k == idx)); } catch (e:Dynamic) {}
        }
    }

    /**
     * Single channel-switch entry point (tab click, slash, cycle, F12 menu).
     */
    function selectChannel(idx:Int):Void {
        if (idx < 0 || idx > 4 || idx == _chanIdx) { setSelectedTab(idx); return; }
        _chanIdx = idx;
        // Keep ALL channels' messages in _records (from the history backfill + live); renderRecords
        // filters by the active channel. Do NOT clear here, or switching a channel would blank its
        // history (the backfilled messages for that channel would be discarded).
        _bScrolling = false; _newWhileScrolled = 0;
        setSelectedTab(idx);
        renderRecords();             // re-render (filters to the newly-selected channel)
        bumpAutoHide();              // channel switch = activity
        zfeLog("info", "chan", "selected " + CHAN_SLUGS[idx]);
    }

    function cycleChannel():Void {
        // Cycle over the first 5 channels (skip "server" at index 5).
        selectChannel((_chanIdx + 1) % 5);
    }

    function cyclePrev():Void {
        // Reverse-cycle over the first 5 channels (skip "server" at index 5).
        selectChannel((_chanIdx + 4) % 5);
    }

    // =========================================================================
    // Hide / restore (CAP-011)
    //
    // hide() sets this.visible=false; show() sets it back. Timers + listeners keep
    // running while hidden so the feed stays current. Triggers: /hide, F12 "Hide chat",
    // optional hideKey action. Restore: the open key (INSERT) via openInput() -> show().
    // =========================================================================

    function hide():Void {
        this.visible = false;
        _hidden = true;
        if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
        zfeLog("info", "hide", "panel hidden");
    }

    function show():Void {
        this.visible = true;
        _hidden = false;
        bumpAutoHide();
        zfeLog("info", "hide", "panel restored");
    }

    /**
     * Restart the auto-hide countdown (called on any activity: show, open input, channel switch,
     * new message). When it elapses with no further activity — and the input isn't open — the
     * panel hides. A new message reveals it again (see parseAndRenderEvents). F12-toggleable.
     */
    function bumpAutoHide():Void {
        if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
        if (!_autoHideOn || _cfg == null || _cfg.autoHideSec <= 0) return;
        _autoHideTimer = new Timer(_cfg.autoHideSec * 1000, 1);
        _autoHideTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _autoHideTimer = null;
            if (!_inputOpen && !_hidden) hide();
        });
        _autoHideTimer.start();
    }

    // =========================================================================
    // F12 Customize — live resize / move / opacity / color theme (+ best-effort persist)
    // =========================================================================

    // Live re-layout after a Customize change. Removes children BY REFERENCE only — NEVER
    // numChildren/getChildAt (Scaleform VM crash, rule #9). buildPanel re-adds everything,
    // re-applies x/y from _cfg, and repopulates _chanBtns.
    function rebuildPanel():Void {
        if (_chanBtns != null) { for (b in _chanBtns) { try { removeChild(b); } catch (e:Dynamic) {} } }
        _chanBtns = [];
        var kids:Array<flash.display.DisplayObject> = [_bg, _tabTf, _subTf, _logTf, _promptTf];
        for (c in kids) { try { if (c != null) removeChild(c); } catch (e:Dynamic) {} }
        buildPanel();
        setSelectedTab(_chanIdx);
        renderRecords();
    }

    // border, text, sender, tabActive, tabInactive
    static var THEMES:Array<Array<Int>> = [
        [0xF5CB5B, 0xFAF4DA, 0xF5CB5B, 0xF5CB5B, 0xB49544],   // Amber (default)
        [0x5AB0FF, 0xE6F2FF, 0x5AB0FF, 0x5AB0FF, 0x3A6A99],   // Blue
        [0x6AD46A, 0xE8FBE8, 0x6AD46A, 0x6AD46A, 0x3F7F3F],   // Green
        [0xD8D8D8, 0xF2F2F2, 0xFFFFFF, 0xFFFFFF, 0x888888],   // Mono
    ];

    function cycleTheme():Void {
        _themeIdx = (_themeIdx + 1) % THEMES.length;
        var t:Array<Int> = THEMES[_themeIdx];
        _cfg.borderColor = t[0]; _cfg.textColor = t[1]; _cfg.senderColor = t[2];
        _cfg.tabActiveColor = t[3]; _cfg.tabInactiveColor = t[4];
    }

    function doCustomize(id:String):Void {
        switch (id) {
            case "cz_bigger":  _cfg.width += 30; _cfg.height += 20;
            case "cz_smaller": _cfg.width -= 30; _cfg.height -= 20;
            case "cz_up":      _cfg.y -= 20;
            case "cz_down":    _cfg.y += 20;
            case "cz_left":    _cfg.x -= 20;
            case "cz_right":   _cfg.x += 20;
            case "cz_opac_up": _cfg.bgAlpha += 0.1;
            case "cz_opac_dn": _cfg.bgAlpha -= 0.1;
            case "cz_theme":   cycleTheme();
            default: return;
        }
        _cfg.clamp();   // keep size/position on-screen + alpha in range
        // Move is cheap (just reposition the container); size/opacity/theme need a redraw.
        if (id == "cz_up" || id == "cz_down" || id == "cz_left" || id == "cz_right") { x = _cfg.x; y = _cfg.y; }
        else rebuildPanel();
        persistConfig();
    }

    // Best-effort persist so customizations survive relaunch. writeChatConfigFile is a ZFE native
    // call; if unavailable the change is still applied live this session (guarded, no-op on failure).
    function persistConfig():Void {
        try {
            var raw:String = callTop("writeChatConfigFile", _cfg.toIni());
            zfeLog("info", "customize", "persist raw=" + clip200(raw));
        } catch (e:Dynamic) {
            zfeLog("warn", "customize", "persist threw: " + Std.string(e));
        }
    }

    /**
     * Slash-command channel switching.
     * Returns true if the command matched — caller must NOT send the text as a message.
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
        selectChannel(idx);
        return true;
    }

    // =========================================================================
    // SharedHUDTools text-entry
    //
    // Flow (per decompiled HUDTools.as + SharedHUDTools.as):
    //
    //   1. FormatTextEdit(x,y,w,h,font,size,hexColor,bgHexColor,bgAlpha)
    //      → HUDTools stores entryFormats[VENDOR] via HUDMessageProvider IPC.
    //      font arg is the engine body alias (FONT_BODY = $MAIN_Font_Light),
    //      matching HUDTools' own entry_tf default — no embed needed.
    //
    //   2. FormatOnScreenKeyboard(oskX,oskY)
    //      → HUDTools stores entryOSKFormats[VENDOR].
    //      REQUIRED even on KB/mouse: startTextEdit checks BOTH Dicts.
    //      Missing → ERROR|TXT → textFunction(null) immediately ("released").
    //
    //   3. TextEdit(callback, "")
    //      → HUDTools.startTextEdit: adds entry_tf to topLevel, focuses it,
    //        dispatches ControlMap::StartEditText. User types; Enter → callback(text).
    //      → Esc/Tab → callback(null). Fires ONCE, then textFunction is nulled.
    //
    // =========================================================================

    // =========================================================================
    // Native chat-input verb invocation (TOP-LEVEL ZFE commands)
    //
    // The v2.5.0 in-game test proved the native chat-input verbs are TOP-LEVEL ZFE
    // commands (like getRuntimeInfo / readStorage), NOT chat.v1. commands:
    //   __ZFE.call("chat.v1.setChatInputActive", ...)
    //     → {"success":false,"error":{"code":"unsupported_command",...}}
    // So we call them BARE (no "chat.v1." prefix) via callTop(). NEVER prefix these.
    //
    // sendMessage is the opposite: it is chat.v1.sendMessage ONLY — never bare (bare
    // hits the useless legacy bridge, which returns literal `false`). See sendMessage().
    // =========================================================================

    /**
     * True if a raw response looks like "command not found / not dispatched".
     * Includes unsupported_command (the v2.5.0 prefixed-verb failure mode).
     */
    static function chatVerbFailed(raw:String):Bool {
        if (raw == null) return true;
        return raw.indexOf("dispatch_failed") >= 0
            || raw.indexOf("unsupported_command") >= 0
            || raw.indexOf("Unknown op") >= 0
            || raw.indexOf("unknown command") >= 0;
    }

    /**
     * Call a TOP-LEVEL ZFE command bare (no "chat.v1." prefix). Used for the native
     * chat-input verbs. Returns Std.string(result), or "" on throw.
     */
    function callTop(verb:String, payload:String):String {
        if (_api == null) return "";
        try {
            return Std.string(_api.call(verb, payload));
        } catch (e:Dynamic) {
            zfeLog("warn", "nativein", verb + " threw: " + Std.string(e));
            return "";
        }
    }

    /** Trim a raw response for diagnostic logging (n chars max). */
    static inline function clip(s:String, n:Int):String {
        return (s == null) ? "" : (s.length > n ? s.substr(0, n) : s);
    }
    static inline function clip200(s:String):String { return clip(s, 200); }

    /**
     * v2.5.3 — the native verbs return BARE booleans/strings (NOT JSON). "Truthy" means
     * the raw, trimmed+lowercased, equals "true" OR equals "1" OR contains "success":true.
     * A bare "false" / "" / JSON / a failure response is NOT truthy. Used for
     * setChatInputActive / isChatInputActive / isChatKeyPressed / consumeChatInputSubmitted.
     */
    static function nativeTruthy(raw:String):Bool {
        if (raw == null) return false;
        var t:String = StringTools.trim(raw).toLowerCase();
        if (t.length == 0) return false;
        if (chatVerbFailed(raw)) return false;       // dispatch_failed / unsupported_command / etc.
        if (t.indexOf('"success":false') >= 0) return false;
        return t == "true" || t == "1" || t.indexOf('"success":true') >= 0;
    }

    /**
     * Parse the readChatInput buffer text. The raw may be a bare string ("hello"), a
     * JSON-quoted string ("\"hello\""), or a JSON object with a text/value/input field.
     * A bare "false" / "" is treated as no text. Returns the in-progress text.
     */
    static function parseInputText(raw:String):String {
        if (raw == null) return "";
        var t:String = StringTools.trim(raw);
        if (t.length == 0) return "";
        var low:String = t.toLowerCase();
        if (low == "false") return "";               // bare boolean "no buffer"
        // JSON object → extract a text/value/input field.
        if (t.charAt(0) == "{") {
            var f:String = extractJsonString(t, "text");
            if (f.length > 0) return f;
            f = extractJsonString(t, "value");
            if (f.length > 0) return f;
            f = extractJsonString(t, "input");
            return f;
        }
        // Strip surrounding double-quotes from a JSON-quoted bare string.
        if (t.length >= 2 && t.charAt(0) == '"' && t.charAt(t.length - 1) == '"') {
            t = t.substr(1, t.length - 2);
        }
        return t;
    }

    function openInput():Void {
        if (_inputOpen) return;
        // The open key both restores a hidden panel AND opens input (CAP-011, guaranteed).
        if (_hidden) show();
        bumpAutoHide();   // opening input = activity (the timer also never hides while input is open)
        // PRIMARY: SharedHUDTools text-entry. HUDModLoader's HUDTools dispatches the engine's
        // StartEditText/EndEditText (in the correct domain), so it LOCKS OUT the game's own keys
        // while typing. The ZFE native input only captures text — it cannot block the engine
        // (our own CustomEvent dispatch fails from the overlay domain, #1065, so WASD leaks into
        // the field). Native is therefore a last-resort, no-lock fallback only.
        openInputSharedHudTools();
        if (_inputOpen) return;
        if (_nativeInputUsable) openInputNative();
    }

    // =========================================================================
    // Native chat-input session (PRIMARY) — decoded bare-value-payload flow (v2.5.3)
    //
    //   open:   setChatInputActive("true")        (bare "true" — NOT JSON)
    //   loop:   readChatInput("{}")               -> in-progress text (show in prompt)
    //           consumeChatInputSubmitted("{}")   -> bare boolean: true == Enter pressed
    //           isChatInputActive("{}")           -> bare boolean: false == cancelled (Esc)
    //   send:   final text from readChatInput -> handleSubmittedText -> chat.v1.sendMessage
    //   close:  clearChatInput("{}") + setChatInputActive("false")
    // =========================================================================

    /**
     * Open the ZFE native chat-input session via the decoded bare-value contract.
     * Returns true on success (caller is done); false → caller falls back to
     * the SharedHUDTools path.
     */
    /**
     * Suspend (start=true) / restore (start=false) the GAME's own keyboard+gamepad routing while
     * the chat input is active. ZFE's native input captures text but does NOT block the engine, so
     * WASD/hotkeys still fire while typing. The original FO76 Text Chat mod blocks them WITHOUT ZFE
     * by dispatching the engine's ControlMap edit-text events on BSUIDataManager (the same UI-data
     * surface we already read for worldId — EULA §4(F)-safe). Best-effort + fully guarded: if the
     * class/dispatch isn't available it logs and continues (no worse than today).
     */
    function dispatchEditText(start:Bool):Void {
        var type:String = start ? "ControlMap::StartEditText" : "ControlMap::EndEditText";
        try {
            var bsui:Dynamic = untyped __global__["BSUIDataManager"];
            if (bsui == null) { zfeLog("warn", "input", "BSUIDataManager null; cannot " + type); return; }
            var ev:Dynamic;
            try {
                var ceCls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("CustomEvent");
                ev = untyped __new__(ceCls, type, { tag: "Chat" });
            } catch (ce:Dynamic) {
                ev = new flash.events.Event(type);   // fallback: engine may key off event.type alone
            }
            bsui.dispatchEvent(ev);
            zfeLog("info", "input", type + " dispatched (game input " + (start ? "suspended" : "restored") + ")");
        } catch (e:Dynamic) {
            zfeLog("warn", "input", type + " dispatch threw: " + Std.string(e));
        }
    }

    function openInputNative():Bool {
        if (_api == null) return false;
        var raw:String = callTop("setChatInputActive", "true");   // bare "true", NOT JSON
        zfeLog("info", "nativein", "setChatInputActive(true) raw=" + clip200(raw));

        // Activation worked if the raw is truthy, or isChatInputActive becomes truthy.
        var active:Bool = nativeTruthy(raw);
        if (!active) {
            var a:String = callTop("isChatInputActive", "{}");
            active = nativeTruthy(a);
            zfeLog("info", "nativein", "isChatInputActive after activate raw=" + clip200(a));
        }
        if (!active) {
            zfeLog("warn", "nativein", "setChatInputActive not active; falling back");
            return false;
        }

        _inputOpen   = true;
        _nativeInput = true;
        _inProgress  = "";
        _lastReadRaw = "";
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "native-chat-input");
        // Lock out the game's own keys while typing (ZFE captures text but doesn't block the engine).
        dispatchEditText(true);

        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
        _inputTimer = new flash.utils.Timer(INPUT_POLL_MS);
        _inputTimer.addEventListener(TimerEvent.TIMER, function(_) { pollNativeInput(); });
        _inputTimer.start();
        return true;
    }

    /**
     * In-session native input tick (every INPUT_POLL_MS while a native session is open).
     * Guarded so a parse error never stops the timer — but a submit/cancel DOES close it.
     * Only ever called while a native session is open (never polls outside one).
     */
    function pollNativeInput():Void {
        if (!_nativeInput) return;
        try {
            // ── 1. read the in-progress buffer; show it in the prompt ───────
            var rraw:String = callTop("readChatInput", "{}");
            if (rraw != _lastReadRaw) {
                _lastReadRaw = rraw;
                zfeLog("info", "nativein", "read raw=" + clip200(rraw));
            }
            var text:String = parseInputText(rraw);
            _inProgress = text;
            if (text.length > 0) {
                setPrompt(typingPrompt() + ' <font face="' + FONT_BODY + '" size="13" color="'
                    + hx(_cfg.textColor) + '"> &#x203A; ' + FcmConfig.htmlEscape(text) + '</font>');
            } else {
                setPrompt(typingPrompt());
            }

            // ── 2. submit? consume returns a bare boolean (true = Enter pressed) ──
            if (nativeTruthy(callTop("consumeChatInputSubmitted", "{}"))) {
                // Read the final buffer once more; prefer it over the cached value.
                var textNow:String = parseInputText(callTop("readChatInput", "{}"));
                var fin:String = (textNow.length > 0) ? textNow : _inProgress;
                closeInputNative();
                fin = StringTools.trim(fin);
                if (fin.length > 0) {
                    // Mark this send as native-submit so sendMessage logs the full raw
                    // (we are learning whether send works after a native session).
                    _nativeSubmitInFlight = true;
                    handleSubmittedText(fin);
                    _nativeSubmitInFlight = false;   // clear (slash-only inputs never send)
                }
                return;
            }

            // ── 3. still active? a non-truthy isChatInputActive = user cancelled (Esc) ──
            if (!nativeTruthy(callTop("isChatInputActive", "{}"))) {
                zfeLog("info", "nativein", "isChatInputActive false; cancelled");
                closeInputNative();
                return;
            }
        } catch (e:Dynamic) {
            // Never let a parse error stop the timer.
            zfeLog("warn", "nativein", "pollNativeInput threw: " + Std.string(e));
        }
    }

    /**
     * Close the native chat-input session: stop the poll timer, clear + deactivate
     * the native input (bare "false"), and reset the prompt.
     */
    function closeInputNative():Void {
        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
        var c1:String = callTop("clearChatInput", "{}");
        zfeLog("info", "nativein", "clearChatInput raw=" + clip200(c1));
        var c2:String = callTop("setChatInputActive", "false");   // bare "false", NOT JSON
        zfeLog("info", "nativein", "setChatInputActive(false) raw=" + clip200(c2));
        // Restore the game's own key routing.
        dispatchEditText(false);
        _inputOpen   = false;
        _nativeInput = false;
        _inProgress  = "";
        setPrompt(idlePrompt());
    }

    // =========================================================================
    // SharedHUDTools text-entry (FALLBACK)
    // =========================================================================

    // Dispatch a PlatformChangeEvent(PC_KB_MOUSE) so SharedHUDTools.startTextEdit picks the native
    // keyboard field (stage.focus = entry_tf) instead of the on-screen-keyboard/controller path —
    // this is what makes Backspace/arrows work. HUDTools listens for this on the stage; the event
    // ctor is (uiPlatform, bPS3Switch, uiController) and PLATFORM_PC_KB_MOUSE == 0.
    function forceKeyboardPlatform():Void {
        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("Shared.AS3.Events.PlatformChangeEvent");
            var ev:Dynamic = untyped __new__(cls, 0, false, 0);
            if (stage != null) {
                stage.dispatchEvent(ev);
                zfeLog("info", "input", "forced PC_KB_MOUSE platform (keyboard editing/backspace)");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "forceKeyboardPlatform threw: " + Std.string(e));
        }
    }

    function openInputSharedHudTools():Void {
        if (_inputOpen) return;
        if (_hudTools == null) {
            constructHudTools();
            if (_hudTools == null) {
                zfeLog("warn", "input", "SharedHUDTools unavailable; cannot open input");
                return;
            }
        }
        _inputOpen = true;
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "shared-hud-tools");

        // ── Step 0: force KEYBOARD input mode (fixes backspace) ─────────────
        // SharedHUDTools.startTextEdit uses stage.focus = entry_tf (native TextField editing,
        // incl. Backspace) ONLY when isInputKeyboard() is true — i.e. uiController ==
        // PLATFORM_PC_KB_MOUSE (0). Under Proton/Steam Input the game reports a controller, so it
        // falls to the on-screen-keyboard path (we push off-screen) and Backspace does nothing.
        // Dispatch a PlatformChangeEvent(PC_KB_MOUSE) on the stage BEFORE TextEdit so HUDTools
        // switches to keyboard mode (must be before entryMode — the same handler ends an active edit).
        forceKeyboardPlatform();

        // ── Step 1: FormatTextEdit — position + style the entry box ─────────
        // x/y are stage coordinates (1920×1080 space). Position at widget's lower edge.
        // Color args are hex strings WITHOUT '#'. Font arg is the engine body alias.
        var editX:Float = x + 6;
        var editY:Float = y + _cfg.height - INPUT_H + 4;
        var editW:Float = _cfg.width - 12;
        var editH:Float = INPUT_H - 6;

        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatTextEdit"),
                [editX, editY, editW, editH,
                 FONT_BODY,                  // engine alias — matches HUDTools' entry_tf default ($MAIN_Font_Light)
                 _cfg.fontSize,
                 nh(_cfg.tabActiveColor),    // text color — no '#'
                 nh(_cfg.tabRowColor),       // bg color — no '#'
                 0.96]);                    // bg alpha (>0 triggers background rendering)
            zfeLog("info", "input", "FormatTextEdit ok");
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "FormatTextEdit threw: " + Std.string(e));
        }

        // ── Step 2: FormatOnScreenKeyboard — REQUIRED even on PC/KB/mouse ───
        // Position off-screen (y=-300) so the gamepad OSK is invisible on PC.
        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatOnScreenKeyboard"),
                [0.0, -300.0]);
            zfeLog("info", "input", "FormatOnScreenKeyboard ok");
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "FormatOnScreenKeyboard threw: " + Std.string(e));
        }

        // ── Step 3: TextEdit — open the entry; callback fires on submit ──────
        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "TextEdit"),
                [function(text:Dynamic):Void { onInputSubmit(text); }, ""]);
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "TextEdit threw: " + Std.string(e));
            _inputOpen = false;
            setPrompt(idlePrompt());
            return;
        }
        zfeLog("info", "input", "opened");
    }

    /**
     * Callback from SharedHUDTools.TextEdit.
     * text == null: user cancelled (Esc/Tab) or TextEdit failed.
     * text == String: user submitted (Enter); may be empty.
     * Fires exactly once; textFunction is nulled by SharedHUDTools after.
     */
    function onInputSubmit(text:Dynamic):Void {
        _inputOpen = false;
        setPrompt(idlePrompt());
        var s:String = (text == null) ? "" : Std.string(text);
        handleSubmittedText(s);
    }

    /**
     * Shared submit handler — used by BOTH the native input path (pollNativeInput) and
     * the SharedHUDTools fallback (onInputSubmit). Applies the slash channel-switch
     * logic ("/g /t /e /i /r"), consuming a bare slash command, then sends the rest.
     */
    function handleSubmittedText(text:String):Void {
        var s:String = (text == null) ? "" : Std.string(text);
        s = StringTools.trim(s);
        if (s.length == 0) return;

        // /hide — hide the panel (CAP-011). Consume: never send. Restore with the open key.
        if (s.toLowerCase() == "/hide") { hide(); return; }

        // Slash-command channel switch: "/g /t /e /i /r" (or ".g" alias).
        // If the whole input IS a slash command (bare or with trailing content),
        // consume it — never let it leak through as a chat message.
        if (s.length > 1 && (s.charAt(0) == "/" || s.charAt(0) == ".")) {
            var spaceIdx:Int = s.indexOf(" ");
            var slashCmd:String = (spaceIdx > 0) ? s.substr(1, spaceIdx - 1) : s.substr(1);
            if (switchChannelBySlash(slashCmd)) {
                // Slash consumed — send remaining text (after the space) if any.
                var rest:String = (spaceIdx > 0) ? StringTools.trim(s.substr(spaceIdx + 1)) : "";
                if (rest.length == 0) return;  // bare "/g" — done, do NOT send
                s = rest;                       // "/g hello" — send "hello" to the new channel
            }
        }

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
            setLogText(linkHint());
            return;
        }

        if (raw.length > _cfg.maxSendLen) raw = raw.substr(0, _cfg.maxSendLen);
        raw = fcmClean(raw);
        if (raw.length == 0) return;

        var slug:String = CHAN_SLUGS[_chanIdx];
        var payload:String = '{"channel":"' + jsonEscape(slug) + '","targetUserId":"","body":"' + jsonEscape(raw) + '"}';
        zfeLog("info", "send", "payload ch=" + slug + " len=" + raw.length);
        try {
            // sendMessage is chat.v1.sendMessage ONLY — never bare. Bare hits the
            // useless legacy bridge (returns literal `false`) → false "Send failed."
            var rs:String = Std.string(_api.call("chat.v1.sendMessage", payload));
            // v2.5.3 diagnostic: when this send is from a just-closed native session,
            // log the FULL raw result so we learn whether send works in that context.
            if (_nativeSubmitInFlight) {
                _nativeSubmitInFlight = false;
                zfeLog("info", "nativein", "send-in-session raw=" + clip200(rs));
            }
            var success:Bool = (rs.indexOf('"success":true') >= 0 || rs.indexOf('success:true') >= 0);
            if (success) {
                zfeLog("info", "send", "sent ch=" + slug + " len=" + raw.length);
                // A successful send proves this identity is LINKED — clear the link gate.
                if (_needsLink) { _needsLink = false; _pinnedSystemBody = ""; }
                // Optimistic local echo on CONFIRMED send (only when we know our id).
                if (_relayUserId.length > 0) {
                    var messageId:String = extractJsonString(rs, "messageId");
                    var dedupKey:String = (messageId.length > 0)
                        ? echoIdKey(messageId)
                        : echoSbKey(_relayUserId, slug, raw);
                    _pendingEchoes.push({ key: dedupKey, ts: flash.Lib.getTimer() });
                    // Render immediately on the active channel.
                    if (slug == CHAN_SLUGS[_chanIdx]) {
                        // Own-message time stays blank until a server time exists (D-08).
                        _records.push({ color: hx(_cfg.senderColor), channel: slug, user: _displayName, body: raw, ts: "" });
                        while (_records.length > _cfg.maxMessages) _records.shift();
                        renderRecords();
                    }
                }
            } else {
                // Surface the relay error code to the user.
                var code:String = extractJsonString(rs, "code");
                zfeLog("warn", "send", "relay rejected code=" + code + " raw=" + rs.substr(0, 200));
                switch (code) {
                    case "permission_denied":
                        // Genuine not-linked / insufficient-role only (automod + slash now have
                        // their own codes below, so this no longer fires for filtered messages).
                        // A denied send confirms we're NOT linked → drive the persistent gate.
                        _needsLink = true;
                        setLogText(linkHint());
                    case "message_blocked":
                        setLogText("Message blocked by the chat filter.");
                    case "slash_ignored":
                        setLogText("Slash commands work in the dashboard, not in-game.");
                    case "user_muted":
                        setLogText("You are muted and cannot send right now.");
                    case "rate_limited":
                        setLogText("Sending too fast - slow down.");
                    case "invalid_channel":
                        setLogText("That channel is not available.");
                    case "message_too_long":
                        setLogText("Message too long (max " + _cfg.maxSendLen + ").");
                    case "auth_token_invalid", "auth_token_revoked", "user_banned":
                        setLogText("Chat session ended - reconnecting...");
                        _connected = false;
                        stopPollTimer();
                        scheduleConnectRetry();
                    default:
                        setLogText(code.length > 0 ? ("Send failed: " + code) : "Send failed.");
                }
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "send", "sendMessage threw: " + Std.string(e));
            setLogText("Send failed (no relay).");
        }
    }

    // =========================================================================
    // ZFE API discovery + chat.v1 boot
    // =========================================================================

    /**
     * init() — entry point called 3 s after stage attach.
     *
     * ZFE installs __ZFE on the HUDMenu root a few seconds after dxgi.dll loads.
     * Retry every ZFE_SEARCH_MS ms up to ZFE_SEARCH_MAX times (~30 s total).
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
            return;
        }
        setLogText("searching for ZFE (" + _zfeSearchTries + "/" + ZFE_SEARCH_MAX + ")...");
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

        // Capability gate: zfe-chat-online-v1 required (ZFE 0.9.8+).
        try {
            var info:String = Std.string(_api.call("chat.v1.getRuntimeInfo", "{}"));
            if (info.indexOf("zfe-chat-online-v1") < 0) {
                zfeLog("warn", "startup", "zfe-chat-online-v1 not present; need ZFE 0.9.8+");
                setLogText("ZFE 0.9.8+ required\nfor chat.v1");
                return;
            }
            zfeLog("info", "startup", VENDOR + " " + VERSION + " loaded");
            zfeLog("info", "startup", "BUILD=chatv1-widget-v2.7.7");
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
        setLogText("connecting...");

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
        // Reset the link gate on every (re)connect: if still limited, the relay re-sends the
        // link-required notice (via pollEvents) and we re-raise it; if now LINKED, no notice
        // arrives and we stay in chat. This recovers cleanly after a drop/"relay unreachable"
        // once the account has been linked on the web.
        _needsLink = false;
        zfeLog("info", "connect", "connected");
        setLogText("connected. loading...");

        bumpAutoHide();   // start the idle countdown (hides after autoHideSec if nothing happens)
        refreshAuthState();
        _cursor = 0;
        startPollTimer();
        startWorldTimer();
        startOpenKeyTimer();
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
        setLogText("retrying in " + Std.int(_connectDelay / 1000) + "s...");
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
            // One-shot startup probe — once auth succeeds, capture the full raw shapes
            // of the top-level native-input verbs (and getRuntimeInfo/getAuthState) and
            // set _nativeInputUsable. Runs exactly once per session.
            if (_authState == "authenticated" && !_probeSent) {
                _probeSent = true;
                runStartupProbe();
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
    // One-shot startup probe — clean, self-resetting (v2.5.3)
    //
    // The native API is decoded: bare-value payloads, bare-boolean returns. The probe
    // determines _nativeInputUsable cleanly — activate with bare "true", test, then
    // ALWAYS deactivate (bare "false") + clearChatInput so native input is left INACTIVE
    // (no stuck state, which fought the SharedHUDTools box in v2.5.2). Also logs
    // getRuntimeInfo / getAuthState once for reference.
    // =========================================================================

    function probe(label:String, verb:String, payload:String, max:Int):String {
        var raw:String;
        try {
            raw = Std.string(_api.call(verb, payload));
        } catch (e:Dynamic) {
            raw = "<threw: " + Std.string(e) + ">";
        }
        zfeLog("info", "probe", label + " (" + verb + ") raw=" + clip(raw, max));
        return raw;
    }

    function runStartupProbe():Void {
        if (_api == null) return;
        zfeLog("info", "probe", "startup probe begin (v" + VERSION + ")");

        // Full runtime/auth shapes (chat.v1.* — known-good prefixed commands).
        probe("getRuntimeInfo", "chat.v1.getRuntimeInfo", "{}", 800);
        probe("getAuthState",   "chat.v1.getAuthState",   "{}", 800);

        // Activate with the DECODED bare-value payload "true", test, then ALWAYS reset.
        var openRaw:String = probe("setChatInputActive(true)", "setChatInputActive", "true", 200);
        var usable:Bool = nativeTruthy(openRaw);
        if (!usable) {
            var a:String = probe("isChatInputActive", "isChatInputActive", "{}", 200);
            usable = nativeTruthy(a);
        }
        // ALWAYS leave native input INACTIVE — no stuck state.
        probe("setChatInputActive(false)", "setChatInputActive", "false", 200);
        probe("clearChatInput",            "clearChatInput",      "{}",    200);

        _nativeInputUsable = usable;
        zfeLog("info", "probe", "nativeInputUsable=" + _nativeInputUsable);
        zfeLog("info", "probe", "startup probe end");
    }

    // =========================================================================
    // Open-key poll (v2.5.3) — open chat on the ZFE OpenChatKey (PAGE_DOWN) edge
    //
    // Replaces the v2.5.2 always-on watcher. Low-rate (~150 ms), runs only while
    // connected AND no input is open. On a false->true edge of isChatKeyPressed it
    // calls openInput(). It does NOT consume/read outside an open session.
    // =========================================================================

    function startOpenKeyTimer():Void {
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
        _lastChatKey = false;
        _openKeyTimer = new flash.utils.Timer(OPEN_KEY_MS);
        _openKeyTimer.addEventListener(TimerEvent.TIMER, function(_) { pollOpenKey(); });
        _openKeyTimer.start();
        zfeLog("info", "nativein", "open-key poll started (" + OPEN_KEY_MS + "ms)");
    }

    function stopOpenKeyTimer():Void {
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
    }

    /** Open chat on a false->true edge of isChatKeyPressed (ZFE OpenChatKey = PAGE_DOWN). */
    function pollOpenKey():Void {
        if (_api == null || !_connected) return;
        try {
            // The OpenChatKey is the ONE key a HUD widget can read (isChatKeyPressed). FO76
            // collapses every other unbound key to "Unmapped" (indistinguishable), so this is
            // the only key-driven control we get. On its rising edge: open chat when closed;
            // cycle to the next channel when already open. Slash (/g /t /e /i /r) covers direct
            // jumps + reverse. (Hidden: openInput() un-hides first.)
            var kp:Bool = nativeTruthy(callTop("isChatKeyPressed", "{}"));
            if (kp && !_lastChatKey) {
                if (!_inputOpen) {
                    zfeLog("info", "nativein", "OpenChatKey edge; opening input");
                    openInput();
                } else {
                    zfeLog("info", "nativein", "OpenChatKey edge while open; cycling channel");
                    cycleChannel();
                }
            }
            _lastChatKey = kp;
        } catch (e:Dynamic) {
            zfeLog("warn", "nativein", "pollOpenKey threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // chat.v1 poll events
    // =========================================================================

    function startPollTimer():Void {
        stopPollTimer();
        _pollTimer = new Timer(_cfg.pollMs);
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

        // Expire stale optimistic-echo dedup keys (>15s) so a never-arriving
        // server echo cannot permanently suppress later messages.
        expirePendingEchoes();

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

            var rawChannel:String   = extractJsonString(obj, "channel");
            var channel:String      = normChannel(rawChannel);
            var senderUserId:String = extractJsonString(obj, "senderUserId");
            var displayName:String  = extractJsonString(obj, "senderDisplayName");
            var body:String         = extractJsonString(obj, "body");
            var messageId:String    = extractJsonString(obj, "messageId");
            var createdAt:String    = extractJsonString(obj, "createdAt");
            var evId:Int            = extractJsonInt(obj, "id");

            // Always advance the cursor, even for skipped/deduped events.
            if (evId > _cursor) _cursor = evId;
            if (body.length == 0) continue;

            // System channel — link handshake. "LINK COMPLETE" means the web redeem finished
            // (relay pushed it post-activation) → clear the gate and hand off to chat. Anything
            // else is the link-required code notice (relay sends it ONLY to limited identities).
            if (rawChannel == "system" || senderUserId == "system") {
                if (body.indexOf("LINK COMPLETE") >= 0) {
                    _needsLink = false;
                    _pinnedSystemBody = "";
                    zfeLog("info", "system", "link complete -> chat activated");
                } else {
                    _pinnedSystemBody = body;
                    _needsLink = true;
                    zfeLog("info", "system", "link notice received -> needsLink");
                }
                newRecords = true;
                continue;
            }

            // Dedup our own echoed message (already shown optimistically).
            if (isOwnEcho(messageId, senderUserId, channel, body)) {
                continue;
            }

            // Filter to active channel (server channel always passes through).
            var activeSlug:String = CHAN_SLUGS[_chanIdx];
            if (channel != activeSlug && channel != "server") continue;

            _records.push({ color: hx(_cfg.senderColor), channel: channel, user: displayName, body: body, ts: createdAt });
            while (_records.length > _cfg.maxMessages) _records.shift();
            if (_bScrolling) _newWhileScrolled++;
            newRecords = true;
        }

        if (newRecords) {
            if (_autoHideOn && _hidden) show();   // auto-hide: pop back up on a new message
            renderRecords();
            bumpAutoHide();                        // any new message counts as activity
        }
    }

    /**
     * Dedup keys for optimistic echo.
     * id key  = "id:" + messageId  (server-assigned id, when present).
     * sb key  = "sb:" + senderUserId + "|" + channel + "|" + body.
     */
    static inline function echoIdKey(messageId:String):String {
        return "id:" + messageId;
    }
    static inline function echoSbKey(userId:String, channel:String, body:String):String {
        return "sb:" + userId + "|" + channel + "|" + body;
    }

    function expirePendingEchoes():Void {
        var now:Float = flash.Lib.getTimer();
        var kept:Array<{key:String, ts:Float}> = [];
        for (e in _pendingEchoes) {
            if (now - e.ts <= 15000) kept.push(e);
        }
        _pendingEchoes = kept;
    }

    /**
     * Returns true if an incoming chat.message is our own optimistic echo
     * (already rendered locally). Consumes the matched _pendingEchoes entry.
     */
    function isOwnEcho(messageId:String, senderUserId:String, channel:String, body:String):Bool {
        // Strong signal: the relay told us our own id and it's coming back.
        if (_relayUserId.length > 0 && senderUserId == _relayUserId) {
            removePendingMatch(messageId, senderUserId, channel, body);
            return true;
        }
        // Otherwise match against pending keys.
        var idK:String = (messageId.length > 0) ? echoIdKey(messageId) : "";
        var sbUser:String = (_relayUserId.length > 0) ? _relayUserId : senderUserId;
        var sbK:String = echoSbKey(sbUser, channel, body);
        for (k in 0..._pendingEchoes.length) {
            var pk:String = _pendingEchoes[k].key;
            if ((idK.length > 0 && pk == idK) || pk == sbK) {
                _pendingEchoes.splice(k, 1);
                return true;
            }
        }
        return false;
    }

    function removePendingMatch(messageId:String, senderUserId:String, channel:String, body:String):Void {
        var idK:String = (messageId.length > 0) ? echoIdKey(messageId) : "";
        var sbUser:String = (_relayUserId.length > 0) ? _relayUserId : senderUserId;
        var sbK:String = echoSbKey(sbUser, channel, body);
        for (k in 0..._pendingEchoes.length) {
            var pk:String = _pendingEchoes[k].key;
            if ((idK.length > 0 && pk == idK) || pk == sbK) {
                _pendingEchoes.splice(k, 1);
                return;
            }
        }
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

        // First load / not linked: show ONLY the link screen — never the chat history (user
        // request). An unlinked identity can't post, so the link prompt takes the whole feed.
        if (!_connected) { setLogText("connecting..."); return; }
        // Link gate. ZFE's getAuthState.state is ALWAYS "authenticated" when merely CONNECTED
        // (it does NOT reflect the relay's linked/limited state), so we must NOT use it here.
        // The relay sends a system link-code notice ONLY to limited (unlinked) identities; its
        // arrival (_needsLink) is the authoritative "not linked" signal. Cleared on a successful
        // send (which only a linked identity can do).
        if (_needsLink) { setLogText(linkHint()); return; }

        var html:Array<String> = [];
        var fs:Int = _cfg.fontSize;

        for (rec in _records) {
            // Per-channel view: only render messages for the active tab's channel.
            if (rec.channel != CHAN_SLUGS[_chanIdx]) continue;
            var col:String  = ~/^#[0-9a-fA-F]{6}$/.match(rec.color) ? rec.color : hx(_cfg.senderColor);
            // Escape sender name + body — both are unsanitized relay/Discord input (SR-001).
            var user:String = FcmConfig.htmlEscape(rec.user);
            var msg:String  = FcmConfig.htmlEscape(rec.body);
            // Optional "HH:MM " timestamp prefix (CAP-013, D-08 — only when the event carries a time).
            var tsHtml:String = "";
            if (_cfg.showTimestamps && rec.ts != null && rec.ts != "") {
                var hm:String = FcmConfig.hhmm(rec.ts);
                if (hm != "") tsHtml = '<font color="' + hx(_cfg.timestampColor) + '">' + hm + '</font> ';
            }
            // Optional proper-cased channel tag (CAP-012, D-09).
            var tagHtml:String = "";
            if (_cfg.showChannelTag) {
                tagHtml = '<font color="' + hx(_cfg.channelColor(rec.channel)) + '">[' + FcmConfig.chanLabel(rec.channel) + ']</font> ';
            }
            // [channel] + body = light; sender name (the <b> span) = bold alias.
            html.push(
                '<font face="' + FONT_BODY + '" size="' + fs + '">'
                + tsHtml
                + tagHtml
                + '<b><font face="' + FONT_BOLD + '" color="' + col + '">' + user + ':</font></b> '
                + '<font color="' + hx(_cfg.textColor) + '">' + msg + '</font>'
                + '</font>');
        }

        // Authenticated with an empty feed (the unlinked / connecting cases returned above).
        if (html.length == 0) {
            setLogText("No messages in " + CHAN_NAMES[_chanIdx] + " yet"); return;
        }

        // "v N new" hint when scrolled up and new messages arrived below.
        if (_bScrolling && _newWhileScrolled > 0) {
            html.push('<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + hx(_cfg.tabActiveColor)
                + '">v ' + _newWhileScrolled + ' new - wheel down or F12 Scroll to newest</font>');
        }

        _logTf.htmlText = html.join("<br/>");

        if (!_bScrolling) {
            try { _logTf.setSelection(_logTf.length, _logTf.length); } catch (e:Dynamic) {}
        }
    }

    /**
     * The in-game link prompt — numbered steps (Flow A): the code is shown IN-GAME (pulled from
     * the relay's pinned notice), the player enters it on the web /link page. Multi-line htmlText;
     * dynamic bits (url, code) are htmlEscaped (crash rule #2: numeric refs only).
     */
    function linkHint():String {
        var code:String = extractLinkCode(_pinnedSystemBody);
        var url:String  = FcmConfig.htmlEscape(_cfg.linkUrl);
        var s:String =
            '<font face="' + FONT_BOLD + '" color="' + hx(_cfg.tabActiveColor) + '"><b>LINK YOUR ACCOUNT TO CHAT</b></font><br/>'
            + '<font color="' + hx(_cfg.textColor) + '">'
            + '1) Open ' + url + ' in a web browser<br/>'
            + '2) Sign in with Discord<br/>'
            + '3) Enter this code:</font> ';
        if (code.length > 0) {
            s += '<font face="' + FONT_BOLD + '" size="' + (_cfg.fontSize + 2)
                + '" color="' + hx(_cfg.tabActiveColor) + '"><b>' + FcmConfig.htmlEscape(code) + '</b></font>';
        } else {
            s += '<font color="' + hx(_cfg.promptColor) + '">(waiting for your code...)</font>';
        }
        return s;
    }

    /** Pull the "XXXX-XXXX" code out of the relay notice ("...enter code: XXXX-XXXX (expires...)"). */
    static function extractLinkCode(body:String):String {
        if (body == null) return "";
        var i:Int = body.indexOf("code: ");
        if (i < 0) return "";
        var rest:String = StringTools.trim(body.substr(i + 6));
        var out:StringBuf = new StringBuf();
        for (j in 0...rest.length) {
            var cc:Int = rest.charCodeAt(j);
            // 0-9, A-Z, a-z, '-' only; stop at the first space/paren/other.
            if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc == 45)
                out.add(rest.charAt(j));
            else break;
        }
        return out.toString();
    }

    // =========================================================================
    // Scroll
    // =========================================================================

    public function scrollUp():Void {
        if (_logTf == null) return;
        if (_logTf.scrollV > 1) { _logTf.scrollV--; _bScrolling = true; }
    }

    public function scrollDown():Void {
        if (_logTf == null) return;
        _logTf.scrollV++;
        if (_logTf.scrollV >= _logTf.maxScrollV) {
            _bScrolling = false; _newWhileScrolled = 0;
        }
    }

    public function scrollToBottom():Void {
        if (_logTf == null) return;
        try { _logTf.setSelection(_logTf.length, _logTf.length); } catch (e:Dynamic) {}
        _bScrolling = false; _newWhileScrolled = 0;
    }

    /** Mouse-wheel over the log: wheel up scrolls back, wheel down toward newest (CAP-008). */
    function onLogWheel(e:flash.events.MouseEvent):Void {
        try {
            if (e.delta > 0) scrollUp();
            else if (e.delta < 0) scrollDown();
        } catch (err:Dynamic) {
            zfeLog("warn", "scroll", "onLogWheel threw: " + Std.string(err));
        }
    }

    // =========================================================================
    // BSUIDataManager reads — displayName + worldId
    // =========================================================================

    // Returns the FO76 account/character name from the game's UI data, or "" if the game
    // hasn't populated it yet (it loads a few seconds after HUD init — NOT ready at first connect).
    // Callers must treat "" as "not ready yet" and keep waiting, not as a name.
    function readDisplayName():String {
        try {
            var a:Dynamic = untyped __global__["BSUIDataManager"].GetDataFromClient("AccountInfoData");
            if (a != null && a.data != null && a.data.name != null) {
                var n:String = Std.string(a.data.name);
                if (n.length > 0) return jsonEscape(n.substr(0, 64));
            }
        } catch (e:Dynamic) {}
        return "";
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

    /**
     * Normalize a relay-supplied channel slug to our canonical CHAN_SLUGS values.
     * Guards against the relay tagging messages "general"/"trading"/etc.
     */
    static function normChannel(c:String):String {
        c = StringTools.trim(c).toLowerCase();
        switch (c) {
            case "general":         return "global";
            case "gen":             return "global";
            case "trading":         return "trade";
            case "event":           return "events";
            case "infest", "inf":   return "infests";
            case "raid":            return "raids";
            default:                return c;
        }
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
     * ZFE (dxgi.dll) installs __ZFE on the HUDMenu root (stage.getChildAt(0)).
     *
     * SAFETY RULES:
     *   - Every property read and child access is in its own try/catch.
     *   - NO getChildAt loop on arbitrary objects.
     *   - NO BFS over stage descendants — Scaleform crashes on numChildren/getChildAt.
     *   - NO hard casts — dynamic untyped access only.
     */
    static function findZfeApi(scope:Dynamic):Dynamic {
        var NAMES:Array<String> = ["__ZFE", "ZFECodeObj", "__SFCodeObj"];

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

        // Strategy 1: stage.getChildAt(0) = HUDMenu root (most reliable)
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

        // Strategy 2: parent-chain walk (up to 25 levels)
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

        // Strategy 3: scope.root
        try {
            var r:Dynamic = null;
            try { r = scope.root; } catch (_:Dynamic) {}
            if (r != null) {
                var z:Dynamic = check(r);
                if (z != null) return z;
            }
        } catch (_:Dynamic) {}

        // Strategy 4: scope.stage direct property
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
