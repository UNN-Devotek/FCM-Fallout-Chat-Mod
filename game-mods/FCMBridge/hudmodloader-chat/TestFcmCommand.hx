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
        check("social shortcut is an external input action", FcmCommand.isExternalInputAction("OpenSocial"));
        check("friends action is an external input action", FcmCommand.isExternalInputAction("OpenFriendList"));
        check("quick action is an external input action", FcmCommand.isExternalInputAction("QuickActionsMenu"));
        check("external action does not match channel navigation", !FcmCommand.isExternalInputAction("NextPage"));
        check("native session selects native close path",
            FcmCommand.externalInputClosePath(true, true, "OpenSocial") == "native");
        check("shared editor session selects SharedHUDTools close path",
            FcmCommand.externalInputClosePath(true, false, "OpenSocial") == "shared");
        check("closed input ignores external action",
            FcmCommand.externalInputClosePath(false, false, "OpenSocial") == "");
        check("disjoint roster forces a new server session",
            FcmCommand.shouldRebindRosterSession("Ada|Beck", "Cy|Dana"));
        check("overlapping roster stays in the current server session",
            !FcmCommand.shouldRebindRosterSession("Ada|Beck", "Ada|Cy"));
        check("empty roster clears the previous server session",
            FcmCommand.shouldRebindRosterSession("Ada|Beck", ""));
        check("initial roster does not force a rebind",
            !FcmCommand.shouldRebindRosterSession("", "Ada"));
        check("bare true after a successful clear is an empty native buffer",
            FcmCommand.nativeInputBufferIsClear("true", "true"));
        check("a rejected clear does not admit an empty native buffer",
            !FcmCommand.nativeInputBufferIsClear("", "false"));
        check("real text after a successful clear is not empty",
            !FcmCommand.nativeInputBufferIsClear("hello", "true"));
        check("repeated one-character reads are accumulated",
            FcmCommand.mergeNativeInputText("he", "e") == "hee");
        if (failures > 0) Sys.exit(1);
    }
}
