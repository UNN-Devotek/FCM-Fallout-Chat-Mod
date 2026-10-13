/** Count-only evidence about existing public HUD payloads. Never authorizes paint,
 * creates/removes a watch, changes flags, or retains a native payload reference. */
class FcmNameplateProbe {
    static function field(value:Dynamic, key:String):Dynamic return FcmRoster.field(value, key);
    static function count(value:Dynamic):Int {
        var n:Dynamic = field(value, "length");
        return (Std.isOfType(n, Int) || Std.isOfType(n, Float)) && n >= 0 && n <= 128
            && n == Math.floor(n) ? Std.int(n) : -1;
    }
    static function relation(a:Dynamic, b:Dynamic):String return a == null || b == null ? "missing" : a == b ? "same" : "different";
    static function errorCode(error:Dynamic):Int {
        var n:Dynamic = field(error, "errorID");
        return (Std.isOfType(n, Int) || Std.isOfType(n, Float)) && n >= 0 && n <= 1000000
            && n == Math.floor(n) ? Std.int(n) : 0;
    }
    public static function sample(host:Dynamic, manager:Dynamic, provider:Dynamic, event:Dynamic = null):Dynamic {
        var result:Dynamic = {rows:-1,eligible:0,plateMatches:0,eventPayload:"snapshot",
            getterPayload:"missing",nativeApi:false,readyArity:-1,error:0};
        var payload:Dynamic = field(provider, "data");
        if (event != null) result.eventPayload = relation(payload, field(event, "data"));
        result.nativeApi = Reflect.isFunction(field(manager, "RemoveWatchFromDataConnector"));
        var ready = field(provider, "SetReady");
        if (Reflect.isFunction(ready)) result.readyArity = count(ready);
        if (Reflect.isFunction(field(manager, "GetDataFromClient"))) {
            try { result.getterPayload = relation(payload, field(manager.GetDataFromClient("TeamMarkers", false), "data")); }
            catch (error:Dynamic) { result.error = errorCode(error); }
        }
        // The game's TeamNameplates is a Vector, not an Array. Explicit Dynamic
        // prevents Haxe's indexed-access inference from inserting an Array cast.
        var rows:Dynamic = field(payload, "Markers");
        var plates:Dynamic = field(field(host, "TeammateMarkerBase"), "TeamNameplates");
        var n = count(rows), p = count(plates); result.rows = n;
        if (n >= 0) for (i in 0...n) {
            var row:Dynamic = rows[i];
            var name:Dynamic = field(row, "displayName"), id:Dynamic = field(row, "entityID");
            if (id == null || !Std.isOfType(name, String)) continue;
            var cleanName = FcmNameplates.clean(name);
            if (cleanName.length == 0) continue;
            var local:Dynamic = field(row, "isLocalPlayer"), hostile:Dynamic = field(row, "isHostile");
            if (Std.isOfType(local, Bool) && local == false && Std.isOfType(hostile, Bool) && hostile == false
                    && ["teammate", "eventgroupmate", "nonhostile", "friend", "potentialHostile"].indexOf(field(row, "playerState")) >= 0
                    && field(row, "wantedState") == "notWanted") result.eligible++;
            if (p >= 0) for (j in 0...p) {
                var plate:Dynamic = plates[j];
                var text:Dynamic = field(field(plate, "Name_tf"), "text");
                if (field(plate, "visible") == true && id == field(plate, "entityID") && Std.isOfType(text, String)
                        && cleanName == FcmNameplates.clean(text)) { result.plateMatches++; break; }
            }
        }
        return result;
    }
    public static function diagnostic(value:Dynamic):String {
        return "probeRows=" + value.rows + " probeEligible=" + value.eligible + " probePlates=" + value.plateMatches
            + " eventPayload=" + value.eventPayload + " getterPayload=" + value.getterPayload
            + " nativeManagerApi=" + value.nativeApi
            + " readyArity=" + value.readyArity + " probeError=" + value.error;
    }
}
