typedef FcmZfeInputBegin = {
    var success:Bool;
    var session:Dynamic;
    var rawSuppression:Bool;
    var releaseBarrier:Bool;
}

typedef FcmZfeInputPoll = {
    var success:Bool;
    var active:Bool;
    var revision:Int;
    var text:String;
    var submitted:Bool;
    var cancelled:Bool;
    var releaseReady:Bool;
}

/** Bounded decoder/payload helper for ZFE's owner-scoped input.v1 contract. */
class FcmZfeInput {
    static function field(value:Dynamic, key:String):Dynamic {
        try { return value == null ? null : Reflect.field(value, key); } catch (_:Dynamic) { return null; }
    }

    public static function begin(raw:Dynamic):FcmZfeInputBegin {
        var parsed = FcmJson.parse(Std.string(raw));
        return {
            success: field(parsed, "success") == true && field(parsed, "session") != null,
            session: field(parsed, "session"),
            rawSuppression: field(parsed, "rawSuppression") == true,
            releaseBarrier: field(parsed, "releaseBarrier") == true
        };
    }

    public static function poll(raw:Dynamic):FcmZfeInputPoll {
        var parsed = FcmJson.parse(Std.string(raw));
        var revision = Std.parseInt(Std.string(field(parsed, "revision")));
        return {
            success: field(parsed, "success") == true && field(parsed, "session") != null,
            active: field(parsed, "active") == true,
            revision: revision == null ? -1 : revision,
            text: field(parsed, "text") == null ? "" : Std.string(field(parsed, "text")),
            submitted: field(parsed, "submitted") == true,
            cancelled: field(parsed, "cancelled") == true,
            releaseReady: field(parsed, "releaseReady") == true
        };
    }

    public static function beginPayload(vendor:String, initial:String, maxBytes:Int):String {
        return haxe.Json.stringify({vendor:vendor, initial:initial, maxBytes:maxBytes});
    }

    public static function sessionPayload(session:Dynamic):String {
        return haxe.Json.stringify({session:session});
    }
}
