/**
 * Unit tests for FcmCommand. Run: haxe test-command.hxml
 */
class TestFcmCommand {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        check("slash relink", FcmCommand.isRelink("/relink"));
        check("bare relink after slash stripping", FcmCommand.isRelink(" relink "));
        check("case insensitive", FcmCommand.isRelink("/RELINK"));
        check("arguments rejected", !FcmCommand.isRelink("/relink now"));
        check("embedded text rejected", !FcmCommand.isRelink("please relink"));
        check("empty rejected", !FcmCommand.isRelink(""));
        check("null rejected", !FcmCommand.isRelink(null));
        if (failures > 0) Sys.exit(1);
    }
}
