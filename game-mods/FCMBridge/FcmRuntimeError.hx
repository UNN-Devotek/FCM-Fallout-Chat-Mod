/** Shared, bounded VM error diagnostics. No exception message or stack leaves this parser. */
class FcmRuntimeError {
    public static function errorCode(error:Dynamic):String {
        var value:Dynamic = FcmRoster.field(error, "errorID");
        if (!Std.isOfType(value, Float)) return "error";
        var number:Float = value;
        if (!Math.isFinite(number) || number < 1 || number > 99999 || Math.floor(number) != number) return "error";
        return "E" + Std.int(number);
    }
    /** Only a class identifier from the exact E1014 template may leave this boundary. */
    public static function missingClass(error:Dynamic):String {
        if (errorCode(error) != "E1014") return "";
        var value:Dynamic = FcmRoster.field(error, "message");
        if (!Std.isOfType(value, String)) return "not reported";
        var message:String = value;
        if (message.length > 160) return "not reported";
        var prefix = "Class ";
        if (StringTools.startsWith(message, "Error #1014: ")) message = message.substr(13);
        var suffix = " could not be found.";
        if (!StringTools.startsWith(message, prefix) || !StringTools.endsWith(message, suffix)) return "not reported";
        var name = message.substr(prefix.length, message.length - prefix.length - suffix.length);
        if (name.length == 0 || name.length > 80) return "not reported";
        for (i in 0...name.length) {
            var c = name.charCodeAt(i);
            var letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 36;
            if (!letter && (i == 0 || !((c >= 48 && c <= 57) || c == 46 || c == 58))) return "not reported";
        }
        return name;
    }
}
