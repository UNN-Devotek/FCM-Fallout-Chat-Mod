class TestFcmZfeHotkeys {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    static function main():Void {
        check("normalizes supported configured keys", FcmZfeHotkeys.keyName("INSERT") == "INSERT"
            && FcmZfeHotkeys.keyName("PrevPage") == "PAGEUP"
            && FcmZfeHotkeys.keyName("f12") == "F12"
            && FcmZfeHotkeys.keyName("q") == "Q");
        check("rejects unsupported arrow and enter keys", FcmZfeHotkeys.keyName("Up") == ""
            && FcmZfeHotkeys.keyName("Enter") == "");
        var reg = FcmZfeHotkeys.registration('{"success":true,"registration":17}');
        check("retains opaque registration", reg.success && reg.registration == 17);
        check("accepts matching edge count", FcmZfeHotkeys.presses(
            '{"success":true,"registration":17,"presses":2}', 17) == 2);
        check("rejects stale registration", FcmZfeHotkeys.presses(
            '{"success":true,"registration":18,"presses":1}', 17) == -1);
        Sys.println("FCM ZFE owner-scoped hotkey tests passed");
    }
}
