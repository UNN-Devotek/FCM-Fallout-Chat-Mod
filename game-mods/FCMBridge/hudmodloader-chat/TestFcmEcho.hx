/** Unit tests for optimistic chat echo reconciliation. Run: haxe test-echo.hxml */
class TestFcmEcho {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        check("same relay id matches", FcmEcho.matches("", "relay-1", "global", "hello",
            "", "relay-1", "global", "hello", "relay-1", "native-1"));
        check("identity transition matches", FcmEcho.matches("", "relay-1", "global", "hello",
            "", "native-1", "global", "hello", "relay-1", "native-1"));
        check("empty incoming identity matches local pending row", FcmEcho.matches("", "", "global", "hello",
            "", "native-1", "global", "hello", "relay-1", "native-1"));
        check("different sender does not consume identical text", !FcmEcho.matches("", "other-1", "global", "hello",
            "", "native-1", "global", "hello", "relay-1", "native-1"));
        check("different body does not match", !FcmEcho.matches("", "relay-1", "global", "different",
            "", "native-1", "global", "hello", "relay-1", "native-1"));
        check("message id is strongest match", FcmEcho.matches("m-1", "other-1", "global", "hello",
            "m-1", "native-1", "global", "hello", "relay-1", "native-1"));
        if (failures > 0) Sys.exit(1);
    }
}
