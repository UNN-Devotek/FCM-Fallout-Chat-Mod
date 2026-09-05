/**
 * Provider-neutral wrapper for the native HUD chat bridge.
 *
 * ZFE exposes a command dispatcher (`api.call(verb, payload)`). xScal exposes
 * the relay operations as methods on a `chatInterface` object, normally under
 * `__SFECodeObj` and, in some builds, under `__SFCodeObj`. xScal may also
 * install an unrelated generic callback object at `__SFCodeObj.call`.
 * A bare `__SFCodeObj.call` is therefore ambiguous and must never be treated
 * as ZFE merely because it has a `call` member.
 * Discovery only inspects objects already exposed to the Scaleform movie; it
 * never loads DLLs, reads files, scans ports, or reads game memory.
 */
class FcmNativeApi {
    public static inline var ZFE:String = "zfe";
    public static inline var XSCAL:String = "xscal";

    public var provider(default, null):String;
    var _raw:Dynamic;
    // xScal owns chat under chatInterface, while its optional generic callback
    // is commonly exposed as a separate __SFCodeObj.call. Keep that callback
    // out of chat routing. It is used only for diagnostics and the documented
    // extender Input.* bookkeeping/polling surface.
    var _loggerRaw:Dynamic;
    var _inputRaw:Dynamic;

    function new(raw:Dynamic, providerName:String, loggerRaw:Dynamic = null,
            inputRaw:Dynamic = null) {
        _raw = raw;
        provider = providerName;
        _loggerRaw = loggerRaw;
        _inputRaw = inputRaw;
        if (_loggerRaw == null && providerName == XSCAL && zfeRaw(raw)) {
            // Some xScal builds put chatInterface and call on the same
            // __SFCodeObj. In that shape the object is both surfaces, but the
            // call method is still used only for diagnostics.
            _loggerRaw = raw;
        }
        if (_inputRaw == null && providerName == XSCAL && zfeRaw(raw)) {
            // A few xScal builds co-locate the generic callback and the chat
            // interface on __SFCodeObj.
            _inputRaw = raw;
        }
    }

    public static function fromZfe(raw:Dynamic):FcmNativeApi {
        // xScal may expose a diagnostic call member on the same object as its
        // chatInterface. The explicit chat surface always wins, even when a
        // legacy caller reaches this compatibility constructor.
        return zfeRaw(raw) && !xscalRaw(raw) ? new FcmNativeApi(raw, ZFE) : null;
    }

    public static function fromXscal(raw:Dynamic):FcmNativeApi {
        return xscalRaw(raw) ? new FcmNativeApi(raw, XSCAL) : null;
    }

    /**
     * Wrap one already-exposed provider object.
     *
     * The optional hint is supplied by the patched host movie when it knows
     * which named property it is handing down. A `__SFCodeObj` with an
     * explicit `chatInterface` is xScal; a bare `__SFCodeObj` has no trustworthy
     * provider identity and is accepted only after a positive runtime probe.
     */
    public static function fromExposed(raw:Dynamic, providerHint:String = "", loggerRaw:Dynamic = null):FcmNativeApi {
        if (raw == null) return null;
        // The xScal marker is authoritative. Do this before honoring a stale
        // legacy ZFE hint so __SFCodeObj.chatInterface can never be routed via
        // its generic call dispatcher as chat.v1.
        if (xscalRaw(raw)) return new FcmNativeApi(raw, XSCAL, loggerRaw, loggerRaw);
        if (providerHint == XSCAL) return xscalRaw(raw)
            ? new FcmNativeApi(raw, XSCAL, loggerRaw, loggerRaw) : null;
        if (providerHint == ZFE) return zfeRaw(raw) ? new FcmNativeApi(raw, ZFE) : null;
        if (zfeRaw(raw) && isLegacyZfeDispatcher(raw)) return new FcmNativeApi(raw, ZFE);
        return null;
    }

    /**
     * Discover a single active provider. An explicit xScal `chatInterface` is
     * authoritative when present, even if ZFE is installed alongside it. The
     * two extenders can both expose objects on the same movie root; choosing
     * xScal first is what prevents a valid chat interface from being routed
     * through the wrong callback family. The ambiguous legacy
     * `__SFCodeObj.call` slot is checked last.
     */
    public static function discover(scope:Dynamic):FcmNativeApi {
        var x:Dynamic = findXscal(scope);
        if (x != null) {
            var xGeneric:Dynamic = findGenericCallback(scope);
            return new FcmNativeApi(x, XSCAL, xGeneric, xGeneric);
        }
        var z:Dynamic = findZfe(scope);
        if (z != null && isZfeChatDispatcher(z)) {
            return new FcmNativeApi(z, ZFE, null, findGenericCallback(scope));
        }
        var legacy:Dynamic = findLegacyZfe(scope);
        if (legacy != null) {
            return new FcmNativeApi(legacy, ZFE, null, findGenericCallback(scope));
        }
        return null;
    }

    /** Route FCM's canonical verbs to the active provider. */
    public function call(verb:String, payload:String):Dynamic {
        if (provider == XSCAL) return callXscal(verb, payload);
        var fn:Dynamic = Reflect.field(_raw, "call");
        if (fn == null) return unsupported();
        return Reflect.callMethod(_raw, fn, [verb, payload]);
    }

    /** xScal provides chat transport, not ZFE's native edit buffer. */
    public function supportsNativeInput():Bool {
        return provider == ZFE;
    }

    /**
     * Return whether the selected extender exposes the physical-key bridge.
     * Registration is bookkeeping only; it does not consume the key or alter
     * Fallout's ControlMap. FCM still applies its own Insert/input-open gate
     * before consuming arrow/Home/End navigation.
     */
    public function supportsPhysicalInput():Bool {
        return inputDispatcherCandidates().length > 0;
    }

    // The dispatcher that accepted the first Input.RegisterKey. Later Input.* calls
    // stay on it so a key registered with one bridge is never polled on another.
    var _inputDispatcher:Dynamic = null;
    /** "generic-callback" or "zfe-dispatcher" once a registration has succeeded. */
    public var inputDispatcherName(default, null):String = "";
    /** Raw (clipped) value of the most recent Input.* call, for zfe.log diagnostics. */
    public var lastInputResponse(default, null):String = "";

    /**
     * Candidate dispatchers for the provider-neutral Input.* surface, in
     * preference order. A separately discovered generic callback
     * (__SFCodeObj / BRG_OBJ) is tried first. Under ZFE the SFE-compatibility
     * dispatcher that already serves setChatInputActive / isChatKeyPressed is
     * reachable through __ZFE.call, and ZFE 0.12 advertises zfe-input-v1 on
     * that object, so it is a legitimate second candidate. xScal's
     * chatInterface is never one: it has no generic call() surface.
     */
    function inputDispatcherCandidates():Array<Dynamic> {
        var out:Array<Dynamic> = [];
        if (_inputRaw != null) out.push(_inputRaw);
        if (provider == ZFE && zfeRaw(_raw) && _raw != _inputRaw) out.push(_raw);
        return out;
    }

    function activeInputDispatcher():Dynamic {
        if (_inputDispatcher != null) return _inputDispatcher;
        var candidates:Array<Dynamic> = inputDispatcherCandidates();
        return candidates.length > 0 ? candidates[0] : null;
    }

    function recordInputResponse(outcome:Dynamic):Void {
        if (outcome == null || outcome.called != true) { lastInputResponse = "<not called>"; return; }
        var text:String = outcome.value == null ? "null" : Std.string(outcome.value);
        lastInputResponse = text.length > 200 ? text.substr(0, 200) : text;
    }

    /**
     * Register one Windows virtual-key code. The first candidate whose
     * registration is not an explicit native failure becomes the dispatcher
     * for every later Input.* call.
     */
    public function registerPhysicalKey(keyCode:Int):Bool {
        if (_inputDispatcher != null) {
            var locked:Dynamic = callDispatcherOutcome(_inputDispatcher, "Input.RegisterKey", keyCode);
            recordInputResponse(locked);
            return inputMutationSucceeded(locked);
        }
        var candidates:Array<Dynamic> = inputDispatcherCandidates();
        for (candidate in candidates) {
            var outcome:Dynamic = callDispatcherOutcome(candidate, "Input.RegisterKey", keyCode);
            recordInputResponse(outcome);
            // xScal's registerKey wrapper returns its own callSucceeded flag while
            // the underlying native call is void, so null is a success here; only
            // an explicit false / error / unsupported response moves on.
            if (inputMutationSucceeded(outcome)) {
                _inputDispatcher = candidate;
                inputDispatcherName = candidate == _inputRaw ? "generic-callback" : "zfe-dispatcher";
                return true;
            }
        }
        return false;
    }

    /** Read one registered Windows virtual-key code without swallowing it. */
    public function isPhysicalKeyPressed(keyCode:Int):Bool {
        var outcome:Dynamic = callDispatcherOutcome(activeInputDispatcher(), "Input.IsKeyPressed", keyCode);
        recordInputResponse(outcome);
        if (outcome == null || outcome.called != true) return false;
        return inputResultIsTrue(outcome.value);
    }

    /** Release one previously registered Windows virtual-key code. */
    public function unregisterPhysicalKey(keyCode:Int):Bool {
        var outcome:Dynamic = callDispatcherOutcome(activeInputDispatcher(), "Input.UnregisterKey", keyCode);
        recordInputResponse(outcome);
        return inputMutationSucceeded(outcome);
    }

    /** Both providers may need a delayed replay when a reloaded HUD has an empty native queue. */
    public static function widgetMustRequestHistoryResync(providerName:String):Bool {
        return providerName == ZFE || providerName == XSCAL;
    }

    /**
     * Verify the chat capability through the active provider only.
     *
     * This is intentionally provider-aware: calling the ZFE runtime verb on
     * xScal's generic `__SFCodeObj.call` produces the dispatch failure seen in
     * xScal logs. xScal's required method surface is a capability gate; when it
     * exposes getRuntimeInfo, its positive response is checked too.
     */
    public function probeChatCapability():Bool {
        try {
            if (provider == ZFE) {
                return isZfeChatRuntimeInfo(Std.string(call("chat.v1.getRuntimeInfo", "{}")));
            }
            if (!xscalRaw(_raw)
                || !hasChatMethod("connect")
                || !hasChatMethod("pollEvents")
                || !hasChatMethod("sendMessage")) return false;
            if (!hasChatMethod("getRuntimeInfo")) return true;
            return isXscalChatRuntimeInfo(Std.string(call("chat.v1.getRuntimeInfo", "{}")));
        } catch (e:Dynamic) {
            return false;
        }
    }

    function callXscal(verb:String, payload:String):Dynamic {
        var method:String = verb;
        if (StringTools.startsWith(method, "chat.v1.")) method = method.substr(8);
        if (method == "report") method = "reportMessage";
        if (method == "getAuthState" && !hasChatMethod("getAuthState")) {
            method = "getConnectionState";
        }
        if (method == "log") return callLogger(payload);
        if (!hasChatMethod(method)) return unsupported();
        var chat:Dynamic = Reflect.field(_raw, "chatInterface");
        var fn:Dynamic = Reflect.field(chat, method);
        // xScal's documented chat surface receives an ActionScript object, not the JSON
        // string accepted by ZFE's dispatcher. Runtime/cancellation methods are no-argument;
        // sending "{}" to those methods is what produced the Scaleform argument-count errors.
        if (method == "getRuntimeInfo" || method == "getConnectionState" || method == "disconnect"
                || method == "logout" || method == "clearChatAuth") {
            return Reflect.callMethod(chat, fn, []);
        }
        var args:Dynamic = payload;
        try { args = haxe.Json.parse(payload == null || payload.length == 0 ? "{}" : payload); }
        catch (e:Dynamic) {}
        return Reflect.callMethod(chat, fn, [args]);
    }

    function hasChatMethod(method:String):Bool {
        try {
            var chat:Dynamic = Reflect.field(_raw, "chatInterface");
            return chat != null && Reflect.isFunction(Reflect.field(chat, method));
        } catch (e:Dynamic) {
            return false;
        }
    }

    /**
     * Forward diagnostics through xScal's optional generic callback only. This
     * is deliberately separate from chatInterface: a generic callback may
     * receive `log`, but it must never receive chat.v1 transport verbs.
     */
    function callLogger(payload:String):Dynamic {
        if (!zfeRaw(_loggerRaw)) return "";
        var result:Dynamic = callDispatcher(_loggerRaw, "log", payload);
        return result == null ? "" : result;
    }

    static function unsupported():String {
        return '{"success":false,"error":{"code":"unsupported_command"}}';
    }

    static function zfeCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        // __SFCodeObj is also installed by xScal, so it is handled separately
        // through legacyZfeCandidate() and a positive capability probe.
        var names:Array<String> = ["__ZFE", "ZFECodeObj"];
        for (name in names) {
            try {
                var candidate:Dynamic = Reflect.field(obj, name);
                if (zfeRaw(candidate)) return candidate;
            } catch (e:Dynamic) {}
        }
        return null;
    }

    static function zfeRaw(obj:Dynamic):Bool {
        if (obj == null) return false;
        try { return Reflect.isFunction(Reflect.field(obj, "call")); } catch (e:Dynamic) { return false; }
    }

    static function xscalRaw(obj:Dynamic):Bool {
        if (obj == null) return false;
        try {
            return Reflect.field(obj, "chatInterface") != null;
        } catch (e:Dynamic) {
            return false;
        }
    }

    static function xscalCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        try {
            if (xscalRaw(obj)) return obj;
        } catch (e:Dynamic) {}
        for (name in ["__SFECodeObj", "__SFCodeObj"]) {
            try {
                var candidate:Dynamic = Reflect.field(obj, name);
                if (candidate != null && xscalRaw(candidate)) return candidate;
            } catch (e:Dynamic) {}
        }
        return null;
    }

    /**
     * Find the optional generic callback without making it a chat candidate.
     * ZFE's legacy compatibility object is often surfaced as BRG_OBJ, while
     * xScal normally uses __SFCodeObj. The callback is never used for chat
     * transport; only `log` and documented `Input.*` calls use it.
     */
    static function findGenericCallback(scope:Dynamic):Dynamic {
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            try {
                if (xscalRaw(cur) && zfeRaw(cur)) return cur;
                for (name in ["__SFCodeObj", "BRG_OBJ", "__SFECodeObj"]) {
                    var candidate:Dynamic = Reflect.field(cur, name);
                    if (zfeRaw(candidate)) return candidate;
                }
            } catch (e:Dynamic) {}
            try { cur = cur.parent; } catch (e:Dynamic) { cur = null; }
            depth++;
        }
        try {
            var stage:Dynamic = scope.stage;
            if (stage != null && stage != scope) {
                if (xscalRaw(stage) && zfeRaw(stage)) return stage;
                for (name in ["__SFCodeObj", "BRG_OBJ", "__SFECodeObj"]) {
                    var stageCandidate:Dynamic = Reflect.field(stage, name);
                    if (zfeRaw(stageCandidate)) return stageCandidate;
                }
            }
        } catch (e:Dynamic) {}
        try {
            var root:Dynamic = scope.root;
            if (root != null && root != scope) {
                if (xscalRaw(root) && zfeRaw(root)) return root;
                for (name in ["__SFCodeObj", "BRG_OBJ", "__SFECodeObj"]) {
                    var rootCandidate:Dynamic = Reflect.field(root, name);
                    if (zfeRaw(rootCandidate)) return rootCandidate;
                }
            }
        } catch (e:Dynamic) {}
        #if flash
        try {
            var globalSf:Dynamic = untyped __global__["__SFCodeObj"];
            if (zfeRaw(globalSf)) return globalSf;
        } catch (e:Dynamic) {}
        try {
            var globalBrg:Dynamic = untyped __global__["BRG_OBJ"];
            if (zfeRaw(globalBrg)) return globalBrg;
        } catch (e:Dynamic) {}
        try {
            var globalSfe:Dynamic = untyped __global__["__SFECodeObj"];
            if (zfeRaw(globalSfe)) return globalSfe;
        } catch (e:Dynamic) {}
        #end
        return null;
    }

    /** Return a legacy generic bridge on a scope, if it positively answers as ZFE. */
    static function legacyZfeCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        for (name in ["__SFCodeObj", "BRG_OBJ"]) {
            try {
                var candidate:Dynamic = Reflect.field(obj, name);
                if (zfeRaw(candidate) && isLegacyZfeDispatcher(candidate)) return candidate;
            } catch (e:Dynamic) {}
        }
        return null;
    }

    /** Call a raw dispatcher without allowing a failed probe to escape. */
    static function callDispatcher(raw:Dynamic, verb:String, payload:String):Dynamic {
        try {
            var fn:Dynamic = Reflect.field(raw, "call");
            if (!Reflect.isFunction(fn)) return null;
            return Reflect.callMethod(raw, fn, [verb, payload]);
        } catch (e:Dynamic) {
            return null;
        }
    }

    static function hasSuccessTrue(info:String):Bool {
        if (info == null) return false;
        return info.indexOf("\"success\":true") >= 0
            || info.indexOf("\"success\": true") >= 0
            || info.indexOf("success:true") >= 0
            || info.indexOf("success: true") >= 0;
    }

    static function isZfeChatRuntimeInfo(info:String):Bool {
        return hasSuccessTrue(info) && info.indexOf("zfe-chat-online-v1") >= 0;
    }

    static function isXscalChatRuntimeInfo(info:String):Bool {
        return hasSuccessTrue(info)
            && (info.indexOf("xscal-chat-interface") >= 0
                || info.indexOf("\"runtime\":\"xScal Chat\"") >= 0);
    }

    /** xScal's generic callback registry identifies itself with this verb. */
    static function isXscalCallbackInfo(info:String):Bool {
        if (info == null) return false;
        return info.indexOf("\"runtime\":\"xScal\"") >= 0
            || info.indexOf("\"runtime\": \"xScal\"") >= 0;
    }

    /**
     * `__SFCodeObj` is shared by old ZFE and xScal. Probe xScal's own marker
     * first so an xScal callback object never receives a ZFE chat probe.
     */
    static function isZfeChatDispatcher(raw:Dynamic):Bool {
        if (!zfeRaw(raw)) return false;
        return isZfeChatRuntimeInfo(Std.string(callDispatcher(raw, "chat.v1.getRuntimeInfo", "{}")));
    }

    /** Probe the ambiguous legacy slot without sending ZFE verbs to xScal. */
    static function isLegacyZfeDispatcher(raw:Dynamic):Bool {
        if (!zfeRaw(raw)) return false;
        var xscalInfo:String = Std.string(callDispatcher(raw, "GetXSRuntimeInfo", "{}"));
        if (isXscalCallbackInfo(xscalInfo)) return false;
        return isZfeChatDispatcher(raw);
    }

    static function findZfe(scope:Dynamic):Dynamic {
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            var hit:Dynamic = zfeCandidate(cur);
            if (hit != null) return hit;
            try { cur = cur.parent; } catch (e:Dynamic) { cur = null; }
            depth++;
        }
        try {
            var stage:Dynamic = scope.stage;
            var stageHit:Dynamic = zfeCandidate(stage);
            if (stageHit != null) return stageHit;
        } catch (e:Dynamic) {}
        try { var root:Dynamic = scope.root; var hit:Dynamic = zfeCandidate(root); if (hit != null) return hit; } catch (e:Dynamic) {}
        #if flash
        try { var globalZfe:Dynamic = untyped __global__["__ZFE"]; if (globalZfe != null) return globalZfe; } catch (e:Dynamic) {}
        try { var globalZfe2:Dynamic = untyped __global__["ZFECodeObj"]; if (globalZfe2 != null) return globalZfe2; } catch (e:Dynamic) {}
        #end
        return null;
    }

    /**
     * Call a generic extender verb and retain both dispatch success and its
     * return value. Input.RegisterKey/UnregisterKey are void in xScal's
     * compatibility wrapper, so losing the distinction makes every valid
     * registration look rejected and prevents the polling timer from starting.
     */
    static function callDispatcherOutcome(raw:Dynamic, verb:String, value:Dynamic):Dynamic {
        if (raw == null) return { called: false, value: null };
        try {
            var fn:Dynamic = Reflect.field(raw, "call");
            if (!Reflect.isFunction(fn)) return { called: false, value: null };
            return {
                called: true,
                value: Reflect.callMethod(raw, fn, [verb, value])
            };
        } catch (e:Dynamic) {
            return { called: false, value: null };
        }
    }

    /** Mutation calls may be void; reject only an explicit native failure. */
    static function inputMutationSucceeded(outcome:Dynamic):Bool {
        if (outcome == null || outcome.called != true) return false;
        var value:Dynamic = outcome.value;
        if (value == null) return true;
        if (value == false || value == 0) return false;
        var text:String = StringTools.trim(Std.string(value)).toLowerCase();
        if (text.length == 0 || text == "false" || text == "0" || text == "undefined") return false;
        if (text.indexOf('"success":false') >= 0
                || text.indexOf('"success": false') >= 0
                || text.indexOf('"error"') >= 0
                || text.indexOf("unsupported") >= 0
                || text.indexOf("invalid") >= 0) return false;
        return true;
    }

    /**
     * Decode an Input.IsKeyPressed answer. xScal returns a native boolean. ZFE
     * answers its JSON envelope, and a successful envelope is NOT a pressed
     * state: only an explicit boolean-like field is. Treating `"success":true`
     * as "down" would fire one channel switch on the first poll and then latch
     * the key forever.
     */
    static function inputResultIsTrue(value:Dynamic):Bool {
        if (value == null) return false;
        if (value == true || value == 1) return true;
        if (value == false || value == 0) return false;
        var text:String = StringTools.trim(Std.string(value));
        var lower:String = text.toLowerCase();
        if (lower == "true" || lower == "1" || lower == "pressed" || lower == "down") return true;
        if (lower.length == 0 || lower.charAt(0) != "{") return false;
        var parsed:Dynamic = null;
        try { parsed = haxe.Json.parse(text); } catch (e:Dynamic) { return false; }
        if (parsed == null || Reflect.field(parsed, "success") == false) return false;
        for (name in ["pressed", "isPressed", "down", "isDown", "held", "value", "result", "data"]) {
            var field:Dynamic = Reflect.field(parsed, name);
            if (field == null) continue;
            if (field == true) return true;
            if (field == false) return false;
            if (Std.isOfType(field, String)) {
                var f:String = StringTools.trim(Std.string(field)).toLowerCase();
                return f == "true" || f == "1" || f == "pressed" || f == "down";
            }
            if (Std.isOfType(field, Float) || Std.isOfType(field, Int)) return field != 0;
            if (Reflect.isObject(field)) return inputResultIsTrue(haxe.Json.stringify(field));
        }
        return false;
    }

    static function findXscal(scope:Dynamic):Dynamic {
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            var hit:Dynamic = xscalCandidate(cur);
            if (hit != null) return hit;
            try { cur = cur.parent; } catch (e:Dynamic) { cur = null; }
            depth++;
        }
        try {
            var stage:Dynamic = scope.stage;
            var stageHit:Dynamic = xscalCandidate(stage);
            if (stageHit != null) return stageHit;
        } catch (e:Dynamic) {}
        try { var root:Dynamic = scope.root; var hit:Dynamic = xscalCandidate(root); if (hit != null) return hit; } catch (e:Dynamic) {}
        #if flash
        try {
            var globalX:Dynamic = untyped __global__["__SFECodeObj"];
            var hitX:Dynamic = xscalCandidate(globalX);
            if (hitX != null) return hitX;
        } catch (e:Dynamic) {}
        try {
            var globalSf:Dynamic = untyped __global__["__SFCodeObj"];
            var hitSf:Dynamic = xscalCandidate(globalSf);
            if (hitSf != null) return hitSf;
        } catch (e:Dynamic) {}
        #end
        return null;
    }

    static function findLegacyZfe(scope:Dynamic):Dynamic {
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            var hit:Dynamic = legacyZfeCandidate(cur);
            if (hit != null) return hit;
            try { cur = cur.parent; } catch (e:Dynamic) { cur = null; }
            depth++;
        }
        try {
            var stage:Dynamic = scope.stage;
            var stageHit:Dynamic = legacyZfeCandidate(stage);
            if (stageHit != null) return stageHit;
        } catch (e:Dynamic) {}
        try {
            var root:Dynamic = scope.root;
            var hit:Dynamic = legacyZfeCandidate(root);
            if (hit != null) return hit;
        } catch (e:Dynamic) {}
        #if flash
        try {
            var globalLegacySf:Dynamic = untyped __global__["__SFCodeObj"];
            var sfWrapper:Dynamic = { __SFCodeObj: globalLegacySf };
            var sfHit:Dynamic = legacyZfeCandidate(sfWrapper);
            if (sfHit != null) return sfHit;
        } catch (e:Dynamic) {}
        try {
            var globalLegacyBrg:Dynamic = untyped __global__["BRG_OBJ"];
            var brgWrapper:Dynamic = { BRG_OBJ: globalLegacyBrg };
            var brgHit:Dynamic = legacyZfeCandidate(brgWrapper);
            if (brgHit != null) return brgHit;
        } catch (e:Dynamic) {}
        #end
        return null;
    }
}
