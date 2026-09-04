/**
 * Provider-neutral wrapper for the native HUD chat bridge.
 *
 * ZFE exposes a command dispatcher (`api.call(verb, payload)`). xScal exposes
 * the relay operations as methods on `__SFECodeObj.chatInterface` and also
 * installs an unrelated generic callback object at `__SFCodeObj.call`.
 * `__SFCodeObj.call` is therefore ambiguous and must never be treated as ZFE
 * merely because it has a `call` member.
 * Discovery only inspects objects already exposed to the Scaleform movie; it
 * never loads DLLs, reads files, scans ports, or reads game memory.
 */
class FcmNativeApi {
    public static inline var ZFE:String = "zfe";
    public static inline var XSCAL:String = "xscal";

    public var provider(default, null):String;
    var _raw:Dynamic;

    function new(raw:Dynamic, providerName:String) {
        _raw = raw;
        provider = providerName;
    }

    public static function fromZfe(raw:Dynamic):FcmNativeApi {
        return zfeRaw(raw) ? new FcmNativeApi(raw, ZFE) : null;
    }

    public static function fromXscal(raw:Dynamic):FcmNativeApi {
        return xscalRaw(raw) ? new FcmNativeApi(raw, XSCAL) : null;
    }

    /**
     * Wrap one already-exposed provider object.
     *
     * The optional hint is supplied by the patched host movie when it knows
     * which named property it is handing down. A bare `__SFCodeObj` has no
     * trustworthy provider identity, so it is accepted only after a positive
     * runtime probe.
     */
    public static function fromExposed(raw:Dynamic, providerHint:String = ""):FcmNativeApi {
        if (raw == null) return null;
        if (providerHint == XSCAL) return xscalRaw(raw) ? new FcmNativeApi(raw, XSCAL) : null;
        if (providerHint == ZFE) return zfeRaw(raw) ? new FcmNativeApi(raw, ZFE) : null;
        if (xscalRaw(raw)) return new FcmNativeApi(raw, XSCAL);
        if (zfeRaw(raw) && isLegacyZfeDispatcher(raw)) return new FcmNativeApi(raw, ZFE);
        return null;
    }

    /**
     * Discover a single active provider. Explicit ZFE objects retain priority;
     * xScal's chat object is checked before the ambiguous legacy
     * `__SFCodeObj` compatibility slot.
     */
    public static function discover(scope:Dynamic):FcmNativeApi {
        var z:Dynamic = findZfe(scope);
        if (z != null && isZfeChatDispatcher(z)) return new FcmNativeApi(z, ZFE);
        var x:Dynamic = findXscal(scope);
        if (x != null) return new FcmNativeApi(x, XSCAL);
        var legacy:Dynamic = findLegacyZfe(scope);
        if (legacy != null) return new FcmNativeApi(legacy, ZFE);
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
     * Verify the chat capability through the active provider only.
     *
     * This is intentionally provider-aware: calling the ZFE runtime verb on
     * xScal's generic `__SFCodeObj.call` produces the dispatch failure seen in
     * xScal logs. xScal's required method surface is already a capability gate;
     * when it exposes getRuntimeInfo, its positive response is checked too.
     */
    public function probeChatCapability():Bool {
        try {
            if (provider == ZFE) {
                return isZfeChatRuntimeInfo(Std.string(call("chat.v1.getRuntimeInfo", "{}")));
            }
            if (!xscalRaw(_raw)) return false;
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
        if (method == "log") return ""; // xScal has no FCM vendor log command.
        if (!hasChatMethod(method)) return unsupported();
        var chat:Dynamic = Reflect.field(_raw, "chatInterface");
        var fn:Dynamic = Reflect.field(chat, method);
        return Reflect.callMethod(chat, fn, [payload]);
    }

    function hasChatMethod(method:String):Bool {
        try {
            var chat:Dynamic = Reflect.field(_raw, "chatInterface");
            return chat != null && Reflect.isFunction(Reflect.field(chat, method));
        } catch (e:Dynamic) {
            return false;
        }
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
            var chat:Dynamic = Reflect.field(obj, "chatInterface");
            return chat != null
                && Reflect.isFunction(Reflect.field(chat, "connect"))
                && Reflect.isFunction(Reflect.field(chat, "pollEvents"))
                && Reflect.isFunction(Reflect.field(chat, "sendMessage"));
        } catch (e:Dynamic) {
            return false;
        }
    }

    static function xscalCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        try {
            if (xscalRaw(obj)) return obj;
        } catch (e:Dynamic) {}
        try {
            var candidate:Dynamic = Reflect.field(obj, "__SFECodeObj");
            if (candidate != null) {
                var chat:Dynamic = Reflect.field(candidate, "chatInterface");
                if (xscalRaw(candidate)) return candidate;
            }
        } catch (e:Dynamic) {}
        return null;
    }

    /** Return the ambiguous legacy __SFCodeObj on a scope, if it is ZFE. */
    static function legacyZfeCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        try {
            var candidate:Dynamic = Reflect.field(obj, "__SFCodeObj");
            if (!zfeRaw(candidate)) return null;
            return isLegacyZfeDispatcher(candidate) ? candidate : null;
        } catch (e:Dynamic) {
            return null;
        }
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
        try { var root:Dynamic = scope.root; var hit:Dynamic = zfeCandidate(root); if (hit != null) return hit; } catch (e:Dynamic) {}
        #if flash
        try { var globalZfe:Dynamic = untyped __global__["__ZFE"]; if (globalZfe != null) return globalZfe; } catch (e:Dynamic) {}
        try { var globalZfe2:Dynamic = untyped __global__["ZFECodeObj"]; if (globalZfe2 != null) return globalZfe2; } catch (e:Dynamic) {}
        #end
        return null;
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
        try { var root:Dynamic = scope.root; var hit:Dynamic = xscalCandidate(root); if (hit != null) return hit; } catch (e:Dynamic) {}
        #if flash
        try { var globalX:Dynamic = untyped __global__["__SFECodeObj"]; if (globalX != null && xscalCandidate(globalX) != null) return globalX; } catch (e:Dynamic) {}
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
            var root:Dynamic = scope.root;
            var hit:Dynamic = legacyZfeCandidate(root);
            if (hit != null) return hit;
        } catch (e:Dynamic) {}
        #if flash
        try {
            var globalLegacy:Dynamic = untyped __global__["__SFCodeObj"];
            var hit:Dynamic = legacyZfeCandidate({ __SFCodeObj: globalLegacy });
            if (hit != null) return hit;
        } catch (e:Dynamic) {}
        #end
        return null;
    }
}
