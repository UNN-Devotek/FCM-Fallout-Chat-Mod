/** Small, Flash-free helpers for the native chat.v1 wire format. */
class FcmWire {
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
