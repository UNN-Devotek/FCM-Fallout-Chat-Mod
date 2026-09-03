/**
 * Pure HUD command matching helpers.
 *
 * Fallout 76 can consume a leading slash while the widget is using the native
 * keyboard path, so commands that are safe to recognize without the slash are
 * deliberately handled here. Keep this module free of Flash imports so it can
 * be exercised by the CI interpreter tests.
 */
class FcmCommand {
    /**
     * True only for the standalone relink command. A trailing argument is not
     * accepted, so arbitrary chat text cannot accidentally clear auth state.
     */
    public static function isRelink(raw:String):Bool {
        if (raw == null) return false;
        var command:String = StringTools.trim(raw).toLowerCase();
        return command == "/relink" || command == "relink";
    }

    /** Map loader action names to feed scroll direction: -1 up, +1 down, 0 other. */
    public static function scrollDirection(raw:String):Int {
        var action:String = normalizeAction(raw);
        if (action == "up" || action == "arrowup" || action == "cursorup" || action == "dpadup") return -1;
        if (action == "down" || action == "arrowdown" || action == "cursordown" || action == "dpaddown") return 1;
        return 0;
    }

    /** Home/End both mean "show the newest messages" when the feed is idle. */
    public static function isScrollToBottom(raw:String):Bool {
        var action:String = normalizeAction(raw);
        return action == "home" || action == "end" || action == "scrolltoend" || action == "scrollbottom";
    }

    public static function isNextChannel(raw:String, configured:String):Bool {
        var action:String = normalizeAction(raw);
        return sameAction(action, configured) || action == "nextpage" || action == "pagedown";
    }

    public static function isPreviousChannel(raw:String, configured:String):Bool {
        var action:String = normalizeAction(raw);
        return sameAction(action, configured) || action == "prevpage" || action == "pageup";
    }

    static function sameAction(normalized:String, configured:String):Bool {
        return configured != null && normalized.length > 0 && normalized == normalizeAction(configured);
    }

    /** Stable key for the per-press navigation latch in the widget. */
    public static function actionKey(raw:String):String {
        return normalizeAction(raw);
    }

    static function normalizeAction(raw:String):String {
        if (raw == null) return "";
        return StringTools.trim(raw).toLowerCase().split(" ").join("").split("_").join("").split("-").join("");
    }
}
