import flash.display.MovieClip;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;

/**
 * SocketProbe v2 -- M0 diagnostic SWF (round 2).
 *
 * RUN 1 FINDINGS: no bridge object exposes direct socket methods -- ONLY
 * `call` is a function on __ZFE / __SFCodeObj / ZFECodeObj. __ZFE's modern
 * API has no socket commands (unsupported_command). The BRG_OBJ instance we
 * found returned a synthesized true for call("register", sock) WITHOUT the
 * native dispatcher log line -- likely the wrong per-UI-root instance.
 *
 * V2 STRATEGY:
 *  - Oracle call: obj.call("__zfe_probe") -- the native line
 *    "Text Chat bridge socket call __zfe_probe" in zfe.log proves the socket
 *    dispatcher is live on that object. Called before/after every trial.
 *  - Enumerate EVERY distinct __SFCodeObj / ZFECodeObj instance (the Text
 *    Chat bridge installs one per UI root: HUDMenu, ROOT_A, root, ROOT_B);
 *    run the full trial sequence on each.
 *  - All trials via .call(): register (sock / this / sock+vendor),
 *    connect ( () / (h,4001) / (h,"4001") / ("h:p") ), read/write.
 *
 * All findings logged via ZFE log API (vendor=FCMBridge, category=socketprobe,
 * sanitized { -> ( , } -> ) , " -> ' ) AND a plain-text on-screen TextField
 * (system font, embedFonts=false; NO htmlText, NO filters, NO HTML entities).
 *
 * Build from game-mods/FCMBridge/:
 *   /mnt/c/Users/White/scoop/shims/haxe.exe --main SocketProbe --swf SocketProbe.swf --swf-version 32
 *   python3 -c "
 *   with open('SocketProbe.swf','r+b') as f:
 *       d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
 *   "
 *   cp SocketProbe.swf "/mnt/d/SteamLibrary/steamapps/common/Fallout76/Data/interface/FCMBridge.swf"
 */
class SocketProbe extends MovieClip {

    static inline var VENDOR:String = "FCMBridge";
    static inline var CAT:String    = "socketprobe";

    static inline var PANEL_W:Int = 560;
    static inline var PANEL_H:Int = 400;

    static inline var STEP_MS:Int     = 4000;   // gap between queued steps
    static inline var DRAIN_TICKS:Int = 600;    // 600 * 100ms = 60s
    static inline var SUMMARY_MS:Int  = 85000;  // SUMMARY at t+85s
    static inline var HIDE_MS:Int     = 90000;  // panel hides at t+90s

    var _api:Dynamic = null;                    // __ZFE -- logging only
    var _tf:TextField;
    var _lines:Array<String> = [];

    // Distinct socket-bridge candidate instances (deduped by reference)
    var _insts:Array<{label:String, obj:Dynamic}> = [];

    // Registered candidate objects watched by the drain loop
    var _sock:Dynamic;          // plain {} candidate
    // `this` is the second candidate (pre-seeded with the same 4 fields)

    var _regWins:Array<String>  = [];
    var _connWins:Array<String> = [];
    var _totalBytes:Int = 0;
    var _wroteOnConnect:Bool = false;

    // Step queue (one step per STEP_MS)
    var _steps:Array<Void->Void> = [];
    var _stepTimer:Timer;

    var _drainTimer:Timer;
    var _drainTick:Int = 0;
    var _lastSockConn:String  = "init";
    var _lastSockAvail:String = "init";
    var _lastSelfConn:String  = "init";
    var _lastSelfAvail:String = "init";

    // -------------------------------------------------------------------------

    static function main():Void {
        flash.Lib.current.addChild(new SocketProbe());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    function onStage(e:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onStage);
        buildPanel();
        append("SocketProbe v2 -- waiting 3s for ZFE...");
        var delay = new Timer(3000, 1);
        delay.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { init(); });
        delay.start();

        var sum = new Timer(SUMMARY_MS, 1);
        sum.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { logFinalSummary(); });
        sum.start();

        var hide = new Timer(HIDE_MS, 1);
        hide.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            if (_tf != null) _tf.visible = false;
        });
        hide.start();
    }

    // =========================================================================
    // Init: find __ZFE (logging), enumerate distinct socket-bridge instances
    // =========================================================================

    function init():Void {
        _api = findZfeApi(this);
        if (_api == null) {
            append("ERROR: ZFE not found (__ZFE). Cannot log -- aborting.");
            return;
        }
        zfeLog("info", "SocketProbe v2 start");

        // Pre-seed both registered-object candidates
        _sock = {};
        seedSockFields(_sock);
        seedSockFields(this);   // candidate b: a DisplayObject/class instance

        // Enumerate distinct __SFCodeObj / ZFECodeObj instances everywhere
        enumerateInstances();
        append("Distinct socket-bridge instances: " + _insts.length);
        zfeLog("info", "distinct instances=" + _insts.length);
        for (inst in _insts) {
            zfeLog("info", "inst " + inst.label);
            append("  " + inst.label);
        }
        if (_insts.length == 0) {
            zfeLog("warn", "no __SFCodeObj/ZFECodeObj instances found anywhere");
            append("No socket-bridge instances found!");
        }

        // Cap instances to keep total runtime bounded
        if (_insts.length > 4) {
            zfeLog("warn", "capping instances from " + _insts.length + " to 4");
            _insts = _insts.slice(0, 4);
        }

        // --- Immediate phase: per instance, oracle + register variants ---
        for (i in 0..._insts.length) {
            registerPhase("inst" + i, _insts[i]);
        }

        // --- Queued phase: connect variants, 4s apart, per instance ---
        for (k in 0..._insts.length) {
            var inst = _insts[k];
            var tag = "inst" + k;
            queueConnect(tag, inst, "connect()",         []);
            queueConnect(tag, inst, "connect(h,4001)",   ["127.0.0.1", 4001]);
            queueConnect(tag, inst, "connect(h,'4001')", ["127.0.0.1", "4001"]);
            queueConnect(tag, inst, "connect('h:p')",    ["127.0.0.1:4001"]);
        }
        // Final queued step: read/write trials on every instance regardless
        _steps.push(function() {
            for (k in 0..._insts.length) {
                readWritePhase("inst" + k, _insts[k]);
            }
        });

        startStepQueue();
        startDrainLoop();
    }

    function seedSockFields(o:Dynamic):Void {
        try {
            Reflect.setField(o, "connected", false);
            Reflect.setField(o, "bytesAvailable", 0);
            Reflect.setField(o, "socketBuffer", "");
            Reflect.setField(o, "prevBytesAvailable", 0);
        } catch (e:Dynamic) {}
    }

    /**
     * Collect every DISTINCT object found under __SFCodeObj / ZFECodeObj on:
     * this, parent chain up to the stage root, root, Lib.current, globals,
     * and all stage children + grandchildren. Dedupe by reference equality.
     */
    function enumerateInstances():Void {
        var names:Array<String> = ["__SFCodeObj", "ZFECodeObj"];

        // this + parent chain
        var node:Dynamic = this;
        var depth:Int = 0;
        while (node != null && depth < 12) {
            for (nm in names) addIfNew(getProp(node, nm), nm + "@chain" + depth);
            var next:Dynamic = null;
            try { next = node.parent; } catch (e:Dynamic) {}
            if (next == node) break;
            node = next;
            depth++;
        }

        // root
        try {
            if (this.root != null) {
                for (nm in names) addIfNew(getProp(this.root, nm), nm + "@root");
            }
        } catch (e:Dynamic) {}

        // Lib.current
        try {
            var cur:Dynamic = flash.Lib.current;
            if (cur != null) {
                for (nm in names) addIfNew(getProp(cur, nm), nm + "@Lib.current");
            }
        } catch (e:Dynamic) {}

        // __global__ aliases (string literals only -- variable indexing
        // does not compile on the flash target)
        try {
            var g1:Dynamic = untyped __global__["__SFCodeObj"];
            addIfNew(g1, "__SFCodeObj@global");
        } catch (e:Dynamic) {}
        try {
            var g2:Dynamic = untyped __global__["ZFECodeObj"];
            addIfNew(g2, "ZFECodeObj@global");
        } catch (e:Dynamic) {}

        // stage children + grandchildren
        try {
            var st:Dynamic = this.stage;
            if (st != null) {
                var n:Int = st.numChildren;
                for (i in 0...n) {
                    try {
                        var child:Dynamic = st.getChildAt(i);
                        for (nm in names) addIfNew(getProp(child, nm), nm + "@stageChild" + i);
                        var m:Int = 0;
                        try { m = child.numChildren; } catch (e3:Dynamic) {}
                        for (j in 0...m) {
                            try {
                                var gc:Dynamic = child.getChildAt(j);
                                for (nm in names) addIfNew(getProp(gc, nm), nm + "@stageChild" + i + "." + j);
                            } catch (e2:Dynamic) {}
                        }
                    } catch (e2:Dynamic) {}
                }
            }
        } catch (e:Dynamic) {}
    }

    static function getProp(o:Dynamic, name:String):Dynamic {
        try {
            var v:Dynamic = untyped o[name];
            return v;
        } catch (e:Dynamic) {}
        return null;
    }

    function addIfNew(obj:Dynamic, where:String):Void {
        if (obj == null) return;
        // Must expose a callable `call`
        var callFn:Dynamic = null;
        try { callFn = Reflect.field(obj, "call"); } catch (e:Dynamic) {}
        if (callFn == null || (untyped __typeof__(callFn)) != "function") return;
        for (inst in _insts) {
            if (inst.obj == obj) {
                // Already known -- record the extra location in its label
                inst.label += "," + where;
                return;
            }
        }
        _insts.push({label: where, obj: obj});
    }

    // =========================================================================
    // Oracle: obj.call("__zfe_probe") -- if zfe.log shows
    // "Text Chat bridge socket call __zfe_probe", the dispatcher is live here
    // =========================================================================

    function probeDispatcher(tag:String, obj:Dynamic, when:String):Void {
        try {
            var callFn:Dynamic = Reflect.field(obj, "call");
            if (callFn == null) { zfeLog("warn", tag + " oracle " + when + ": no call fn"); return; }
            var ret:Dynamic = Reflect.callMethod(obj, callFn, ["__zfe_probe"]);
            var rs:String = sanitize(Std.string(ret));
            zfeLog("info", tag + " oracle " + when + " ret=" + rs.substr(0, 120));
            append(tag + " oracle " + when + " => " + rs.substr(0, 80));
        } catch (e:Dynamic) {
            var es:String = sanitize(Std.string(e));
            zfeLog("warn", tag + " oracle " + when + " THREW:" + es.substr(0, 120));
            append(tag + " oracle " + when + " THREW: " + es.substr(0, 80));
        }
    }

    // =========================================================================
    // Register phase (per instance, synchronous): oracle, then 3 variants,
    // each followed by marker/write-back check + oracle
    // =========================================================================

    function registerPhase(tag:String, inst:{label:String, obj:Dynamic}):Void {
        append("=== " + tag + " REGISTER (" + inst.label.substr(0, 60) + ") ===");
        zfeLog("info", tag + " register phase obj=" + inst.label);

        probeDispatcher(tag, inst.obj, "pre-register");

        tryCallRegister(tag, inst.obj, "register(sock)",        ["register", _sock]);
        tryCallRegister(tag, inst.obj, "register(this)",        ["register", this]);
        tryCallRegister(tag, inst.obj, "register(sock,vendor)", ["register", _sock, "FCMBridge"]);
    }

    function tryCallRegister(tag:String, obj:Dynamic, form:String, args:Array<Dynamic>):Void {
        var threw:Bool = false;
        var retStr:String = "n/a";
        try {
            var callFn:Dynamic = Reflect.field(obj, "call");
            var ret:Dynamic = Reflect.callMethod(obj, callFn, args);
            retStr = sanitize(Std.string(ret));
        } catch (e:Dynamic) {
            threw = true;
            retStr = "ERR:" + sanitize(Std.string(e));
        }

        // Marker + write-back state on BOTH registered candidates
        var sockMarker:Bool = hasField(_sock, "__zfe_registered_socket");
        var selfMarker:Bool = hasField(this, "__zfe_registered_socket");
        var msg:String = tag + " REG " + form
            + " threw=" + threw
            + " ret=" + retStr.substr(0, 80)
            + " sockMarker=" + sockMarker
            + " selfMarker=" + selfMarker
            + " sockConn=" + fieldStr(_sock, "connected")
            + " sockAvail=" + fieldStr(_sock, "bytesAvailable")
            + " selfConn=" + fieldStr(this, "connected")
            + " selfAvail=" + fieldStr(this, "bytesAvailable");
        append(msg);
        zfeLog(threw ? "warn" : "info", msg);

        if (!threw && (sockMarker || selfMarker)) {
            _regWins.push(tag + ":" + form);
        }

        probeDispatcher(tag, obj, "post-" + form);
    }

    // =========================================================================
    // Connect phase: queued steps, 4s apart
    // =========================================================================

    function queueConnect(tag:String, inst:{label:String, obj:Dynamic}, form:String, extraArgs:Array<Dynamic>):Void {
        _steps.push(function() {
            append("=== " + tag + " CONNECT " + form + " ===");
            zfeLog("info", tag + " connect trial " + form);
            var threw:Bool = false;
            var retStr:String = "n/a";
            try {
                var callFn:Dynamic = Reflect.field(inst.obj, "call");
                var args:Array<Dynamic> = ["connect"];
                for (a in extraArgs) args.push(a);
                var ret:Dynamic = Reflect.callMethod(inst.obj, callFn, args);
                retStr = sanitize(Std.string(ret));
            } catch (e:Dynamic) {
                threw = true;
                retStr = "ERR:" + sanitize(Std.string(e));
            }
            var msg:String = tag + " CONN " + form
                + " threw=" + threw
                + " ret=" + retStr.substr(0, 80)
                + " sockConn=" + fieldStr(_sock, "connected")
                + " sockAvail=" + fieldStr(_sock, "bytesAvailable")
                + " selfConn=" + fieldStr(this, "connected")
                + " selfAvail=" + fieldStr(this, "bytesAvailable");
            append(msg);
            zfeLog(threw ? "warn" : "info", msg);
            if (!threw && retStr != "false" && retStr != "null" && retStr != "undefined") {
                _connWins.push(tag + ":" + form + "=" + retStr.substr(0, 30));
            }
            probeDispatcher(tag, inst.obj, "post-" + form);
        });
    }

    function startStepQueue():Void {
        if (_steps.length == 0) return;
        _stepTimer = new Timer(STEP_MS, _steps.length);
        _stepTimer.addEventListener(TimerEvent.TIMER, function(_) {
            var step = _steps.shift();
            if (step != null) {
                try { step(); } catch (e:Dynamic) {
                    zfeLog("warn", "step THREW:" + sanitize(Std.string(e)));
                }
            }
        });
        _stepTimer.start();
        zfeLog("info", "step queue started steps=" + _steps.length + " every " + STEP_MS + "ms");
    }

    // =========================================================================
    // Read/write phase via .call -- run on each instance at the end of the
    // queue, and once immediately when anything looks connected in the drain
    // =========================================================================

    function readWritePhase(tag:String, inst:{label:String, obj:Dynamic}):Void {
        append("=== " + tag + " READ/WRITE ===");
        zfeLog("info", tag + " read/write phase");
        tryCallLog(tag, inst.obj, "readByte",         ["readByte"]);
        tryCallLog(tag, inst.obj, "readUTFBytes()",   ["readUTFBytes"]);
        tryCallLog(tag, inst.obj, "readUTFBytes(64)", ["readUTFBytes", 64]);
        tryCallLog(tag, inst.obj, "writeUTFBytes",    ["writeUTFBytes", "PROBE\n"]);
        tryCallLog(tag, inst.obj, "flush",            ["flush"]);
        probeDispatcher(tag, inst.obj, "post-readwrite");
    }

    function tryCallLog(tag:String, obj:Dynamic, label:String, args:Array<Dynamic>):Void {
        try {
            var callFn:Dynamic = Reflect.field(obj, "call");
            var ret:Dynamic = Reflect.callMethod(obj, callFn, args);
            var rs:String = sanitize(Std.string(ret));
            if (rs.length > 0 && rs != "null" && rs != "undefined" && rs != "false") {
                _totalBytes += rs.length;
            }
            append(tag + " " + label + " => " + rs.substr(0, 120));
            logChunked(tag + " " + label + "=" + rs, 280);
        } catch (e:Dynamic) {
            var es:String = sanitize(Std.string(e));
            append(tag + " " + label + " THREW: " + es.substr(0, 80));
            zfeLog("warn", tag + " " + label + " THREW:" + es.substr(0, 120));
        }
    }

    // =========================================================================
    // Drain loop: 100ms x 60s, watch BOTH sock and this write-backs
    // =========================================================================

    function startDrainLoop():Void {
        if (_drainTimer != null) return;
        _drainTimer = new Timer(100, DRAIN_TICKS);
        _drainTimer.addEventListener(TimerEvent.TIMER, onDrainTick);
        _drainTimer.start();
        append("Drain loop started (60s, watching sock + this)");
        zfeLog("info", "drain loop started 60s");
    }

    function onDrainTick(e:TimerEvent):Void {
        _drainTick++;

        var sc:String = fieldStr(_sock, "connected");
        var sa:String = fieldStr(_sock, "bytesAvailable");
        var tc:String = fieldStr(this, "connected");
        var ta:String = fieldStr(this, "bytesAvailable");

        if (sc != _lastSockConn || sa != _lastSockAvail || tc != _lastSelfConn || ta != _lastSelfAvail) {
            var msg:String = "DRAIN t=" + (_drainTick * 100) + "ms"
                + " sockConn=" + sc + " sockAvail=" + sa
                + " selfConn=" + tc + " selfAvail=" + ta;
            append(msg);
            zfeLog("info", msg);
            _lastSockConn  = sc;
            _lastSockAvail = sa;
            _lastSelfConn  = tc;
            _lastSelfAvail = ta;
        }

        // Once anything looks connected, fire read/write immediately (once)
        if (!_wroteOnConnect && (sc == "true" || tc == "true")) {
            _wroteOnConnect = true;
            append("CONNECTED detected -- immediate read/write pass");
            zfeLog("info", "connected detected -- immediate read/write");
            for (k in 0..._insts.length) {
                readWritePhase("inst" + k, _insts[k]);
            }
        }
    }

    // =========================================================================
    // Final summary (t+85s)
    // =========================================================================

    function logFinalSummary():Void {
        var summary:String = "SUMMARY insts=" + _insts.length
            + " regWins=" + (_regWins.length > 0 ? _regWins.join(";") : "none")
            + " connWins=" + (_connWins.length > 0 ? _connWins.join(";") : "none")
            + " sockConn=" + fieldStr(_sock, "connected")
            + " selfConn=" + fieldStr(this, "connected")
            + " sockMarker=" + hasField(_sock, "__zfe_registered_socket")
            + " selfMarker=" + hasField(this, "__zfe_registered_socket")
            + " totalBytes=" + _totalBytes;
        append(summary);
        logChunked(summary, 280);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    static function hasField(o:Dynamic, name:String):Bool {
        try { return Reflect.field(o, name) != null; } catch (e:Dynamic) {}
        return false;
    }

    static function fieldStr(o:Dynamic, name:String):String {
        try { return Std.string(Reflect.field(o, name)); } catch (e:Dynamic) {}
        return "ERR";
    }

    /** Sanitize for ZFE logging: { -> ( , } -> ) , " -> ' ; truncate 300. */
    static function sanitize(s:String):String {
        if (s == null) return "null";
        s = s.split("{").join("(").split("}").join(")").split('"').join("'");
        if (s.length > 300) s = s.substr(0, 300) + "...(trunc)";
        return s;
    }

    /** Log a long string in 280-char chunks via zfeLog. */
    function logChunked(s:String, chunkSize:Int):Void {
        var idx:Int = 0;
        var pos:Int = 0;
        while (pos < s.length) {
            zfeLog("info", (idx > 0 ? "c" + idx + "=" : "") + s.substr(pos, chunkSize));
            idx++;
            pos += chunkSize;
        }
    }

    function append(msg:String):Void {
        _lines.push(msg);
        if (_tf != null) {
            _tf.text = _lines.slice(-28).join("\n");
        }
    }

    function zfeLog(level:String, message:String):Void {
        if (_api == null) return;
        var safe:String = message.split("{").join("(").split("}").join(")").split('"').join("'");
        try {
            _api.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level +
                '","category":"' + CAT + '","message":"' + safe + '"}');
        } catch (e:Dynamic) {}
    }

    // =========================================================================
    // __ZFE discovery (logging only -- excluded from socket trials per run 1)
    // =========================================================================

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

    // =========================================================================
    // On-screen panel -- plain text, system font (embedFonts=false), no
    // htmlText, no filters (crash hard rules)
    // =========================================================================

    function buildPanel():Void {
        _tf = new TextField();
        var fmt = new TextFormat();
        fmt.font  = "_sans";
        fmt.size  = 11;
        fmt.color = 0xFFFF00;
        _tf.defaultTextFormat = fmt;
        _tf.embedFonts = false;    // run 1 rendered a black box -- use system font
        _tf.multiline  = true;
        _tf.wordWrap   = true;
        _tf.background = true;
        _tf.backgroundColor = 0x000000;
        _tf.width  = PANEL_W;
        _tf.height = PANEL_H;
        _tf.x = 10;
        _tf.y = 10;
        _tf.selectable   = false;
        _tf.mouseEnabled = false;
        addChild(_tf);
    }
}
