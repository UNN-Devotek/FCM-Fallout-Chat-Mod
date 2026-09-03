import flash.display.MovieClip;
import flash.display.Shape;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;

/**
 * FCMBridge — HUD chat feed widget for Fallout 76.
 *
 * Transport: ZFE chat.v1 or xScal chatInterface, selected automatically.
 *   __ZFE.call("chat.v1.connect",   payload)   — register + connect
 *   __ZFE.call("chat.v1.pollEvents",payload)   — poll for new events (cursor-based)
 *   __ZFE.call("chat.v1.sendMessage",payload)  — send a message
 *   __ZFE.call("chat.v1.getAuthState","{}") — connection/auth health
 *
 * The SWF never sees the raw token. ZFE stores it in a DPAPI-protected file and
 * presents it via "hello" on each session. The relay issues a userId on "register";
 * ZFE stores and re-uses it. The SWF only needs the displayName (character name).
 *
 * worldId self-read (#293, EULA §4(F)-safe — UI layer only, no memory reads):
 * BSUIDataManager.GetDataFromClient("AccountInfoData") exposes worldId via the
 * game's own HUD data layer. On world change, a reserved control message is sent
 * over chat.v1.sendMessage (channel "server", body: JSON sentinel + HMAC-SHA256
 * signature) that the relay intercepts, never broadcasts, and uses to bind the
 * subscriber to the correct world-session room.
 *
 * Channel slugs (AllowedChannels in FCM.ini):
 *   global, trade, server, events, raids, infests
 * DefaultChannel: global
 * The SWF maps human display names (GENERAL/TRADING/…) to these slugs.
 *
 * SWF CRASH HARD RULES (violations crashed the game in production):
 *   1. NO GlowFilter or any filters array — crashes Scaleform on FO76.
 *   2. NO named HTML entities (&amp; etc.) in htmlText — crashes Scaleform on FO76.
 *      Numeric character references are safe when user-controlled text needs escaping.
 *   3. Live content is escaped at the final render boundary before htmlText assignment.
 *   4. Debug panels: use tf.text (plain text), NOT htmlText.
 *
 * Design tokens from ChatOverlay.tsx, theme fo76-wasteland:
 *   update BOTH when the theme changes.
 *
 * Docs:
 *   docs/overlay/zfe/native-chat-relay/protocol-spec.md  — chat.v1 call surface
 *   docs/overlay/zfe/native-chat-relay/fcm-integration.md — FCM relay adapter + worldId
 */
class FCMBridge extends MovieClip {

    static inline var VENDOR:String    = "FCMBridge";
    static inline var PANEL_W:Int      = 360;
    static inline var PANEL_H:Int      = 248;
    static inline var TAB_H:Int        = 23;
    static inline var SUB_H:Int        = 22;
    static inline var HDR_H:Int        = 45;
    static inline var INPUT_H:Int      = 22;
    static inline var FONT_SIZE:Int    = 14;
    static inline var MAX_MSGS:Int     = 8;

    // ── chat.v1 poll / connect timing ─────────────────────────────────────────
    // Poll every 2 s during normal operation; ZFE returns events newer than the
    // last cursor. On connect failure, retry with exponential backoff.
    static inline var POLL_MS:Int           = 2000;
    static inline var CONNECT_RETRY_MS:Int  = 3000;
    static inline var CONNECT_MAX_MS:Int    = 30000;
    // worldId re-read interval (ms). BSUIDataManager worldId changes when the
    // player transitions between worlds; we poll it rather than waiting for an event.
    static inline var WORLD_POLL_MS:Int     = 5000;

    // ── Design tokens from ChatOverlay.tsx, theme fo76-wasteland ──────────────
    static inline var BG_COLOR:Int       = 0x0A0907;
    static inline var CHROME_COLOR:Int   = 0x0C0A08;
    static inline var PRIMARY:Int        = 0xF5CB5B;
    static inline var PRIMARY_HEX:String = "#F5CB5B";
    static inline var TEXT_HEX:String    = "#FAF4DA";
    static inline var INACTIVE_HEX:String= "#B49544";
    static inline var ACTIVE_TAB_L:Int   = 3;
    static inline var ACTIVE_TAB_R:Int   = 98;
    static inline var DIM_HEX:String     = "#AC9043";

    // Channel slug vocabulary — matches AllowedChannels in FCM.ini.
    // Index 0 is the default (global).
    static var CHANNEL_SLUGS:Array<String>  = ["global", "trade", "events", "infests", "raids", "server"];
    static var CHANNEL_NAMES:Array<String>  = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS", "SERVER"];

    // ── Core display state ─────────────────────────────────────────────────────
    var _api:FcmNativeApi     = null;
    var _bg:Shape;
    var _tf:TextField;
    var _subTf:TextField;
    var _fmt:TextFormat;
    var _pollTimer:Timer      = null;
    var _connectTimer:Timer   = null;
    var _worldTimer:Timer     = null;
    var _activeChannelIdx:Int = 0;   // index into CHANNEL_SLUGS / CHANNEL_NAMES
    var _records:Array<String>= [];  // ring of "slug|displayName|body" strings
    var _bScrolling:Bool      = false;
    var _newWhileScrolled:Int = 0;

    // ── chat.v1 session state ─────────────────────────────────────────────────
    var _connected:Bool       = false;  // true after a successful chat.v1.connect
    var _userId:String        = "";     // relay-issued userId (from connect/auth state)
    var _relayUserId:String   = "";     // alias for worldId HMAC (same as _userId)
    var _connectDelay:Int     = CONNECT_RETRY_MS;
    var _connectAttempts:Int  = 0;
    // Cursor for chat.v1.pollEvents — advances with each batch of events received.
    var _cursor:Int           = 0;
    // worldId last reported to the relay; send the control message only on change.
    var _lastWorldId:String   = "";
    // true while the player is in a world (worldId non-empty) — gates the SERVER tab.
    var _inWorld:Bool         = false;
    // Display name (character name) — read from AccountInfoData on first connect.
    var _displayName:String   = "Wanderer";

    // ── Auth state gate ───────────────────────────────────────────────────────
    // "authenticated" = player may send. "limited" = account not yet linked;
    // only receive events and show the pinned link-code system notice.
    var _authState:String     = "limited";   // conservative default until confirmed
    // Pinned system notice body — last received system event body (link code).
    // Rendered above the feed when non-empty and auth is limited.
    var _pinnedSystemBody:String = "";

    // ── Boot retry for ZFE API discovery ──────────────────────────────────────
    var _bootTimer:Timer      = null;
    var _bootTries:Int        = 0;
    static inline var BOOT_MS:Int  = 1500;
    static inline var BOOT_MAX:Int = 40;

    // ── Host-injected ZFE reference ───────────────────────────────────────────
    // The patched HUDMenu holds __ZFE at the top (parent) level even when
    // ZFE's child_bridge_access=disabled prevents ZFE from auto-injecting into
    // child SWFs. fcmSetZfe() lets the parent share its reference directly,
    // bypassing the need for self-discovery in the child SWF.
    var _zfeInjectedByHost:Bool = false;

    // ── Auto-hide ─────────────────────────────────────────────────────────────
    static inline var AUTOHIDE_MS:Int  = 25000;
    static inline var FADE_TICK_MS:Int = 50;
    static inline var FADE_STEP:Float  = 0.04;
    var _lastActivityAt:Float  = 0;
    var _hideTimer:Timer       = null;

    // ── HMAC-SHA256 shared secret (worldId control message) ───────────────────
    // This value is embedded at build time and also known to the relay.
    // It is NOT a user authentication credential — the relay token (ZFE DPAPI)
    // is the identity anchor. This secret exists solely to prevent a misbehaving
    // client from spoofing worldId for other users on the same relay connection.
    // Residual: a user CAN spoof their own client-read worldId (accepted, low stakes).
    static inline var WORLD_HMAC_SECRET:String = "fcm-world-v1-dev-placeholder";
    // Sentinel prefix that the relay uses to recognise a worldId control message.
    // MUST match the relay's intercept check. Never broadcast, never persisted.
    static inline var WORLD_CTRL_PREFIX:String = "\x00fcm.world.v1\x00";
    // LEAVE control (player left their world). Body:
    // "\x00fcm.world.leave.v1\x00<relayUserId>|<ts>|<hmac>", hmac over "leave|<userId>|<ts>".
    static inline var WORLD_LEAVE_PREFIX:String = "\x00fcm.world.leave.v1\x00";

    // ─────────────────────────────────────────────────────────────────────────

    /** Called by the patched HUDMenu when the player opens chat — un-hides the feed. */
    public function fcmWake():Void {
        _lastActivityAt = flash.Lib.getTimer();
        if (alpha < 1) alpha = 1;
    }

    function onHideTick(e:TimerEvent):Void {
        if (flash.Lib.getTimer() - _lastActivityAt <= AUTOHIDE_MS) return;
        if (alpha > 0) {
            alpha -= FADE_STEP;
            if (alpha < 0) alpha = 0;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    static function main():Void {
        flash.Lib.current.addChild(new FCMBridge());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    function onStage(e:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onStage);
        buildPanel();
        _lastActivityAt = flash.Lib.getTimer();
        _hideTimer = new Timer(FADE_TICK_MS);
        _hideTimer.addEventListener(TimerEvent.TIMER, onHideTick);
        _hideTimer.start();
        // ZFE needs a few seconds after game load before its API is ready.
        var delay = new Timer(3000, 1);
        delay.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { init(); });
        delay.start();
    }

    // =========================================================================
    // Panel chrome — unchanged from the pre-chat.v1 build
    // =========================================================================

    function buildPanel():Void {
        _bg = new Shape();
        _bg.graphics.beginFill(BG_COLOR, 0.72);
        _bg.graphics.lineStyle(1, PRIMARY, 0.25);
        _bg.graphics.drawRect(0, 0, PANEL_W, PANEL_H);
        _bg.graphics.endFill();
        _bg.graphics.lineStyle();
        _bg.graphics.beginFill(CHROME_COLOR, 0.92);
        _bg.graphics.drawRect(1, 1, PANEL_W - 2, HDR_H - 1);
        _bg.graphics.endFill();
        _bg.graphics.lineStyle(1, PRIMARY, 0.45);
        _bg.graphics.moveTo(0, HDR_H);
        _bg.graphics.lineTo(PANEL_W, HDR_H);
        _bg.graphics.lineStyle(1, PRIMARY, 0.25);
        _bg.graphics.moveTo(0, PANEL_H - INPUT_H);
        _bg.graphics.lineTo(PANEL_W, PANEL_H - INPUT_H);
        addChild(_bg);

        var falloutTf = new TextField();
        falloutTf.x = 8; falloutTf.y = 4;
        falloutTf.width = 200; falloutTf.height = TAB_H;
        styleChrome(falloutTf);
        falloutTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + PRIMARY_HEX + '"><b>FALLOUT 76</b></font>';
        addChild(falloutTf);

        var tw:Float = falloutTf.textWidth;
        if (tw < 40) tw = 86;
        var tabRight:Int = Std.int(8 + tw) + 7;
        _bg.graphics.lineStyle(1, PRIMARY, 0.6);
        _bg.graphics.moveTo(0, TAB_H);
        _bg.graphics.lineTo(ACTIVE_TAB_L, TAB_H);
        _bg.graphics.moveTo(tabRight, TAB_H);
        _bg.graphics.lineTo(PANEL_W, TAB_H);
        _bg.graphics.lineStyle(1, PRIMARY, 0.6);
        _bg.graphics.moveTo(ACTIVE_TAB_L, TAB_H);
        _bg.graphics.lineTo(ACTIVE_TAB_L, 2);
        _bg.graphics.lineTo(tabRight, 2);
        _bg.graphics.lineTo(tabRight, TAB_H);

        var partyTf = new TextField();
        partyTf.x = tabRight + 10; partyTf.y = 4;
        partyTf.width = 80; partyTf.height = TAB_H;
        styleChrome(partyTf);
        partyTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + INACTIVE_HEX + '"><b>PARTY</b></font>';
        addChild(partyTf);

        _subTf = new TextField();
        _subTf.x = 8; _subTf.y = TAB_H + 3;
        _subTf.width = PANEL_W - 16; _subTf.height = SUB_H;
        styleChrome(_subTf);
        renderSubTabs();
        addChild(_subTf);

        _tf = new TextField();
        _tf.x = 8;
        _tf.y = HDR_H + 4;
        _tf.width  = PANEL_W - 16;
        _tf.height = PANEL_H - HDR_H - INPUT_H - 6;
        _tf.multiline  = true;
        _tf.wordWrap   = true;
        _tf.selectable = false;
        _tf.mouseEnabled = false;
        _tf.embedFonts = true;
        _fmt = new TextFormat();
        _fmt.font    = "$$MAIN_Font";
        _fmt.size    = FONT_SIZE;
        _fmt.color   = 0xFAF4DA;
        _fmt.leading = 4;
        _tf.defaultTextFormat = _fmt;
        setText("connecting...");
        addChild(_tf);

        // inp is the visible input bar. The patched HUDMenu's real TextField
        // sits borderless on top of this so exactly one box shows.
        var inp = new TextField();
        inp.x = 0; inp.y = PANEL_H - INPUT_H;
        inp.width = PANEL_W; inp.height = INPUT_H;
        inp.selectable = false;
        inp.mouseEnabled = false;
        inp.embedFonts = true;
        inp.background = true;
        inp.backgroundColor = CHROME_COLOR;
        inp.border = true;
        inp.borderColor = PRIMARY;
        // Text invisible (background colour) — present only for fcmFindByText anchor.
        inp.htmlText = '<font face="$$MAIN_Font" size="13" color="#0C0A08">   Chat via the FCM overlay...</font>';
        addChild(inp);

        x = 5;
        y = 5;
    }

    function styleChrome(tf:TextField):Void {
        tf.selectable = false;
        tf.mouseEnabled = false;
        tf.embedFonts = true;
    }

    /**
     * Channel slug-indices in DISPLAY order. SERVER (slug index 5) is shown
     * immediately right of GENERAL, but ONLY while the player is in a world.
     */
    function tabOrder():Array<Int> {
        return _inWorld ? [0, 5, 1, 2, 3, 4] : [0, 1, 2, 3, 4];
    }

    /**
     * Render sub-tab row: GENERAL [SERVER] TRADING EVENTS INFESTS RAIDS
     * SERVER appears right of GENERAL only while in a world (worldId-bound room).
     */
    function renderSubTabs():Void {
        if (_subTf == null) return;
        var html:Array<String> = [];
        for (si in tabOrder()) {
            var color = (si == _activeChannelIdx) ? PRIMARY_HEX : INACTIVE_HEX;
            html.push('<font face="$$MAIN_Font" size="13" color="' + color + '"><b>' + CHANNEL_NAMES[si] + '</b></font>');
        }
        _subTf.htmlText = html.join('<font face="$$MAIN_Font" size="13" color="' + INACTIVE_HEX + '">  </font>');
    }

    // =========================================================================
    // Init — ZFE API discovery + chat.v1 boot
    // =========================================================================

    function init():Void {
        _api = FcmNativeApi.discover(this);
        if (_api == null) {
            // ZFE attaches to the in-world HUD movie AFTER we load (we boot from
            // fcmInit at the very start of HUDMenu's construction), so a single
            // early probe misses it. Retry every BOOT_MS up to BOOT_MAX (~60s) —
            // same pattern as the widget's proven ZFE search loop. fcmSetZfe()
            // (host handover) can still win the race at any point.
            setText("searching for ZFE/xScal (" + _bootTries + "/" + BOOT_MAX + ")...");
            if (_bootTimer == null) {
                _bootTimer = new Timer(BOOT_MS);
                _bootTimer.addEventListener(TimerEvent.TIMER, function(_) { bootRetry(); });
                _bootTimer.start();
            }
            return;
        }
        postDiscoveryInit();
    }

    function bootRetry():Void {
        if (_api != null) { stopBootTimer(); return; } // host handover won the race
        _bootTries++;
        _api = FcmNativeApi.discover(this);
        if (_api != null) {
            stopBootTimer();
            postDiscoveryInit();
            return;
        }
        if (_bootTries >= BOOT_MAX) {
            stopBootTimer();
            setText("ZFE/xScal not found\nInstall one script extender");
            return;
        }
        setText("searching for ZFE/xScal (" + _bootTries + "/" + BOOT_MAX + ")...\n" + diagZfe(this));
    }

    function stopBootTimer():Void {
        if (_bootTimer != null) { _bootTimer.stop(); _bootTimer = null; }
    }

    /**
     * Called by the patched HUDMenu (fcm-inject.as) to inject the native
     * provider reference attached at the top-level (parent) SWF.
     *
     * ZFE 0.9.8 sets child_bridge_access=disabled — it does NOT auto-inject
     * __ZFE into child SWFs. xScal likewise exposes __SFECodeObj on the host
     * HUD movie. Sharing either reference here lets FCMBridge function fully
     * without relying on child-SWF global lookup.
     *
     * Safe to call even if self-discovery already succeeded (no-op in that case).
     * Safe to call before self-discovery finishes (drives boot if api is null).
     */
    public function fcmSetZfe(api:Dynamic):Void {
        if (_zfeInjectedByHost) return;       // already injected
        if (api == null) return;
        if (_api != null) return;             // self-discovery already succeeded
        _zfeInjectedByHost = true;
        var detected:FcmNativeApi = FcmNativeApi.fromExposed(api);
        if (detected == null) {
            _zfeInjectedByHost = false;
            return;
        }
        _api = detected;
        zfeLog("info", _api.provider, "api injected by host");
        postDiscoveryInit();
    }

    /** Host handover for either script extender. */
    public function fcmSetNativeApi(api:Dynamic):Void {
        if (_zfeInjectedByHost || api == null || _api != null) return;
        _zfeInjectedByHost = true;
        _api = FcmNativeApi.fromExposed(api);
        if (_api == null) {
            _zfeInjectedByHost = false;
            return;
        }
        zfeLog("info", _api.provider, "api injected by host");
        postDiscoveryInit();
    }

    /**
     * Post-discovery boot: capability check + displayName read + connect.
     * Called both from init() (self-discovery path) and fcmSetZfe() (host-inject
     * path) so the two paths converge on exactly the same startup sequence.
     */
    function postDiscoveryInit():Void {
        zfeLog("info", "startup", "FCMBridge loaded");
        zfeLog("info", "startup", "BUILD=chatv1");

        // Verify the chat.v1 capability is available.
        try {
            var info:String = Std.string(_api.call("getRuntimeInfo", "{}"));
            if (_api.provider == FcmNativeApi.ZFE && info.indexOf("zfe-chat-online-v1") < 0) {
                zfeLog("warn", "startup", "zfe-chat-online-v1 capability not present; check ZFE version (need 0.9.8+)");
                setText("ZFE 0.9.8+ or xScal chat\ninterface required");
                return;
            }
            zfeLog("info", _api.provider == FcmNativeApi.ZFE ? "zfe" : "xscal",
                _api.provider == FcmNativeApi.ZFE ? "zfe-chat-online-v1 OK" : "xscal-chat-interface OK");
        } catch (e:Dynamic) {
            zfeLog("warn", "startup", "getRuntimeInfo threw: " + Std.string(e));
        }

        // Read the character / account display name for the connect call. Only
        // overwrite when the SELF-read succeeds: in the standalone build the host
        // (patched HUDMenu) may already have fed the real name via fcmSetPlayerName,
        // and the child-SWF read can fail -> "Wanderer" (must not clobber the feed).
        var selfName:String = readDisplayName();
        if (selfName != null && selfName.length > 0 && selfName != "Wanderer") _displayName = selfName;

        startConnect();
    }

    // =========================================================================
    // chat.v1 connect / reconnect
    // =========================================================================

    function startConnect():Void {
        if (_api == null) return;
        _connectAttempts++;
        zfeLog("info", "connect", "attempt=" + _connectAttempts + " displayName=" + _displayName);

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
        _connectDelay = CONNECT_RETRY_MS; // reset backoff on success
        zfeLog("info", "connect", "connected");
        setText("connected. loading...");

        // Read userId from auth state (needed for worldId HMAC).
        refreshAuthState();

        // Start polling for events.
        _cursor = 0; // reset cursor on fresh connect
        startPollTimer();

        // Start worldId polling for server-channel room binding.
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
    }

    // =========================================================================
    // chat.v1 auth state — read userId for worldId HMAC
    // =========================================================================

    function refreshAuthState():Void {
        if (_api == null) return;
        try {
            var state:String = Std.string(_api.call("chat.v1.getAuthState", "{}"));
            // Extract userId — looks for "userId":"user_…" or userId:"user_…"
            var uid:String = extractJsonString(state, "userId");
            if (uid.length > 0) {
                _userId = uid;
                _relayUserId = uid;
                zfeLog("info", "auth", "userId=" + uid.substr(0, 16) + "…");
            }
            // Track auth state for the input gate.
            // "authenticated" → player may send. "limited" → account not yet linked;
            // sendMessage is blocked and the pinned link-code notice is shown.
            var prevAuthState:String = _authState;
            if (state.indexOf('"state":"authenticated"') >= 0 || state.indexOf('state:"authenticated"') >= 0) {
                _authState = "authenticated";
            } else {
                _authState = "limited";
            }
            if (_authState != prevAuthState) {
                zfeLog("info", "auth", "authState=" + _authState);
                // Re-render so the pinned notice or cleared state is reflected immediately.
                renderRecords(_records);
            }
            // Detect disconnection.
            if (_authState != "authenticated") {
                if (_connected) {
                    zfeLog("warn", "auth", "state not authenticated; reconnecting");
                    _connected = false;
                    stopPollTimer();
                    scheduleConnectRetry();
                }
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "auth", "getAuthState threw: " + Std.string(e));
        }
    }

    /**
     * Whether the player is permitted to send chat messages.
     * Returns true only when the relay confirms "authenticated".
     * fcm-inject.as calls this via the public fcmCanSend() method.
     */
    public function fcmCanSend():Bool {
        return _authState == "authenticated";
    }

    /**
     * Returns the pinned system notice body for the limited state,
     * or "" when auth is confirmed. Used by fcm-inject.as to render
     * the "link your account" hint in the input bar.
     */
    public function fcmLinkHint():String {
        if (_authState == "authenticated") return "";
        // Show a shorter version of the pinned body if we have one.
        if (_pinnedSystemBody.length > 0) return _pinnedSystemBody;
        return "Link your account at falloutchatmod.com/link to chat";
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
            // Auth failure — reconnect.
            if (rs.indexOf('auth_token_invalid') >= 0 || rs.indexOf('auth_token_revoked') >= 0 || rs.indexOf('user_banned') >= 0) {
                zfeLog("warn", "poll", "auth error; reconnecting");
                _connected = false;
                stopPollTimer();
                scheduleConnectRetry();
            }
            return;
        }

        // Parse events array. Each event is a JSON object; we pull out the fields
        // we need using simple string scanning (no JSON parser in Scaleform AS3).
        parseAndRenderEvents(rs);
    }

    function parseAndRenderEvents(rs:String):Void {
        // Find the events array. Look for '"events":[' or 'events:['.
        var evStart:Int = rs.indexOf('"events":[');
        if (evStart < 0) evStart = rs.indexOf('events:[');
        if (evStart < 0) return; // no events key

        // Scan individual event objects in the array.
        // Each event: {...} separated by commas within the array.
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

            // Only process chat.message events.
            if (obj.indexOf('"chat.message"') < 0 && obj.indexOf('chat.message') < 0) {
                // Still advance cursor.
                updateCursorFromEvent(obj);
                continue;
            }

            var channel:String      = extractJsonString(obj, "channel");
            var senderUserId:String = extractJsonString(obj, "senderUserId");
            var displayName:String  = extractJsonString(obj, "senderDisplayName");
            var body:String         = extractJsonString(obj, "body");
            var evId:Int            = extractJsonInt(obj, "id");

            // Advance cursor so next poll continues from here.
            if (evId > _cursor) _cursor = evId;

            // Skip empty bodies.
            if (body.length == 0) continue;

            // System channel / system sender — link-code notices from the relay.
            // These are pinned above the feed (not scrolled away) so the player
            // sees the link-code + falloutchatmod.com/link instruction.
            // Shape: { channel:"system", senderUserId:"system", senderDisplayName:"FCM",
            //          body:"LINK REQUIRED - visit falloutchatmod.com/link, sign in, and enter code: XXXX-XXXX (expires 10m)" }
            if (channel == "system" || senderUserId == "system") {
                _pinnedSystemBody = body;
                zfeLog("info", "system", "pinned system notice updated");
                newRecords = true; // trigger re-render to show updated pin
                continue;
            }

            // Store ALL known channels (channel-tagged); renderRecords filters to the
            // active tab. This replaces the old ingest-time filter (which leaked
            // 'server' into every tab and lost other channels' history on switch).
            if (CHANNEL_SLUGS.indexOf(channel) < 0) continue;

            // Record format: "slug|displayName|body" (delimiter-safe; HTML-escaped at render)
            _records.push(channel + "|" + displayName + "|" + body);
            while (_records.length > MAX_MSGS) _records.shift();
            newRecords = true;
        }

        if (newRecords) {
            renderRecords(_records);
            fcmWake();
        }
    }

    function updateCursorFromEvent(obj:String):Void {
        var evId:Int = extractJsonInt(obj, "id");
        if (evId > _cursor) _cursor = evId;
    }

    // =========================================================================
    // worldId self-read and control message (#293)
    // =========================================================================

    function startWorldTimer():Void {
        if (_worldTimer != null) { _worldTimer.stop(); _worldTimer = null; }
        _worldTimer = new Timer(WORLD_POLL_MS);
        _worldTimer.addEventListener(TimerEvent.TIMER, function(_) { checkWorldId(); });
        _worldTimer.start();
        checkWorldId(); // immediate
    }

    function checkWorldId():Void {
        if (_api == null || !_connected) return;
        // Fallback self-read from BSUIDataManager — the same sanctioned UI-layer
        // data source the game itself uses for HUD display. EULA §4(F)-safe.
        // NOTE: in the standalone build the AUTHORITATIVE feed is the patched
        // HUDMenu calling fcmSetWorldId() (HUDMenu scope, where BSUIDataManager is
        // guaranteed reachable — a child-SWF read can fail with ReferenceError).
        // This fallback therefore only ever signals JOIN (non-empty reads): an
        // empty read here is indistinguishable from "can't read in this scope",
        // so it must NOT be treated as a world-leave.
        var worldId:String = readWorldId();
        if (worldId.length == 0) return;
        applyWorldId(worldId);
    }

    /**
     * AUTHORITATIVE worldId feed from the patched HUDMenu (fcm-inject.as polls
     * BSUIDataManager in HUDMenu scope and pushes the value here, the same way
     * __ZFE is handed over). Empty string = the player LEFT their world.
     */
    public function fcmSetWorldId(worldId:String):Void {
        if (worldId == null) worldId = "";
        applyWorldId(worldId);
    }

    /** True while the player is in a world — the patched HUDMenu gates /server on this. */
    public function fcmInWorld():Bool {
        return _inWorld;
    }

    /**
     * HUDMenu-scope player-name feed (AccountInfoData.name). The bridge's own
     * child-SWF read can fail (-> "Wanderer"); the host feed fixes the sender name.
     * Used at (re)connect time — chat.v1.connect passes displayName to the relay.
     */
    public function fcmSetPlayerName(name:String):Void {
        if (name == null) return;
        name = StringTools.trim(name);
        if (name.length == 0 || name == _displayName) return;
        _displayName = name;
        zfeLog("info", "world", "player name fed from HUDMenu scope");
        // If we already connected (as the "Wanderer" fallback), re-issue
        // chat.v1.connect with the corrected name: ZFE reuses its stored token and
        // re-hellos, and the relay's hello handler updates the identity's fo76Name
        // (and the linked account's fo76_account_name) — fixing the sender name on
        // all subsequent messages without a game restart.
        if (_connected && _api != null) {
            var payload:String = '{"displayName":"' + jsonEscape(_displayName) + '","autoRegister":true}';
            try {
                _api.call("chat.v1.connect", payload);
                zfeLog("info", "world", "re-connect issued with corrected player name");
            } catch (e:Dynamic) {
                zfeLog("warn", "world", "name re-connect threw: " + Std.string(e));
            }
        }
    }

    /** worldId change detection + JOIN/LEAVE control dispatch + SERVER tab gating. */
    function applyWorldId(worldId:String):Void {
        if (worldId == _lastWorldId) return;   // no change
        var wasInWorld:Bool = _inWorld;
        _lastWorldId = worldId;
        _inWorld     = (worldId.length > 0);
        if (_api != null && _connected) {
            if (_inWorld) {
                zfeLog("info", "world", "joined world; sending JOIN control");
                sendWorldIdControl(worldId);
            } else if (wasInWorld) {
                zfeLog("info", "world", "left world; sending LEAVE control");
                sendWorldLeaveControl();
            }
        }
        // SERVER tab appears/disappears with world membership; snap off it on leave.
        if (!_inWorld && _activeChannelIdx == 5) _activeChannelIdx = 0;
        renderSubTabs();
        renderRecords(_records);
    }

    function sendWorldIdControl(worldId:String):Void {
        if (_api == null || !_connected) return;
        // Build the control message body: sentinel prefix + worldId + HMAC.
        // Format: "\x00fcm.world.v1\x00<worldId>|<relayUserId>|<timestamp>|<hmac>"
        // The relay intercepts any body that starts with WORLD_CTRL_PREFIX,
        // verifies the HMAC, stores worldId for room binding, and never broadcasts.
        // unix SECONDS — must match the relay's Date.now()/1000 freshness clock.
        // (flash.Lib.getTimer() is SWF uptime, NOT unix time — the relay would reject it.)
        var ts:String = Std.string(Std.int(Date.now().getTime() / 1000));
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

    /** LEAVE control — unbinds this identity from its world room on the relay. */
    function sendWorldLeaveControl():Void {
        if (_api == null || !_connected || _relayUserId.length == 0) return;
        var ts:String = Std.string(Std.int(Date.now().getTime() / 1000));   // unix SECONDS
        var hmac:String = hmacSha256Hex(WORLD_HMAC_SECRET, "leave|" + _relayUserId + "|" + ts);
        var body:String = WORLD_LEAVE_PREFIX + _relayUserId + "|" + ts + "|" + hmac;
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + jsonEscape(body) + '"}';
        try {
            _api.call("chat.v1.sendMessage", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "world", "leave sendMessage threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // chat.v1 send (called from the patched HUDMenu via fcm-inject.as)
    // =========================================================================

    /**
     * Send a chat message on the currently active channel.
     * Called by the injected HUDMenu code (fcm-inject.as) when the player presses ENTER.
     * body must already be trimmed and short enough (fcm-inject.as truncates to 225 chars).
     *
     * GATE: blocked when auth state is not "authenticated" (e.g. account not yet linked).
     * The caller (fcm-inject.as) should check fcmCanSend() before calling, but this method
     * also enforces the gate defensively.
     */
    public function fcmSendMessage(body:String, channelSlug:String):Void {
        if (_api == null || !_connected) {
            zfeLog("warn", "send", "not connected; cannot send");
            return;
        }
        if (_authState != "authenticated") {
            zfeLog("warn", "send", "send blocked; authState=" + _authState + " (account not linked)");
            return;
        }
        if (body == null || body.length == 0) return;
        var slug:String = (channelSlug != null && channelSlug.length > 0) ? channelSlug : CHANNEL_SLUGS[_activeChannelIdx];
        var payload:String = '{"channel":"' + jsonEscape(slug) + '","targetUserId":"","body":"' + jsonEscape(body) + '"}';
        try {
            _api.call("chat.v1.sendMessage", payload);
            zfeLog("info", "send", "sent ch=" + slug + " len=" + body.length);
        } catch (e:Dynamic) {
            zfeLog("warn", "send", "call threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // Channel switching — called from patched HUDMenu
    // =========================================================================

    public function fcmSwitchChannelTo(idx:Int):Void {
        // SERVER (idx 5) is selectable only while in a world; anything else invalid -> GENERAL.
        if (idx < 0 || idx > 5 || (idx == 5 && !_inWorld)) idx = 0;
        _activeChannelIdx = idx;
        // Records are channel-tagged and kept across switches; renderRecords filters
        // to the active tab (clearing here would discard history the poll already drained).
        renderSubTabs();
        renderRecords(_records);
        fcmWake();
        zfeLog("info", "chan", "switched to " + CHANNEL_SLUGS[idx]);
    }

    /** Select the previous channel in the same display order as the HUD widget. */
    public function fcmSwitchChannelPrev():Void {
        var order:Array<Int> = _inWorld ? [0, 5, 1, 2, 3, 4] : [0, 1, 2, 3, 4];
        var pos:Int = order.indexOf(_activeChannelIdx);
        if (pos < 0) pos = 0;
        fcmSwitchChannelTo(order[(pos - 1 + order.length) % order.length]);
    }

    public function fcmActiveChannelSlug():String {
        return CHANNEL_SLUGS[_activeChannelIdx];
    }

    // =========================================================================
    // Render — driven by pollEvents; record format "slug|displayName|body"
    // =========================================================================

    function renderRecords(records:Array<String>):Void {
        if (_tf == null) return;
        var lines:Array<String> = [];

        // Pinned system notice — shown above the feed when auth is limited.
        // Re-emitted by the relay if the link code refreshes; always shows the latest.
        if (_authState != "authenticated" && _pinnedSystemBody.length > 0) {
            lines.push("** " + htmlEscape(_pinnedSystemBody) + " **");
        }

        // Filter to the ACTIVE channel tab (records are channel-tagged).
        var activeSlug:String = CHANNEL_SLUGS[_activeChannelIdx];
        for (rec in records) {
            var f = rec.split("|");
            if (f.length < 3) continue;
            var slug:String = f[0];
            if (slug != activeSlug) continue;
            var name:String = f[1];
            var body:String = f.slice(2).join("|");
            lines.push("[" + htmlEscape(slug) + "] " + htmlEscape(name) + ": " + htmlEscape(body));
        }
        if (lines.length == 0) { setText("no messages in " + CHANNEL_NAMES[_activeChannelIdx] + " yet"); return; }
        setText(lines.join("\n"));
        if (!_bScrolling) {
            try { _tf.scrollV = _tf.maxScrollV; } catch (e:Dynamic) {}
        }
    }

    /** Keyboard-scroll entry points used by the patched HUDMenu standalone path. */
    public function fcmScrollUp():Void {
        if (_tf == null) return;
        try {
            if (_tf.scrollV > 1) {
                _tf.scrollV--;
                _bScrolling = true;
            }
        } catch (e:Dynamic) {}
    }

    public function fcmScrollDown():Void {
        if (_tf == null) return;
        try {
            var max:Int = _tf.maxScrollV;
            if (max <= 1) {
                _bScrolling = false;
                _newWhileScrolled = 0;
            } else {
                if (_tf.scrollV < max) _tf.scrollV++;
                if (_tf.scrollV >= max) {
                    _tf.scrollV = max;
                    _bScrolling = false;
                    _newWhileScrolled = 0;
                }
            }
        } catch (e:Dynamic) {}
    }

    public function fcmScrollToBottom():Void {
        if (_tf == null) return;
        try { _tf.scrollV = _tf.maxScrollV; } catch (e:Dynamic) {}
        _bScrolling = false;
        _newWhileScrolled = 0;
    }

    function setText(s:String):Void {
        if (_tf == null) return;
        _tf.htmlText = '<font face="$$MAIN_Font" size="' + FONT_SIZE + '" color="' + TEXT_HEX + '">' + s + '</font>';
    }

    /**
     * Escape remote/user-controlled text before it is interpolated into a
     * Scaleform GFx htmlText string. Named entities are not safe on FO76's
     * parser, so this deliberately matches FcmConfig.htmlEscape and emits
     * numeric character references only.
     */
    static function htmlEscape(s:String):String {
        if (s == null) return "";
        s = StringTools.replace(s, "&", "&#38;");
        s = StringTools.replace(s, "<", "&#60;");
        s = StringTools.replace(s, ">", "&#62;");
        s = StringTools.replace(s, '"', "&#34;");
        return s;
    }

    // =========================================================================
    // Utility — display name and worldId reads via BSUIDataManager
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
    // HMAC-SHA256 — pure AS3/Haxe implementation for the worldId control message.
    // This is a compact implementation suitable for small fixed-size secrets.
    // =========================================================================

    /**
     * HMAC-SHA256(key, data) → lowercase hex string.
     * key and data are treated as UTF-8 strings.
     */
    static function hmacSha256Hex(key:String, data:String):String {
        var keyBytes:Array<Int>  = stringToBytes(key);
        var dataBytes:Array<Int> = stringToBytes(data);

        // If key > 64 bytes, hash it first.
        if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
        // Pad key to 64 bytes.
        while (keyBytes.length < 64) keyBytes.push(0);

        var ipad:Array<Int> = [];
        var opad:Array<Int> = [];
        for (i in 0...64) { ipad.push(keyBytes[i] ^ 0x36); opad.push(keyBytes[i] ^ 0x5c); }

        var inner:Array<Int>  = sha256(ipad.concat(dataBytes));
        var outer:Array<Int>  = sha256(opad.concat(inner));
        return bytesToHex(outer);
    }

    // SHA-256 — standard implementation, no external deps.
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
        // Append 64-bit big-endian length (fits in 32 bits for our use case).
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

    static inline function add32(a:Int, b:Int):Int {
        return untyped (a + b) | 0;
    }
    static inline function ror32(x:Int, n:Int):Int {
        return (x >>> n) | (x << (32 - n));
    }

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
        for (b in bytes) {
            out += hex.charAt((b >> 4) & 0xf);
            out += hex.charAt(b & 0xf);
        }
        return out;
    }

    // =========================================================================
    // JSON helpers — minimal string scanning, no parser dependency
    // =========================================================================

    /** Extract a string value for a given JSON key. Returns "" if not found. */
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

    /** Extract an integer value for a given JSON key. Returns 0 if not found. */
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
     * Escape a string for embedding in a JSON string value.
     * Strips or replaces characters that would break the JSON or Scaleform.
     */
    static function jsonEscape(s:String):String {
        if (s == null) return "";
        s = s.split("\\").join("\\\\");
        s = s.split('"').join('\\"');
        s = s.split("\r").join("\\r");
        s = s.split("\n").join("\\n");
        s = s.split("\t").join("\\t");
        return s;
    }

    // =========================================================================
    // ZFE log
    // =========================================================================

    function zfeLog(level:String, category:String, message:String):Void {
        if (_api == null) return;
        try {
            _api.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level +
                '","category":"' + category + '","message":"' + jsonEscape(message) + '"}');
        } catch (e:Dynamic) {}
    }

    // =========================================================================
    // ZFE API discovery — unchanged from pre-chat.v1 build
    // =========================================================================

    /** Probe one object for the ZFE bridge, modern-first. Per the ZFE modder guide,
     *  `ZFECodeObj` must be probed AS A PROPERTY on each scope too — it is the
     *  modern-API-backed fallback ZFE exposes "when the active UI root rejects __ZFE"
     *  (api-reference.md), which is exactly the standalone patched-HUDMenu case. */
    static function probeObj(o:Dynamic):Dynamic {
        if (o == null) return null;
        try { var z:Dynamic = untyped o["__ZFE"];      if (z != null) return z; } catch (e:Dynamic) {}
        try { var z:Dynamic = untyped o["ZFECodeObj"]; if (z != null) return z; } catch (e:Dynamic) {}
        return null;
    }

    /** On-screen diagnostic: one char per probe scope (Y = bridge object present). */
    public static function diagZfe(scope:Dynamic):String {
        var s = "";
        s += "self:"   + (probeObj(scope) != null ? "Y" : "-");
        try { s += " par:"  + (probeObj(scope.parent) != null ? "Y" : "-"); } catch (e:Dynamic) { s += " par:x"; }
        try { s += " root:" + (probeObj(scope.root)   != null ? "Y" : "-"); } catch (e:Dynamic) { s += " root:x"; }
        try { var g:Dynamic = untyped __global__["ZFECodeObj"]; s += " gZ:" + (g != null ? "Y" : "-"); } catch (e:Dynamic) { s += " gZ:x"; }
        try { var g2:Dynamic = untyped __global__["__SFCodeObj"]; s += " gS:" + (g2 != null ? "Y" : "-"); } catch (e:Dynamic) { s += " gS:x"; }
        try {
            var st:Dynamic = scope.stage;
            var hits:Int = 0;
            if (st != null) for (i in 0...(st.numChildren : Int)) {
                try { if (probeObj(st.getChildAt(i)) != null) hits++; } catch (e:Dynamic) {}
            }
            s += " stg:" + hits;
        } catch (e:Dynamic) { s += " stg:x"; }
        return s;
    }

    static function findZfeApi(scope:Dynamic):Dynamic {
        var z:Dynamic = probeObj(scope);
        if (z != null) return z;
        try { z = probeObj(scope.parent); if (z != null) return z; } catch (e:Dynamic) {}
        try { z = probeObj(scope.root);   if (z != null) return z; } catch (e:Dynamic) {}
        try {
            var g:Dynamic = untyped __global__["ZFECodeObj"];
            if (g != null) return g;
        } catch (e:Dynamic) {}
        try {
            var g2:Dynamic = untyped __global__["__SFCodeObj"];
            if (g2 != null) return g2;
        } catch (e:Dynamic) {}
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        var z:Dynamic = probeObj(child);
                        if (z != null) return z;
                        var m:Int = child.numChildren;
                        for (j in 0...m) {
                            try {
                                var gc:Dynamic = child.getChildAt(j);
                                var z2:Dynamic = probeObj(gc);
                                if (z2 != null) return z2;
                            } catch (e2:Dynamic) {}
                        }
                    } catch (e2:Dynamic) {}
                }
            }
        } catch (e:Dynamic) {}
        return null;
    }
}
