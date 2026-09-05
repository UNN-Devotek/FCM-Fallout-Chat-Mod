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
        check("physical Page Up maps to previous channel", FcmCommand.physicalKeyAction(0x21) == "PageUp");
        check("physical Page Down maps to next channel", FcmCommand.physicalKeyAction(0x22) == "PageDown");
        check("physical Up maps to feed scroll", FcmCommand.physicalKeyAction(0x26) == "ArrowUp");
        check("physical Down maps to feed scroll", FcmCommand.physicalKeyAction(0x28) == "ArrowDown");
        check("unknown physical key is ignored", FcmCommand.physicalKeyAction(0x70) == "");
        check("home jumps to newest", FcmCommand.isScrollToBottom("Home"));
        check("end jumps to newest", FcmCommand.isScrollToBottom("End"));
        check("page down selects next channel", FcmCommand.isNextChannel("Page Down", "NextPage"));
        check("page up selects previous channel", FcmCommand.isPreviousChannel("Page Up", "PrevPage"));
        check("ordinary action does not scroll", FcmCommand.scrollDirection("NextPage") == 0);
        check("page down is a one-shot next-channel command",
            FcmCommand.navigationAction("Page Down", "NextPage", "PrevPage") == "next-channel");
        check("page up is a one-shot previous-channel command",
            FcmCommand.navigationAction("Page Up", "NextPage", "PrevPage") == "previous-channel");
        check("arrow navigation is classified as feed-only",
            FcmCommand.navigationAction("ArrowUp", "NextPage", "PrevPage") == "feed-up");
        check("ordinary text never enters channel selection",
            FcmCommand.navigationAction("A", "NextPage", "PrevPage") == "");
        check("Unmapped never enters channel selection",
            FcmCommand.navigationAction("Unmapped", "NextPage", "PrevPage") == "");
        check("feed navigation requires an open editor",
            FcmCommand.feedNavigationEnabled(true, false));
        check("feed navigation is disabled while idle",
            !FcmCommand.feedNavigationEnabled(false, false));
        check("feed navigation is disabled while hidden",
            !FcmCommand.feedNavigationEnabled(true, true));
        check("first navigation edge is new",
            FcmCommand.navigationEdgeIsNew(false));
        check("latched navigation edge is ignored",
            !FcmCommand.navigationEdgeIsNew(true));
        check("boolean key-down edge is accepted", FcmCommand.eventIsDown(true));
        check("numeric key-down edge is accepted", FcmCommand.eventIsDown(1));
        check("string key-down edge is accepted", FcmCommand.eventIsDown("true"));
        check("descriptive key-down edge is accepted", FcmCommand.eventIsDown("pressed"));
        check("boolean key-up edge is released", !FcmCommand.eventIsDown(false));
        check("unknown key edge fails closed", !FcmCommand.eventIsDown("unknown"));
        var nativeEvent:Dynamic = new TestHudUserEvent("PageDown", true);
        check("native HUD event getter exposes action", FcmUserEvent.action(nativeEvent) == "PageDown");
        check("native HUD event getter exposes key edge", FcmUserEvent.isDown(nativeEvent));
        var releasedEvent:Dynamic = new TestHudUserEvent("PageUp", false);
        check("native HUD event getter exposes key release", !FcmUserEvent.isDown(releasedEvent));
        var dynamicEvent:Dynamic = { actionName: "NextPage", isDown: true };
        check("dynamic HUD event fields remain supported", FcmUserEvent.action(dynamicEvent) == "NextPage"
            && FcmUserEvent.isDown(dynamicEvent));
        check("social shortcut is an external input action", FcmCommand.isExternalInputAction("OpenSocial"));
        check("friends action is an external input action", FcmCommand.isExternalInputAction("OpenFriendList"));
        check("quick action is an external input action", FcmCommand.isExternalInputAction("QuickActionsMenu"));
        check("Control-Tab alias is an external input action", FcmCommand.isExternalInputAction("Control-Tab"));
        check("CtrlTab alias is an external input action", FcmCommand.isExternalInputAction("CtrlTab"));
        check("external action does not match channel navigation", !FcmCommand.isExternalInputAction("NextPage"));
        check("native session selects native close path",
            FcmCommand.externalInputClosePath(true, true, "OpenSocial") == "native");
        check("shared editor session selects SharedHUDTools close path",
            FcmCommand.externalInputClosePath(true, false, "OpenSocial") == "shared");
        check("closed input ignores external action",
            FcmCommand.externalInputClosePath(false, false, "OpenSocial") == "");
        check("disjoint roster forces a new server session",
            FcmCommand.shouldRebindRosterSession("Ada|Beck", "Cy|Dana"));
        check("an unchanged empty auxiliary roster does not trigger repeated leave/join",
            !FcmCommand.shouldRebindRosterSession("", ""));
        check("a stable provider snapshot does not trigger a world hop",
            !FcmCommand.shouldRebindRosterSession("Ada|Beck", "Ada|Beck"));
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
        check("cumulative native reads are detected",
            FcmCommand.detectNativeInputMode("h", "he", "unknown") == "cumulative");
        check("cumulative native reads replace the draft",
            FcmCommand.mergeNativeInputTextWithMode("h", "h", "he", "unknown") == "he");
        check("delta native reads are detected",
            FcmCommand.detectNativeInputMode("h", "e", "unknown") == "delta");
        check("delta native reads append a changed character",
            FcmCommand.mergeNativeInputTextWithMode("h", "h", "e", "unknown") == "he");
        check("delta native reads preserve repeated characters",
            FcmCommand.mergeNativeInputTextWithMode("he", "e", "e", "delta") == "hee");
        check("native backspace removes one draft character",
            FcmCommand.mergeNativeInputTextWithMode("hello", "o", String.fromCharCode(8), "delta") == "hell");
        if (failures > 0) Sys.exit(1);
    }
}

private class TestHudUserEvent {
    var _eventName:String;
    var _isKeyDown:Bool;

    public function new(eventName:String, isKeyDown:Bool) {
        _eventName = eventName;
        _isKeyDown = isKeyDown;
    }

    public var EventName(get, never):String;
    function get_EventName():String return _eventName;

    public var IsKeyDown(get, never):Bool;
    function get_IsKeyDown():Bool return _isKeyDown;
}
