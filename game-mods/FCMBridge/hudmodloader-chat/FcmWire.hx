/** Small, Flash-free helpers for the native chat.v1 wire format. */
class FcmWire {
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
