/** Resolve the public manager in the movie that owns the vanilla nameplates.
 * Definition discovery does not create watches, read payloads or alter providers. */
class FcmNameplateSource {
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    static function callable(value:Dynamic):Bool {
        return value != null && Reflect.isFunction(field(value, "GetDataFromClient"))
            && Reflect.isFunction(field(value, "Subscribe")) && Reflect.isFunction(field(value, "Unsubscribe"));
    }
    public static function resolve(host:Dynamic, fallback:Dynamic):{manager:Dynamic, scope:String, relation:String, error:Int} {
        var result = {manager:fallback, scope:"fallback", relation:"missing", error:0};
        if (host == null) return result;
        var info = field(host, "loaderInfo");
        if (info == null) info = field(field(host, "root"), "loaderInfo");
        var domain = field(info, "applicationDomain");
        if (domain == null) return result;
        result.relation = "unavailable";
        if (!Reflect.isFunction(field(domain, "getDefinition"))) return result;
        try {
            var candidate:Dynamic = domain.getDefinition("Shared.AS3.Data.BSUIDataManager");
            if (!callable(candidate)) { result.relation = "not-callable"; return result; }
            result.manager = candidate; result.scope = "host-domain";
            result.relation = candidate == fallback ? "same" : "different";
        } catch (failure:Dynamic) {
            var code:Dynamic = field(failure, "errorID");
            if ((Std.isOfType(code, Int) || Std.isOfType(code, Float)) && Math.isFinite(code)
                    && code >= 0 && code <= 1000000 && code == Math.floor(code)) result.error = Std.int(code);
        }
        return result;
    }
}
