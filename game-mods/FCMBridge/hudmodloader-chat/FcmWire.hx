/** Small, Flash-free helpers for the native chat.v1 wire format. */
class FcmWire {
    /** A dropped marker only proves unread loss when its sequence skips past the consumed cursor. */
    public static function droppedMarkerHasUnreadGap(raw:String, cursorBefore:Int):Bool {
        var value:Dynamic = parseObject(raw);
        if (value == null) return true;
        var markerId:Int = positiveInt(Reflect.field(value, "id"));
        if (markerId <= 0) markerId = positiveInt(Reflect.field(value, "cursor"));
        // Unknown markers fail closed. Contiguous or stale markers describe retention of
        // already-consumed entries; the native logs proved their dropped count is cumulative
        // queue retirement metadata, not a count of unread events before this marker.
        return markerId <= 0 || markerId > cursorBefore + 1;
    }

    /** Diagnostic only: fixed keys and bounded numeric queue metadata, never arbitrary payloads. */
    public static function queueLossSummary(raw:String):String {
        var value:Dynamic = parseObject(raw);
        if (value == null) return "unparsed";
        var fields:Array<String> = [];
        for (container in ["", "data", "details", "payload"]) {
            var source:Dynamic = container == "" ? value : Reflect.field(value, container);
            if (source == null) continue;
            for (key in ["id", "cursor", "nextCursor", "count", "dropped", "droppedCount",
                    "totalDropped", "droppedTotal", "lost", "oldestId", "newestId",
                    "firstId", "lastId", "fromId", "toId", "oldest", "newest",
                    "capacity", "retained", "size", "max", "after", "since"]) {
                var item:Dynamic = Reflect.field(source, key);
                if (item == null || Std.isOfType(item, String) || Std.isOfType(item, Bool)) continue;
                var number:Float = Std.parseFloat(Std.string(item));
                if (!Math.isFinite(number) || number < 0 || number > 2147483647
                        || Math.floor(number) != number) continue;
                fields.push((container == "" ? "" : container + ".") + key + "=" + Std.int(number));
                if (fields.length >= 16) return fields.join(" ");
            }
        }
        return fields.length == 0 ? "none" : fields.join(" ");
    }

    /** Return the provider-local request id only for a successful asynchronous queue result. */
    public static function queuedRequestId(raw:String):Int {
        var value:Dynamic = parseObject(raw);
        if (value == null || Reflect.field(value, "success") != true
                || Std.string(Reflect.field(value, "status")) != "queued") return 0;
        return positiveInt(Reflect.field(value, "requestId"));
    }

    /** 1 = accepted, -1 = failed, 0 = unrelated provider event. */
    public static function asyncSendCompletion(raw:String):Int {
        var value:Dynamic = parseObject(raw);
        if (value == null) return 0;
        return switch (Std.string(Reflect.field(value, "kind"))) {
            case "chat.send.accepted": 1;
            case "chat.send.failed": -1;
            default: 0;
        };
    }

    public static function asyncRequestId(raw:String):Int {
        var value:Dynamic = parseObject(raw);
        return value == null ? 0 : positiveInt(Reflect.field(value, "requestId"));
    }

    /** The terminal ZFE event nests the relay response; keep command feedback private. */
    public static function asyncResultTargetUserId(raw:String):String {
        var value:Dynamic = parseObject(raw);
        if (value == null || Std.string(Reflect.field(value, "kind")) != "chat.send.accepted") return "";
        var result:Dynamic = Reflect.field(value, "result");
        if (result == null || Reflect.field(result, "success") != true) return "";
        var carrier:Dynamic = Reflect.field(result, "targetUserId");
        return Std.isOfType(carrier, String) ? cast carrier : "";
    }

    /** ZFE failures carry the stable machine code in error.code. */
    public static function asyncErrorCode(raw:String):String {
        var value:Dynamic = parseObject(raw);
        if (value == null) return "";
        var error:Dynamic = Reflect.field(value, "error");
        var code:Dynamic = error == null ? null : Reflect.field(error, "code");
        if (code == null) code = Reflect.field(value, "code");
        return code == null ? "" : Std.string(code);
    }

    static function parseObject(raw:String):Dynamic {
        if (raw == null || raw.length == 0) return null;
        // Fallout's Scaleform runtime does not provide Flash's native JSON parser.
        // Ruffle does, which allowed the async ZFE receipt
        // tests to pass while the same branch returned requestId=0 in-game. Reuse the
        // bounded, exception-free reader already proven by the auth/outbox paths.
        var start:Int = skipWhitespace(raw, 0);
        if (raw.charAt(start) != "{") return null;
        var end:Int = raw.length - 1;
        while (end >= start) {
            var c:Int = raw.charCodeAt(end);
            if (c != 9 && c != 10 && c != 13 && c != 32) break;
            end--;
        }
        if (end <= start || raw.charAt(end) != "}") return null;
        return FcmJson.parse(raw);
    }

    static function positiveInt(value:Dynamic):Int {
        if (value == null) return 0;
        // Request IDs are provider-issued JSON numbers. Do not coerce strings,
        // booleans, fractions, or values outside ActionScript's signed Int range.
        if (Std.isOfType(value, String) || Std.isOfType(value, Bool)) return 0;
        var parsed:Float = Std.parseFloat(Std.string(value));
        return Math.isFinite(parsed) && parsed > 0 && parsed <= 2147483647
            && Math.floor(parsed) == parsed ? Std.int(parsed) : 0;
    }

    /** Native acceptance only: a queued command is not proof of relay delivery.
     * Scan without flash JSON, accepting legacy unquoted keys as well as JSON.
     * Only the outer response's Boolean success may enable the server tab.
     */
    public static function controlAccepted(raw:String):Bool {
        if (raw == null) return false;
        var i:Int = skipWhitespace(raw, 0);
        if (raw.charAt(i) != "{") return false;
        var depth:Int = 0;
        var member:Bool = false;
        while (i < raw.length) {
            var c:String = raw.charAt(i);
            if (c == "{" || c == "[") { depth++; member = depth == 1; i++; continue; }
            if (c == "}" || c == "]") { depth--; member = false; i++; continue; }
            if (c == ",") { member = depth == 1; i++; continue; }
            if (c == " " || c == "\n" || c == "\r" || c == "\t") { i++; continue; }
            var start:Int = i;
            var key:String = "";
            if (c == '"') {
                i++;
                start = i;
                while (i < raw.length && raw.charAt(i) != '"') {
                    if (raw.charAt(i) == "\\") i++;
                    i++;
                }
                key = raw.substring(start, i);
                i++;
            } else {
                while (i < raw.length && isKeyChar(raw.charCodeAt(i))) i++;
                key = raw.substring(start, i);
                if (i == start) i++;
            }
            if (depth == 1 && member && key == "success") {
                var colon:Int = skipWhitespace(raw, i);
                if (raw.charAt(colon) != ":") return false;
                var value:Int = skipWhitespace(raw, colon + 1);
                var end:Int = skipWhitespace(raw, value + 4);
                return raw.substr(value, 4) == "true"
                    && (raw.charAt(end) == "," || raw.charAt(end) == "}");
            }
            member = false;
        }
        return false;
    }

    /**
     * xScal may report a queue-loss marker as an event rather than returning a
     * transport error. Keep this detector independent of the provider so the
     * widget can advance its cursor and leave a useful diagnostic breadcrumb.
     */
    public static function isDroppedEvent(raw:String):Bool {
        if (raw == null) return false;
        // Match the event kind, not an arbitrary body/metadata string. A chat
        // message is allowed to contain the words "events.dropped".
        return raw.indexOf("\"kind\":\"events.dropped\"") >= 0
            || raw.indexOf("\"kind\": \"events.dropped\"") >= 0
            || raw.indexOf("kind:events.dropped") >= 0
            || raw.indexOf("kind: events.dropped") >= 0;
    }

    /**
     * Find the opening bracket of the events array in compact, pretty-printed,
     * quoted-key, or native unquoted-key responses.
     */
    public static function findEventsArrayStart(raw:String):Int {
        if (raw == null) return -1;
        var cursor:Int = 0;
        while (cursor < raw.length) {
            var quotedStart:Int = raw.indexOf('"events"', cursor);
            if (quotedStart >= 0) {
                var quotedColon:Int = skipWhitespace(raw, quotedStart + 8);
                if (quotedColon < raw.length && raw.charAt(quotedColon) == ":") {
                    var quotedArray:Int = skipWhitespace(raw, quotedColon + 1);
                    if (quotedArray < raw.length && raw.charAt(quotedArray) == "[") return quotedArray;
                }
            }

            var keyStart:Int = raw.indexOf("events", cursor);
            if (keyStart < 0) return -1;
            var afterKey:Int = keyStart + 6;
            if ((keyStart == 0 || !isKeyChar(raw.charCodeAt(keyStart - 1)))
                    && (afterKey >= raw.length || !isKeyChar(raw.charCodeAt(afterKey)))
                    && !isInsideQuotedString(raw, keyStart)) {
                var colon:Int = skipWhitespace(raw, afterKey);
                if (colon < raw.length && raw.charAt(colon) == ":") {
                    var arrayStart:Int = skipWhitespace(raw, colon + 1);
                    if (arrayStart < raw.length && raw.charAt(arrayStart) == "[") return arrayStart;
                }
            }
            cursor = afterKey;
        }
        return -1;
    }

    static function isInsideQuotedString(raw:String, at:Int):Bool {
        var quoted:Bool = false;
        var escaped:Bool = false;
        for (i in 0...at) {
            var c:String = raw.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (c == "\\") { escaped = true; continue; }
            if (c == '"') quoted = !quoted;
        }
        return quoted;
    }

    static function isKeyChar(code:Int):Bool {
        return (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122) || code == 95;
    }

    static function skipWhitespace(raw:String, start:Int):Int {
        var i:Int = start;
        while (i < raw.length) {
            var c:Int = raw.charCodeAt(i);
            if (c != 9 && c != 10 && c != 13 && c != 32) break;
            i++;
        }
        return i;
    }
}
