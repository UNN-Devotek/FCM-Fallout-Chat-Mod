/**
 * Provider-neutral wrapper for the native HUD chat bridge.
 *
 * ZFE exposes a command dispatcher (`api.call(verb, payload)`). xScal exposes
 * the same relay operations as methods on `__SFECodeObj.chatInterface`.
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
        return raw == null ? null : new FcmNativeApi(raw, ZFE);
    }

    public static function fromXscal(raw:Dynamic):FcmNativeApi {
        return raw == null ? null : new FcmNativeApi(raw, XSCAL);
    }

    /** Wrap one already-exposed provider object, validating its usable surface. */
    public static function fromExposed(raw:Dynamic):FcmNativeApi {
        if (zfeRaw(raw)) return new FcmNativeApi(raw, ZFE);
        if (xscalRaw(raw)) return new FcmNativeApi(raw, XSCAL);
        return null;
    }

    /** Discover ZFE first for backwards compatibility, then xScal. */
    public static function discover(scope:Dynamic):FcmNativeApi {
        var z:Dynamic = findZfe(scope);
        if (z != null) return new FcmNativeApi(z, ZFE);
        var x:Dynamic = findXscal(scope);
        if (x != null) return new FcmNativeApi(x, XSCAL);
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
            return chat != null && Reflect.field(chat, method) != null;
        } catch (e:Dynamic) {
            return false;
        }
    }

    static function unsupported():String {
        return '{"success":false,"error":{"code":"unsupported_command"}}';
    }

    static function zfeCandidate(obj:Dynamic):Dynamic {
        if (obj == null) return null;
        var names:Array<String> = ["__ZFE", "ZFECodeObj", "__SFCodeObj"];
        for (name in names) {
            try {
                var candidate:Dynamic = Reflect.field(obj, name);
                if (candidate != null && Reflect.field(candidate, "call") != null) return candidate;
            } catch (e:Dynamic) {}
        }
        return null;
    }

    static function zfeRaw(obj:Dynamic):Bool {
        if (obj == null) return false;
        try { return Reflect.field(obj, "call") != null; } catch (e:Dynamic) { return false; }
    }

    static function xscalRaw(obj:Dynamic):Bool {
        if (obj == null) return false;
        try {
            var chat:Dynamic = Reflect.field(obj, "chatInterface");
            return chat != null && Reflect.field(chat, "connect") != null
                && Reflect.field(chat, "pollEvents") != null
                && Reflect.field(chat, "sendMessage") != null;
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
        try { var globalLegacy:Dynamic = untyped __global__["__SFCodeObj"]; if (globalLegacy != null) return globalLegacy; } catch (e:Dynamic) {}
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
}
