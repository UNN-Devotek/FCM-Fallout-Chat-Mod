/** Pure transport health policy; a quiet valid events array remains healthy. */
class FcmReconnect {
    public static inline var HANDSHAKE_MS:Int = 60000;
    public static function pendingAllowed(startedAt:Float, now:Float):Bool {
        return now - startedAt < HANDSHAKE_MS;
    }
    public static function validPoll(raw:String):Bool {
        if (raw == null) return false;
        try {
            var data:Dynamic = FcmJson.parse(raw);
            return data != null && Reflect.field(data, "success") == true
                && Std.isOfType(Reflect.field(data, "events"), Array);
        } catch (_:Dynamic) { return false; }
    }
}
