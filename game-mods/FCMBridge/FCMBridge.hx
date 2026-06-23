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
 * Primary path (M3+): ZFE Text Chat socket bridge (FCMHUD/1 protocol).
 * Fallback path: readRemoteData polling of GET /api/game/hud-feed (ZFE-cached 300 s).
 *
 * The socket wrapper rides the legacy __SFCodeObj (BRG_OBJ) instance found by
 * walking the parent chain from the widget. Probe findings (2026-06-10):
 *   - Legacy bridge discriminator: call("__zfe_probe") returns plain false.
 *     Modern-API decoys (ZFECodeObj / some __SFCodeObj instances) return a string
 *     containing "unsupported_command" — treat those as NOT-legacy.
 *   - Register: call("register", {connected:false, bytesAvailable:0}) — anonymous
 *     object ONLY (sealed class → ReferenceError #1056 on dynamic field write-back).
 *   - Connect: call("connect") — no args; native uses ZFE_TEXT_CHAT_ENDPOINT.
 *   - Drain: 100 ms Timer; poll _sock.connected / _sock.bytesAvailable (native writes
 *     them back within one tick); readUTFBytes() (no arg) drains ALL available as a
 *     string. NEVER use readByte() — it consumes one byte as an Int.
 *   - Reconnect: call("connect") again; native handles "after previous failure".
 *   - Transport is TLS (Schannel), always — even for host:port endpoints.
 *
 * Wire format: plain UTF-8 \n-terminated lines (FCMHUD/1).
 *   Record lines: color~channel~user~content (4+ tilde-fields, fed to renderRecords).
 *   Control lines: HELLO~1~<n> / PING~<ts> (fewer than 4 fields, skipped silently).
 *
 * Full bridge recipe, env vars, SWF crash hard-rules:
 *   docs/overlay/zfe/realtime-socket.md
 *   docs/overlay/zfe/fcmbridge-data-pattern.md
 *
 * Design tokens from ChatOverlay.tsx, theme fo76-wasteland:
 *   update BOTH when the theme changes.
 *
 * SWF CRASH HARD RULES (violations crashed the game in production):
 *   1. NO GlowFilter or any filters array — crashes Scaleform on FO76.
 *   2. NO HTML entities (&amp; etc.) in htmlText — crashes Scaleform on FO76.
 *   3. Live content is zfeSafe()d server-side; renderRecords() is reused unmodified.
 *   4. Debug panels: use tf.text (plain text), NOT htmlText.
 */
class FCMBridge extends MovieClip {

    static inline var VENDOR:String = "FCMBridge";
    static inline var KEY:String    = "hud-feed";
    static inline var POLL_MS:Int   = 5000;  // poll every 5 s; ZFE caches 300 s locally
    static inline var RETRY_MS:Int  = 2000;  // retry on cold-cache state
    static inline var PANEL_W:Int   = 360;
    static inline var PANEL_H:Int   = 248;
    static inline var TAB_H:Int     = 23;    // main tab row (overlay: 23px)
    static inline var SUB_H:Int     = 22;    // sub-channel tab row (overlay: 22px)
    static inline var HDR_H:Int     = 45;    // total chrome = TAB_H + SUB_H
    static inline var INPUT_H:Int   = 22;    // faux input bar at the bottom (slightly shorter)
    static inline var FONT_SIZE:Int = 14;    // ChatOverlay default fontSize
    static inline var MAX_MSGS:Int  = 8;

    // ── Socket wrapper constants ───────────────────────────────────────────────
    static inline var DRAIN_MS:Int          = 100;   // drain timer interval
    static inline var WATCHDOG_MS:Int       = 45000; // 45 s without a line = dead (PINGs every 10s)
    static inline var RECONNECT_INIT_MS:Int = 2000;  // initial reconnect backoff
    // connect() is a cheap LOCAL ZFE call, so we keep the max backoff short — the
    // feed auto-recovers within ~8 s of the backend coming back (e.g. after a WSL
    // restart / network blip) instead of waiting out a long 60 s window.
    static inline var RECONNECT_MAX_MS:Int  = 8000;  // max reconnect backoff
    // Pre-live stale-connection nudge: ZFE's native `connected` flag can stay
    // stale-true after the transport dies (observed after a mid-session HUD
    // reload). If we are "connected" but have NEVER received a line on this
    // instance, force a close+connect after this many ms.
    static inline var STALE_NUDGE_MS:Int    = 15000;
    static inline var BUF_CAP:Int           = 8192;  // line buffer cap (bytes)

    // ── Design tokens from ChatOverlay.tsx, theme fo76-wasteland ──────────────
    static inline var BG_COLOR:Int     = 0x0A0907;
    static inline var CHROME_COLOR:Int = 0x0C0A08;
    static inline var PRIMARY:Int      = 0xF5CB5B;
    static inline var PRIMARY_HEX:String = "#F5CB5B";
    static inline var TEXT_HEX:String    = "#FAF4DA";
    static inline var INACTIVE_HEX:String = "#B49544";
    // Active main tab bracket: left/right x edges. Text "FALLOUT 76" sits at x=8;
    // left edge at 3 gives ~5px left padding, right edge at 110 sits between the
    // "FALLOUT 76" and "PARTY" labels.
    static inline var ACTIVE_TAB_L:Int    = 3;
    static inline var ACTIVE_TAB_R:Int    = 98;    // ends after "FALLOUT 76", before "PARTY"
    static inline var DIM_HEX:String      = "#AC9043";

    // ── Core display / polling state ──────────────────────────────────────────
    var _api:Dynamic         = null;
    var _bg:Shape;
    var _tf:TextField;
    var _subTf:TextField;    // sub-tab row — kept for active-channel re-render
    var _fmt:TextFormat;
    var _pollTimer:Timer;
    var _retryTimer:Timer;
    var _activeChannel:String = "General"; // mirrors __fcmActiveChannel on the bridge

    // Shared records ring — both poll() and socket drain write here.
    // poll() writes only when !_liveActive; socket drain always wins.
    var _records:Array<String> = [];

    // ── Socket wrapper state ───────────────────────────────────────────────────
    var _legacy:Dynamic      = null;  // the legacy __SFCodeObj bridge object
    var _sock:Dynamic        = null;  // anonymous {connected, bytesAvailable}
    var _lineBuf:String      = "";    // partial line accumulator
    var _liveActive:Bool     = false; // true once first complete socket line arrived
    var _lastLineAt:Float    = 0;     // flash.Lib.getTimer() ms of last line
    var _reconnectDelay:Int  = RECONNECT_INIT_MS;
    var _drainTimer:Timer    = null;
    var _reconnectTimer:Timer = null;
    var _connectAttempts:Int = 0;     // for log only
    var _connectIssuedAt:Float = 0;   // getTimer() ms of last connect() call (stale-nudge timer)
    var _bufResetLogged:Bool = false; // log buffer-reset once per session
    // Pre-register legacy-bridge discovery retry — when this SWF is self-loaded by
    // HUDMenuChat it is not on the stage yet, so a single synchronous lookup misses
    // the bridge; retry until found.
    var _bootTimer:Timer     = null;
    var _bootTries:Int       = 0;
    var _dbgN:Int            = 0;     // one-shot render-path diagnostics
    static inline var SOCKET_BOOT_MS:Int  = 1500; // discovery retry interval
    static inline var SOCKET_BOOT_MAX:Int = 40;   // give up after ~60s (poll-only)

    // ── Auto-hide (old TextChat chatBoxVisibilityTimeout behavior) ────────────
    // The whole panel fades out after AUTOHIDE_MS of no activity and fades back
    // in on any activity: a received record line, an ACTIVECHAN switch, or the
    // patched HUDMenu poking fcmWake() when the player opens the chat input.
    static inline var AUTOHIDE_MS:Int   = 25000;  // idle time before fade starts
    static inline var FADE_TICK_MS:Int  = 50;     // fade timer resolution
    static inline var FADE_STEP:Float   = 0.04;   // alpha per tick (~1.25s full fade)
    var _lastActivityAt:Float = 0;
    var _hideTimer:Timer      = null;

    /** Reset the idle clock and restore full visibility. Called internally on
        feed activity and EXTERNALLY by the patched HUDMenu when chat opens. */
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
        // Auto-hide: start the idle clock + fade timer.
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
    // Panel chrome — unchanged from the pre-M3 build
    // =========================================================================

    function buildPanel():Void {
        _bg = new Shape();
        // Panel background — reduced alpha (0.72) for a more transparent look
        _bg.graphics.beginFill(BG_COLOR, 0.72);
        _bg.graphics.lineStyle(1, PRIMARY, 0.25);
        _bg.graphics.drawRect(0, 0, PANEL_W, PANEL_H);
        _bg.graphics.endFill();
        _bg.graphics.lineStyle();
        _bg.graphics.beginFill(CHROME_COLOR, 0.92);
        _bg.graphics.drawRect(1, 1, PANEL_W - 2, HDR_H - 1);
        _bg.graphics.endFill();
        // Divider between chrome and feed area
        _bg.graphics.lineStyle(1, PRIMARY, 0.45);
        _bg.graphics.moveTo(0, HDR_H);
        _bg.graphics.lineTo(PANEL_W, HDR_H);
        _bg.graphics.lineStyle(1, PRIMARY, 0.25);
        _bg.graphics.moveTo(0, PANEL_H - INPUT_H);
        _bg.graphics.lineTo(PANEL_W, PANEL_H - INPUT_H);
        addChild(_bg);

        // Main tab: "FALLOUT 76" in its own field so we can MEASURE its width and
        // place the active-tab bracket + the PARTY tab exactly (no pixel guessing).
        var falloutTf = new TextField();
        falloutTf.x = 8; falloutTf.y = 4;
        falloutTf.width = 200; falloutTf.height = TAB_H;
        styleChrome(falloutTf);
        falloutTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + PRIMARY_HEX + '"><b>FALLOUT 76</b></font>';
        addChild(falloutTf);

        // Right edge of the active tab = measured text end + a little padding.
        var tw:Float = falloutTf.textWidth;
        if (tw < 40) tw = 86;   // fallback if the font hasn't reported a width yet
        var tabRight:Int = Std.int(8 + tw) + 7;
        // Divider between main-tab and sub-tab rows — full width EXCEPT under the tab
        // (the "cutout"); no line directly under "FALLOUT 76".
        _bg.graphics.lineStyle(1, PRIMARY, 0.6);
        _bg.graphics.moveTo(0, TAB_H);
        _bg.graphics.lineTo(ACTIVE_TAB_L, TAB_H);
        _bg.graphics.moveTo(tabRight, TAB_H);
        _bg.graphics.lineTo(PANEL_W, TAB_H);
        // 3-sided bracket (top + left + right, open bottom) hugging "FALLOUT 76".
        _bg.graphics.lineStyle(1, PRIMARY, 0.6);
        _bg.graphics.moveTo(ACTIVE_TAB_L, TAB_H);
        _bg.graphics.lineTo(ACTIVE_TAB_L, 2);
        _bg.graphics.lineTo(tabRight, 2);
        _bg.graphics.lineTo(tabRight, TAB_H);

        // PARTY tab — just right of the bracket (measured), dim/inactive.
        var partyTf = new TextField();
        partyTf.x = tabRight + 10; partyTf.y = 4;
        partyTf.width = 80; partyTf.height = TAB_H;
        styleChrome(partyTf);
        partyTf.htmlText = '<font face="$$MAIN_Font" size="14" color="' + INACTIVE_HEX + '"><b>PARTY</b></font>';
        addChild(partyTf);

        // Sub-tab row — x=8 to match main tab left edge (fix 3); stored for re-render (fix 5)
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
        // Small bottom margin (6px) — the feed extends close to the input bar so there's
        // no dead space; auto-scroll-to-bottom keeps the newest line visible just above it.
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

        // inp is the visible input bar — border/background owner (patch's real field
        // overlays this and is set borderless so exactly one box shows, filling PANEL_W).
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
        // No visible default text (user request). The "Chat via" string is KEPT but
        // rendered in the bar's own background colour (#0C0A08) so it is invisible —
        // the HUDMenu patch still locates this bar via fcmFindByText(stage,"Chat via")
        // for input-field alignment, but the user sees an empty box.
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
     * Render sub-tab row with the active channel highlighted in PRIMARY_HEX (gold)
     * and inactive channels in INACTIVE_HEX. Called from buildPanel and when
     * ACTIVECHAN control line is received.
     * Sub-tabs: GENERAL TRADING EVENTS INFESTS RAIDS (matches the dashboard overlay).
     */
    function renderSubTabs():Void {
        if (_subTf == null) return;
        var channels:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS"];
        var html:Array<String> = [];
        for (ch in channels) {
            var color = (ch.toLowerCase() == _activeChannel.toLowerCase()) ? PRIMARY_HEX : INACTIVE_HEX;
            html.push('<font face="$$MAIN_Font" size="13" color="' + color + '"><b>' + ch + '</b></font>');
        }
        _subTf.htmlText = html.join('<font face="$$MAIN_Font" size="13" color="' + INACTIVE_HEX + '">  </font>');
    }

    // =========================================================================
    // Init — existing ZFE API setup + socket bridge discovery
    // =========================================================================

    function init():Void {
        _api = findZfeApi(this);
        if (_api == null) {
            setText("ZFE not found\nInstall dxgi.dll + zfe.ini");
            return;
        }
        zfeLog("info", "startup", "FCMBridge loaded");
        zfeLog("info", "startup", "BUILD=selfloadfix1");

        // Diagnostic: getRuntimeInfo (unchanged from pre-M3)
        try {
            var info:Dynamic = _api.call("getRuntimeInfo", "{}");
            var raw:String = Std.string(info);
            var safe:String = raw.split("{").join("(").split("}").join(")").split('"').join("'");
            var chunkSize:Int = 400;
            var idx:Int = 0;
            var pos:Int = 0;
            while (pos < safe.length) {
                var chunk:String = safe.substr(pos, chunkSize);
                zfeLog("info", "startup", "rt" + idx + "=" + chunk);
                idx++;
                pos += chunkSize;
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "startup", "getRuntimeInfo threw: " + Std.string(e));
        }

        // Start polling (fallback / cold-start path). Guarded: when self-loaded by
        // HUDMenuChat the display context can make poll() throw — that must NOT kill
        // the socket bootstrap below (the previous code lost the socket this way).
        try { poll(); } catch (e:Dynamic) { zfeLog("warn", "startup", "initial poll threw: " + Std.string(e)); }
        try {
            _pollTimer = new Timer(POLL_MS);
            _pollTimer.addEventListener(TimerEvent.TIMER, function(_) { try { poll(); } catch (e2:Dynamic) {} });
            _pollTimer.start();
        } catch (e:Dynamic) { zfeLog("warn", "startup", "poll timer setup threw: " + Std.string(e)); }

        // Discover the legacy socket bridge with retry (handles the self-load race).
        startSocketBoot();
    }

    // =========================================================================
    // Socket init — parent-chain walk + stage children to find legacy __SFCodeObj
    // =========================================================================

    function startSocketBoot():Void {
        if (_legacy != null || _bootTimer != null) return;
        zfeLog("info", "socket", "bootStart");
        _bootTries = 0;
        try {
            _bootTimer = new Timer(SOCKET_BOOT_MS, 0);
            _bootTimer.addEventListener(TimerEvent.TIMER, function(_) { tryBootSocket(); });
            _bootTimer.start();
        } catch (e:Dynamic) {}
        tryBootSocket(); // immediate attempt (direct-load fast path)
    }

    function tryBootSocket():Void {
        if (_legacy != null) {
            if (_bootTimer != null) { _bootTimer.stop(); _bootTimer = null; }
            return;
        }
        _bootTries++;
        var bridge:Dynamic = null;
        try { bridge = findLegacyBridge(this); } catch (e:Dynamic) { bridge = null; }
        if (_bootTries <= 3 || bridge != null) {
            zfeLog("info", "socket", "bootTry n=" + _bootTries + " found=" + Std.string(bridge != null));
        }
        if (bridge == null) {
            if (_bootTries >= SOCKET_BOOT_MAX) {
                if (_bootTimer != null) { _bootTimer.stop(); _bootTimer = null; }
                zfeLog("warn", "socket", "legacyMissing after " + _bootTries + " tries; staying on poll");
            }
            return; // retry on next tick
        }
        if (_bootTimer != null) { _bootTimer.stop(); _bootTimer = null; }
        _legacy = bridge;
        zfeLog("info", "socket", "legacyFound: bridge located (try " + _bootTries + ")");

        // Register once: anonymous object — native writes connected/bytesAvailable back onto it.
        // NEVER use a class instance here (sealed class → ReferenceError #1056).
        _sock = {connected: false, bytesAvailable: 0};
        try {
            var ret:Dynamic = Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["register", _sock]);
            zfeLog("info", "socket", "registered: ret=" + Std.string(ret));
        } catch (e:Dynamic) {
            zfeLog("warn", "socket", "register threw: " + Std.string(e));
            _legacy = null;
            startSocketBoot(); // restart the retry loop
            return;
        }

        // First connect attempt
        socketConnect();

        // Start 100 ms drain timer
        _drainTimer = new Timer(DRAIN_MS);
        _drainTimer.addEventListener(TimerEvent.TIMER, onDrainTick);
        _drainTimer.start();
    }

    /**
     * Find the LEGACY __SFCodeObj by walking the parent chain from scope,
     * then scanning stage children. Discriminator: call("__zfe_probe") returns
     * plain false on the legacy bridge. Modern-API decoys return a string
     * containing "unsupported_command" — skip those.
     */
    function findLegacyBridge(scope:Dynamic):Dynamic {
        // Direct paths that work even when self-loaded and not yet on the stage —
        // mirror findZfeApi (scope.root and the global __SFCodeObj both reach ROOT_A,
        // where the legacy bridge lives). isLegacyBridge() filters modern-API decoys.
        var seeds:Array<Dynamic> = [];
        try { seeds.push(scope); } catch (e:Dynamic) {}
        try { seeds.push(scope.parent); } catch (e:Dynamic) {}
        try { seeds.push(scope.root); } catch (e:Dynamic) {}
        try { seeds.push(untyped __global__["__SFCodeObj"]); } catch (e:Dynamic) {}
        for (s in seeds) {
            if (s == null) continue;
            try { if (isLegacyBridge(s)) return s; } catch (e:Dynamic) {}
            var c:Dynamic = getSFCodeObj(s);
            if (c != null && isLegacyBridge(c)) return c;
        }

        // Walk parent chain (probe found legacy at depth 3; also on stage children)
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

        // Stage children + grandchildren
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        var candidate:Dynamic = getSFCodeObj(child);
                        if (candidate != null && isLegacyBridge(candidate)) return candidate;
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
        try {
            var v:Dynamic = untyped node["__SFCodeObj"];
            if (v != null) return v;
        } catch (e:Dynamic) {}
        return null;
    }

    /**
     * Discriminator: the legacy bridge returns plain false (Bool) from
     * call("__zfe_probe"). Modern-API decoys return a string containing
     * "unsupported_command". Also checks that a call() function is present.
     */
    static function isLegacyBridge(obj:Dynamic):Bool {
        var callFn:Dynamic = null;
        try { callFn = Reflect.field(obj, "call"); } catch (e:Dynamic) {}
        if (callFn == null || (untyped __typeof__(callFn)) != "function") return false;
        try {
            var ret:Dynamic = Reflect.callMethod(obj, callFn, ["__zfe_probe"]);
            if (ret == null) return false;
            // A Bool false means legacy; a string (any string) means modern decoy.
            if ((untyped __typeof__(ret)) == "boolean") return ret == false;
            // If it's a string, check for "unsupported_command"
            var rs:String = Std.string(ret);
            if (rs.indexOf("unsupported_command") >= 0) return false;
            // Treat other non-string returns as legacy (shouldn't happen but be safe)
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
        zfeLog("info", "socket", "connectAttempt n=" + _connectAttempts + " delay=" + _reconnectDelay);
        try {
            Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["connect"]);
        } catch (e:Dynamic) {
            zfeLog("warn", "socket", "connect threw: " + Std.string(e));
        }
    }

    function scheduleReconnect():Void {
        if (_reconnectTimer != null) return; // already scheduled
        _reconnectTimer = new Timer(_reconnectDelay, 1);
        _reconnectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _reconnectTimer = null;
            socketConnect();
            // Double the backoff window; next failure detection happens at next drain cycle
            _reconnectDelay = Std.int(Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS));
        });
        _reconnectTimer.start();
    }

    // =========================================================================
    // Drain timer (100 ms) — heart of the socket path
    // =========================================================================

    function onDrainTick(e:TimerEvent):Void {
        if (_legacy == null || _sock == null) return;

        var connected:Bool = false;
        try { connected = (_sock.connected == true); } catch (e2:Dynamic) {}

        if (!connected) {
            // Not connected — schedule reconnect if not liveActive (no point reconnecting
            // if we just transitioned to dead; watchdog will resume poll + schedule reconnect)
            if (!_liveActive) {
                scheduleReconnect();
            }
            return;
        }

        // Connected — reset backoff on success
        _reconnectDelay = RECONNECT_INIT_MS;

        var avail:Int = 0;
        try { avail = Std.int(_sock.bytesAvailable); } catch (e2:Dynamic) {}

        if (avail <= 0) {
            // Watchdog: if liveActive and too long since last line, declare dead.
            // (PINGs arrive every 10 s from the backend, so 180 s = 18 missed.)
            if (_liveActive && (flash.Lib.getTimer() - _lastLineAt) > WATCHDOG_MS) {
                zfeLog("warn", "socket", "watchdogDead: no line for 180s; resuming poll + scheduling reconnect");
                _liveActive = false;
                resumePoll();
                scheduleReconnect();
            }
            // Pre-live stale-connection nudge: native `connected` can be
            // stale-true after the transport died (HUD reload mid-session).
            // If this instance has NEVER seen a line and 30 s passed since
            // its last connect(), force close + connect to rebuild the
            // transport. close may be unsupported -- log and proceed.
            if (!_liveActive && _lastLineAt == 0 && _connectIssuedAt > 0
                && (flash.Lib.getTimer() - _connectIssuedAt) > STALE_NUDGE_MS) {
                var closeRet:Dynamic = null;
                try {
                    closeRet = Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["close"]);
                } catch (e3:Dynamic) {}
                zfeLog("warn", "socket", "staleConnection: nudging close=" + Std.string(closeRet) + " then connect");
                socketConnect(); // resets _connectIssuedAt -> next nudge in 30s
            }
            return;
        }

        // Bytes available — drain the whole buffer as a string
        var chunk:String = "";
        try {
            var ret:Dynamic = Reflect.callMethod(_legacy, Reflect.field(_legacy, "call"), ["readUTFBytes"]);
            if (ret != null) chunk = Std.string(ret);
        } catch (e2:Dynamic) {
            zfeLog("warn", "socket", "readUTFBytes threw: " + Std.string(e2));
            return;
        }

        if (chunk.length == 0) return;
        if (chunk.length > 40 && _dbgN < 6) zfeLog("info", "socket", "DRAIN chunk=" + chunk.length + " nl=" + (chunk.split("\n").length - 1));

        // Append to line buffer; cap at BUF_CAP
        _lineBuf += chunk;
        if (_lineBuf.length > BUF_CAP) {
            if (!_bufResetLogged) {
                zfeLog("warn", "socket", "bufferReset: lineBuf exceeded " + BUF_CAP + " bytes; resetting");
                _bufResetLogged = true;
            }
            // Keep only the tail (likely a partial line — discard it to re-sync)
            _lineBuf = "";
            return;
        }

        // Split on \n; last element is a partial fragment (keep it)
        var parts:Array<String> = _lineBuf.split("\n");
        _lineBuf = parts.pop(); // last element (may be "")

        for (line in parts) {
            if (line.length == 0) continue;

            // Update last-line timestamp for every complete line (including control lines)
            _lastLineAt = flash.Lib.getTimer();

            // Control lines have fewer than 4 tilde-fields.
            // ACTIVECHAN~<name>: backend signals "active channel is now <name>;
            // clear the feed; records that follow belong to this channel."
            if (line.split("~").length < 4) {
                // First control line also triggers liveActive
                if (!_liveActive) {
                    _liveActive = true;
                    zfeLog("info", "socket", "firstLine (control): liveActive=true; stopping poll");
                    stopPoll();
                }
                // Handle ACTIVECHAN~<channelName>
                if (line.length > 10 && line.substr(0, 10) == "ACTIVECHAN") {
                    var tildePos:Int = line.indexOf("~");
                    if (tildePos >= 0) {
                        var chanName:String = line.substr(tildePos + 1);
                        if (chanName.length > 0) {
                            _records = [];
                            _activeChannel = chanName;
                            renderSubTabs();
                            fcmWake();   // channel switch = activity; un-hide
                            zfeLog("info", "socket", "ACTIVECHAN=" + chanName + "; feed cleared");
                        }
                    }
                }
                continue;
            }

            // Record line — push into shared ring
            if (!_liveActive) {
                _liveActive = true;
                zfeLog("info", "socket", "firstLine (record): liveActive=true; stopping poll");
                stopPoll();
            }

            if (_dbgN < 6) zfeLog("info", "socket", "RECBRANCH f=" + line.split("~").length + " h=" + line.substr(0, 26));
            _records.push(line);
            while (_records.length > MAX_MSGS) _records.shift();
            renderRecords(_records);
            fcmWake();   // new message = activity; un-hide the panel
        }
    }

    // =========================================================================
    // Poll (readRemoteData fallback) — unchanged logic; writes to _records only
    // when !_liveActive so live lines always win.
    // =========================================================================

    function poll():Void {
        if (_api == null) return;
        if (_liveActive) return; // live socket has taken over; discard poll result

        var raw:Dynamic = null;
        try {
            raw = _api.call("readRemoteData",
                '{"vendor":"' + VENDOR + '","key":"' + KEY + '"}');
        } catch (e:Dynamic) {
            zfeLog("error", "poll", "call threw: " + Std.string(e));
            return;
        }
        if (raw == null) { zfeLog("warn", "poll", "raw=null"); return; }

        var s:String = Std.string(raw);
        if (s.indexOf('success:true') < 0 && s.indexOf('"success":true') < 0) {
            var safe = s.split("{").join("(").split("}").join(")").split('"').join("'");
            zfeLog("warn", "poll", "zfe=" + safe);
            return;
        }

        var found:Bool        = s.indexOf('found:true') >= 0 || s.indexOf('"found":true') >= 0;
        var refreshQueued:Bool = s.indexOf('refreshQueued:true') >= 0 || s.indexOf('"refreshQueued":true') >= 0;

        if (!found) {
            if (refreshQueued) scheduleRetry();
            return;
        }

        var textVal:String = null;
        for (key in ['"text":"', 'text:"']) {
            var idx = s.indexOf(key);
            if (idx >= 0) {
                var start = idx + key.length;
                var i = start;
                while (i < s.length) {
                    var c = s.charAt(i);
                    if (c == '\\') { i += 2; continue; }
                    if (c == '"') break;
                    i++;
                }
                if (i > start) textVal = s.substring(start, i);
                break;
            }
        }
        if (textVal == null || textVal.length == 0) {
            if (!_liveActive) setText("no messages yet");
            return;
        }

        var inner:String = StringTools.replace(textVal, '\\"', '"');
        inner = StringTools.replace(inner, '\\\\', '\\');

        var lines:String = null;
        var tIdx = inner.indexOf('"t":"');
        if (tIdx >= 0) {
            var tStart = tIdx + 5;
            var tEnd = inner.indexOf('"', tStart);
            if (tEnd > tStart) lines = inner.substring(tStart, tEnd);
        }
        if (lines == null || lines.length == 0) {
            if (!_liveActive) setText("no messages yet");
            return;
        }

        // Only apply poll results when socket has NOT taken over
        if (_liveActive) return;

        var pollRecords:Array<String> = lines.split("|");
        var start = Std.int(Math.max(0, pollRecords.length - MAX_MSGS));
        var slice = pollRecords.slice(start);
        _records = slice;
        renderRecords(_records);

        // Signal-recovery: a successful poll means the backend is reachable again.
        // Collapse the socket reconnect backoff so the live socket re-establishes on
        // the very next attempt instead of waiting out the (now ≤8 s) timer — and
        // cancel any long pending reconnect so it fires now.
        _reconnectDelay = RECONNECT_INIT_MS;
        if (_reconnectTimer != null) {
            _reconnectTimer.stop();
            _reconnectTimer = null;
            scheduleReconnect();
        }
    }

    function scheduleRetry():Void {
        if (_retryTimer != null) { _retryTimer.stop(); _retryTimer = null; }
        _retryTimer = new Timer(RETRY_MS, 1);
        _retryTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _retryTimer = null;
            poll();
        });
        _retryTimer.start();
    }

    // =========================================================================
    // Poll timer management
    // =========================================================================

    function stopPoll():Void {
        if (_pollTimer != null) {
            _pollTimer.stop();
            // Don't null it — resumePoll() will restart it
        }
    }

    function resumePoll():Void {
        if (_pollTimer != null) {
            _pollTimer.start();
        } else {
            _pollTimer = new Timer(POLL_MS);
            _pollTimer.addEventListener(TimerEvent.TIMER, function(_) { poll(); });
            _pollTimer.start();
        }
        // Kick an immediate poll so the display doesn't go stale during reconnect
        poll();
    }

    // =========================================================================
    // Render — unchanged; driven by both poll and socket paths via _records ring
    // =========================================================================

    /**
     * Render color~channel~user~content records as one styled line each.
     * NO client-side channel filter — the backend now sends only the active
     * channel's records (driven by ACTIVECHAN control lines). Render all records.
     * Fields are pre-sanitized by the backend (no <,>,&,",~,| survive), so
     * direct interpolation into htmlText is safe.
     */
    function renderRecords(records:Array<String>):Void {
        if (_dbgN < 6) { _dbgN++; zfeLog("info", "socket", "RENDER n=" + records.length + " tfnull=" + Std.string(_tf == null) + " r0=" + (records.length > 0 ? Std.string(records[0].split("~").length) + ":" + records[0].substr(0, 24) : "none")); }
        if (_tf == null) return;
        // FO76's Scaleform/GFx runtime does NOT provide flash.text.TextFormat —
        // referencing it (new TextFormat()/setTextFormat) fails method verification
        // with Error #1014 ("class could not be found"), so this whole method threw
        // before drawing anything and the panel stayed on "connecting". Render through
        // the SAME single-<font> htmlText path setText() uses (proven to display).
        // Content is zfeSafe()d server-side (no raw < > & ~), so it is htmlText-safe.
        // Per-channel colors are a follow-up; correct *display* comes first.
        var lines:Array<String> = [];
        for (rec in records) {
            var f = rec.split("~");
            if (f.length < 4) continue;
            lines.push("[" + f[1] + "] " + f[2] + ": " + f.slice(3).join("~"));
        }
        if (lines.length == 0) { setText("no messages yet"); return; }
        setText(lines.join("\n"));
        // Auto-scroll to the newest line so the most recent message is always visible.
        try { _tf.scrollV = _tf.maxScrollV; } catch (e:Dynamic) {}
    }

    function setText(s:String):Void {
        if (_tf == null) return;
        _tf.htmlText = '<font face="$$MAIN_Font" size="' + FONT_SIZE + '" color="' + TEXT_HEX + '">' + s + '</font>';
    }

    function zfeLog(level:String, category:String, message:String):Void {
        if (_api == null) return;
        try {
            _api.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level +
                '","category":"' + category + '","message":"' + message + '"}');
        } catch (e:Dynamic) {}
    }

    /**
     * Official ZFE findZfeApi lookup pattern.
     * Checks scope, parent, root, globals, then scans stage children.
     * ZFE installs __ZFE on ROOT_A (a direct child of stage).
     */
    static function findZfeApi(scope:Dynamic):Dynamic {
        try {
            var z:Dynamic = untyped scope["__ZFE"];
            if (z != null) return z;
        } catch (e:Dynamic) {}
        try {
            if (scope.parent != null) {
                var z:Dynamic = untyped scope.parent["__ZFE"];
                if (z != null) return z;
            }
        } catch (e:Dynamic) {}
        try {
            if (scope.root != null) {
                var z:Dynamic = untyped scope.root["__ZFE"];
                if (z != null) return z;
            }
        } catch (e:Dynamic) {}
        try {
            var z:Dynamic = untyped __global__["ZFECodeObj"];
            if (z != null) return z;
        } catch (e:Dynamic) {}
        try {
            var z:Dynamic = untyped __global__["__SFCodeObj"];
            if (z != null) return z;
        } catch (e:Dynamic) {}
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        var z:Dynamic = untyped child["__ZFE"];
                        if (z != null) return z;
                        var m:Int = child.numChildren;
                        for (j in 0...m) {
                            try {
                                var gc:Dynamic = child.getChildAt(j);
                                var z2:Dynamic = untyped gc["__ZFE"];
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
