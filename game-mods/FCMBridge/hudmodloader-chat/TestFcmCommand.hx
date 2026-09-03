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
        check("arrow up scrolls feed up", FcmCommand.scrollDirection("ArrowUp") == -1);
        check("bare down scrolls feed down", FcmCommand.scrollDirection("Down") == 1);
        check("underscore arrow alias scrolls", FcmCommand.scrollDirection("arrow_down") == 1);
        check("home jumps to newest", FcmCommand.isScrollToBottom("Home"));
        check("end jumps to newest", FcmCommand.isScrollToBottom("End"));
        check("page down selects next channel", FcmCommand.isNextChannel("Page Down", "NextPage"));
        check("page up selects previous channel", FcmCommand.isPreviousChannel("Page Up", "PrevPage"));
        check("ordinary action does not scroll", FcmCommand.scrollDirection("NextPage") == 0);
        if (failures > 0) Sys.exit(1);
    }
}
