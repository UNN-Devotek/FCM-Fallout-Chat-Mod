/** Bounded JSON reader without native JSON or Haxe exception-class dependencies. */
class FcmJson {
    var source:String;
    var pos:Int = 0;
    var bad:Bool = false;
    function new(source:String) { this.source = source; }
    public static function parse(source:String):Dynamic {
        if (source == null || source.length > 262144) return null;
        var reader = new FcmJson(source);
        var value = reader.value(0);
        reader.space();
        return reader.bad || reader.pos != source.length ? null : value;
    }
    function space():Void {
        while (pos < source.length && " \r\n\t".indexOf(source.charAt(pos)) >= 0) pos++;
    }
    function fail():Dynamic { bad = true; return null; }
    function value(depth:Int):Dynamic {
        space();
        if (bad || depth > 32 || pos >= source.length) return fail();
        var c = source.charAt(pos);
        if (c == '"') return string();
        if (c == "{" || c == "[") {
            pos++;
            var object = c == "{";
            var result:Dynamic = object ? {} : [];
            var close = object ? "}" : "]";
            space();
            if (source.charAt(pos) == close) { pos++; return result; }
            while (!bad && pos < source.length) {
                var key:String = "";
                if (object) {
                    space();
                    if (source.charAt(pos) != '"') return fail();
                    key = string(); space();
                    if (source.charAt(pos++) != ":") return fail();
                }
                var item = value(depth + 1);
                if (bad) return null;
                if (object) Reflect.setField(result, key, item);
                else { var array:Array<Dynamic> = cast result; array.push(item); }
                space();
                var end = source.charAt(pos++);
                if (end == close) return result;
                if (end != ",") return fail();
            }
            return fail();
        }
        for (literal in ["true", "false", "null"]) {
            if (source.substr(pos, literal.length) == literal) {
                pos += literal.length;
                if (literal == "null") return null;
                return literal == "true";
            }
        }
        var start = pos;
        if (source.charAt(pos) == "-") pos++;
        if (source.charAt(pos) == "0") pos++;
        else {
            if (!digit(source.charAt(pos)) || source.charAt(pos) == "0") return fail();
            while (digit(source.charAt(pos))) pos++;
        }
        if (source.charAt(pos) == ".") {
            pos++;
            if (!digit(source.charAt(pos))) return fail();
            while (digit(source.charAt(pos))) pos++;
        }
        if (source.charAt(pos) == "e" || source.charAt(pos) == "E") {
            pos++;
            if (source.charAt(pos) == "+" || source.charAt(pos) == "-") pos++;
            if (!digit(source.charAt(pos))) return fail();
            while (digit(source.charAt(pos))) pos++;
        }
        var number = Std.parseFloat(source.substring(start, pos));
        return Math.isFinite(number) ? number : fail();
    }
    static function digit(c:String):Bool { return c.length == 1 && c >= "0" && c <= "9"; }
    function string():String {
        pos++;
        var out = new StringBuf();
        while (pos < source.length) {
            var c = source.charAt(pos++);
            if (c == '"') return out.toString();
            if (c.charCodeAt(0) < 32) { fail(); return ""; }
            if (c != "\\") { out.add(c); continue; }
            var escape = source.charAt(pos++);
            switch (escape) {
                case '"', "\\", "/": out.add(escape);
                case "b": out.addChar(8);
                case "f": out.addChar(12);
                case "n": out.addChar(10);
                case "r": out.addChar(13);
                case "t": out.addChar(9);
                case "u":
                    var code = 0;
                    for (_ in 0...4) {
                        var h = source.charAt(pos++).toLowerCase();
                        var n = h.length == 1 ? "0123456789abcdef".indexOf(h) : -1;
                        if (n < 0) { fail(); return ""; }
                        code = code * 16 + n;
                    }
                    out.addChar(code);
                default: fail(); return "";
            }
        }
        fail(); return "";
    }
}
