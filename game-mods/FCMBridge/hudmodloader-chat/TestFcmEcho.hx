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
        // The relay event identifies the author by the linked FCM account UUID, while
        // the widget's authenticated session owns a separate relay-text user id.
        check("linked account id reconciles relay identity", FcmEcho.matches("message-1",
            "fcm-account-1", "global", "hello", "", "relay-user-1", "global", "hello",
            "relay-user-1", "native-1", "fcm-account-1"));
        check("foreign linked account does not consume identical text", !FcmEcho.matches("message-2",
            "fcm-account-2", "global", "hello", "", "relay-user-1", "global", "hello",
            "relay-user-1", "native-1", "fcm-account-1"));
        var placement = FcmStarLayout.betweenChannelAndAuthor(96.0, 42.0, 16.0, 13.0, 4.0);
        check("star starts after measured channel tag", placement.x == 100.0);
        check("star is middle-aligned to author bounds", placement.y == 43.5);
        if (failures > 0) Sys.exit(1);
    }
}
