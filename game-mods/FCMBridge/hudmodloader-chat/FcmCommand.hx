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

    /**
     * True when Fallout is about to hand keyboard focus to another modal input surface.
     * OpenSocial is the named action emitted for the in-game Ctrl+Tab social shortcut;
     * the token matching also covers loader/game-version aliases for quick actions and
     * the friends list. These actions must be handled before normal widget navigation.
     */
    public static function isExternalInputAction(raw:String):Bool {
        var action:String = normalizeAction(raw);
        return action == "escape" || action == "cancel"
            || action.indexOf("quick") >= 0
            || action.indexOf("friend") >= 0
            || action.indexOf("social") >= 0;
    }

    /**
     * Choose the input owner that must be closed before an external modal opens.
     * Keeping this decision pure prevents the native and SharedHUDTools paths from
     * drifting back into separate focus-handling rules.
     */
    public static function externalInputClosePath(inputOpen:Bool, nativeInput:Bool, action:String):String {
        if (!inputOpen || !isExternalInputAction(action)) return "";
        return nativeInput ? "native" : "shared";
    }

    /**
     * True when a roster update cannot be the same world session as the last
     * acknowledged roster. The relay derives a room from roster sightings, so
     * an empty or completely disjoint roster must be preceded by LEAVE; otherwise
     * the relay can keep the subscriber bound to the previous room and no new
     * server history is replayed.
     */
    public static function shouldRebindRosterSession(previousNamesField:String, currentNamesField:String):Bool {
        var previous:Array<String> = rosterNames(previousNamesField);
        if (previous.length == 0) return false;
        var current:Array<String> = rosterNames(currentNamesField);
        if (current.length == 0) return true;
        for (name in current) {
            if (previous.indexOf(name) >= 0) return false;
        }
        return true;
    }

    /**
     * `readChatInput` is documented as text, but supported ZFE builds return a
     * bare boolean while the freshly-cleared buffer is empty. Accept that status
     * response only when `clearChatInput` also succeeded; real text remains text.
     */
    public static function nativeInputBufferIsClear(readRaw:String, clearRaw:String):Bool {
        var read:String = StringTools.trim(readRaw == null ? "" : readRaw).toLowerCase();
        var clear:String = StringTools.trim(clearRaw == null ? "" : clearRaw).toLowerCase();
        var clearSucceeded:Bool = clear == "true" || clear == "1"
            || clear.indexOf('"success":true') >= 0;
        // Fail closed when the clear operation was rejected or unsupported. An empty read
        // alone is not proof that this widget owns a clean native buffer; accepting it would
        // recreate the one-character/fallback regression on a partially implemented bridge.
        if (!clearSucceeded) return false;
        return read.length == 0 || read == "true" || read == "false" || read == "1" || read == "0";
    }

    /**
     * Compatibility accumulator for providers that expose only the newest
     * character. The native ZFE path normally returns a cumulative buffer; in
     * that case the multi-character value replaces the draft. A one-character
     * value is a delta and is appended, including when it repeats the previous
     * character (the old suffix check dropped `hello` + `l`).
     */
    public static function mergeNativeInputText(previous:String, observed:String):String {
        var before:String = previous == null ? "" : previous;
        var current:String = observed == null ? "" : observed;
        if (current.length == 0) return "";
        if (before.length > 0 && current.length == 1) return before + current;
        return current;
    }

    static function rosterNames(field:String):Array<String> {
        var out:Array<String> = [];
        if (field == null || StringTools.trim(field).length == 0) return out;
        for (raw in StringTools.trim(field).split("|")) {
            var name:String = StringTools.trim(raw).toLowerCase();
            if (name.length > 0 && out.indexOf(name) < 0) out.push(name);
        }
        return out;
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
