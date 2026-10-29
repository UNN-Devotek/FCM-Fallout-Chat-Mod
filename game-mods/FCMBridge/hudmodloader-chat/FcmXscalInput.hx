typedef FcmXscalInputBegin = {
    var success:Bool;
    var sessionId:Dynamic;
    var unsupported:Bool;
    var busy:Bool;
}

typedef FcmXscalInputPoll = {
    var success:Bool;
    var sessionId:Dynamic;
    var revision:Int;
    var text:String;
    var state:String;
    /** Optional read-only UTF-16 position; -1 leaves the native editor unchanged. */
    var caretIndex:Int;
}

/** Decoder for xScal 0.2.18's bounded, exclusive Input.* text session. */
class FcmXscalInput {
    static function field(value:Dynamic, key:String):Dynamic {
        try { return value == null ? null : Reflect.field(value, key); }
        catch (_:Dynamic) { return null; }
    }

    static function response(raw:Dynamic):Dynamic {
        if (!Std.isOfType(raw, String)) return null;
        var s:String = cast raw;
        return s.length <= 4096 ? FcmJson.parse(s) : null;
    }

    static function validId(value:Dynamic):Bool {
        if (value == null || Std.isOfType(value, Bool) || Std.isOfType(value, String)) return false;
        var n:Float = Std.parseFloat(Std.string(value));
        return Math.isFinite(n) && n >= 1 && n <= 4294967295.0
            && Math.floor(n) == n && Std.string(value) == Std.string(n);
    }

    public static function sameSession(expected:Dynamic, actual:Dynamic):Bool {
        return validId(expected) && validId(actual)
            && Std.string(expected) == Std.string(actual);
    }

    public static function begin(raw:Dynamic):FcmXscalInputBegin {
        var parsed = response(raw);
        var id = field(parsed, "sessionId");
        return {success:field(parsed, "success") == true && validId(id), sessionId:id,
            unsupported:raw == null || raw == false,
            busy:field(parsed, "success") == false && field(parsed, "error") == "input_unavailable"};
    }

    public static function poll(raw:Dynamic, expectedId:Dynamic, maxChars:Int):FcmXscalInputPoll {
        var parsed = response(raw);
        var id = field(parsed, "sessionId");
        var revisionValue = field(parsed, "revision");
        var textValue = field(parsed, "text");
        var stateValue = field(parsed, "state");
        var revision:Float = Std.parseFloat(Std.string(revisionValue));
        var state:String = Std.isOfType(stateValue, String) ? cast stateValue : "";
        var text:String = Std.isOfType(textValue, String) ? cast textValue : "";
        var limit:Int = Std.int(Math.min(512, maxChars));
        var ok:Bool = field(parsed, "success") == true
            && sameSession(expectedId, id)
            && Math.isFinite(revision) && revision >= 0 && revision <= 2147483647
            && Math.floor(revision) == revision
            && Std.isOfType(textValue, String) && limit > 0 && text.length <= limit
            && (state == "active" || state == "submitted" || state == "cancelled");
        var caretValue = field(parsed, "caretIndex");
        var caretIndex:Int = -1;
        if (ok && !Std.isOfType(caretValue, Bool)
                && (Std.isOfType(caretValue, Int) || Std.isOfType(caretValue, Float))) {
            var n:Float = cast caretValue;
            if (Math.isFinite(n) && n >= 0 && n <= text.length && Math.floor(n) == n) {
                var index = Std.int(n);
                var before = index > 0 ? text.charCodeAt(index - 1) : 0;
                var after = index < text.length ? text.charCodeAt(index) : 0;
                if (!(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF))
                    caretIndex = index;
            }
        }
        return {success:ok, sessionId:id, revision:ok ? Std.int(revision) : -1,
            text:ok ? text : "", state:ok ? state : "", caretIndex:caretIndex};
    }

    /** A closed session must be rejected by the same native poll contract. */
    public static function confirmsReleased(raw:Dynamic):Bool {
        var parsed = response(raw);
        return field(parsed, "success") == false
            && field(parsed, "error") == "invalid_session";
    }
}
