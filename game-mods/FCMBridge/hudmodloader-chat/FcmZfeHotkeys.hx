typedef FcmZfeHotkeyRegistration = {
    var success:Bool;
    var registration:Dynamic;
}

/** Pure key normalization and response decoding for ZFE hotkeys.v1. */
class FcmZfeHotkeys {
    static function field(value:Dynamic, key:String):Dynamic {
        try { return value == null ? null : Reflect.field(value, key); } catch (_:Dynamic) { return null; }
    }

    public static function keyName(token:String):String {
        var code = FcmCommand.virtualKeyCode(token);
        if (code >= 0x41 && code <= 0x5A) return String.fromCharCode(code);
        if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
        if (code >= 0x70 && code <= 0x7B) return "F" + (code - 0x6F);
        return switch (code) {
            case 0x20: "SPACE";
            case 0x09: "TAB";
            case 0x2D: "INSERT";
            case 0x2E: "DELETE";
            case 0x24: "HOME";
            case 0x23: "END";
            case 0x21: "PAGEUP";
            case 0x22: "PAGEDOWN";
            default: "";
        };
    }

    public static function registerPayload(vendor:String, key:String):String {
        return haxe.Json.stringify({vendor:vendor, key:key, shift:false, ctrl:false, alt:false});
    }

    public static function registration(raw:Dynamic):FcmZfeHotkeyRegistration {
        var parsed = FcmJson.parse(Std.string(raw));
        var token = field(parsed, "registration");
        return {success:field(parsed, "success") == true && token != null, registration:token};
    }

    public static function presses(raw:Dynamic, expected:Dynamic):Int {
        var parsed = FcmJson.parse(Std.string(raw));
        if (field(parsed, "success") != true) return -1;
        // ZFE's public poll contract returns success and presses; unlike register,
        // it does not promise to echo the opaque registration. Validate an echo
        // when one is present, but do not discard a successful documented reply.
        var returned = field(parsed, "registration");
        if (returned != null && !FcmZfeInput.sameSession(expected, returned)) return -1;
        var count = Std.parseInt(Std.string(field(parsed, "presses")));
        return count == null || count < 0 ? -1 : count;
    }

    public static function tokenPayload(vendor:String, registration:Dynamic):String {
        return haxe.Json.stringify({vendor:vendor, registration:registration});
    }
}
