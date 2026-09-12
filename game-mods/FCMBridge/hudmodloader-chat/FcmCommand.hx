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

    /**
     * Map a loader action to feed scroll direction: -1 up, +1 down, 0 other.
     *
     * The configured values are replacements for the default Up/Down actions. The
     * directional aliases remain equivalent, so `scrollUpKey=Up` accepts Up,
     * ArrowUp, CursorUp, and DpadUp on loaders that use a different spelling.
     * An empty configured value disables that direction.
     */
    public static function scrollDirection(raw:String, configuredUp:String = "Up", configuredDown:String = "Down"):Int {
        if (matchesScrollBinding(raw, configuredUp)) return -1;
        if (matchesScrollBinding(raw, configuredDown)) return 1;
        return 0;
    }

    /**
     * Map the Windows virtual-key codes polled through ZFE/xScal's documented
     * Input.* surface to the same canonical actions used by HUDModLoader.
     * Keeping this mapping pure makes the physical fallback testable without
     * a live Scaleform runtime.
     */
    public static function physicalKeyAction(keyCode:Int):String {
        switch (keyCode) {
            case 0x21: return "PageUp";
            case 0x22: return "PageDown";
            case 0x24: return "Home";
            case 0x23: return "End";
            case 0x26: return "ArrowUp";
            case 0x28: return "ArrowDown";
            default: return "";
        }
    }

    /** Convert an openKey token to a Windows virtual-key code for xScal polling. */
    public static function virtualKeyCode(raw:String):Int {
        var key:String = normalizeAction(raw);
        switch (key) {
            case "insert", "ins": return 0x2D;
            case "delete", "del": return 0x2E;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup", "pgup", "prior": return 0x21;
            case "pagedown", "pgdn", "next": return 0x22;
            case "up", "arrowup": return 0x26;
            case "down", "arrowdown": return 0x28;
            case "left", "arrowleft": return 0x25;
            case "right", "arrowright": return 0x27;
            case "escape", "esc": return 0x1B;
            case "tab": return 0x09;
            case "space": return 0x20;
            case "f1": return 0x70;
            case "f2": return 0x71;
            case "f3": return 0x72;
            case "f4": return 0x73;
            case "f5": return 0x74;
            case "f6": return 0x75;
            case "f7": return 0x76;
            case "f8": return 0x77;
            case "f9": return 0x78;
            case "f10": return 0x79;
            case "f11": return 0x7A;
            case "f12": return 0x7B;
            default:
                if (key.length == 1) {
                    var code:Int = key.charCodeAt(0);
                    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
                        return code >= 97 ? code - 32 : code;
                    }
                }
                return 0;
        }
    }

    /** Match the optional user-selected action that returns the feed to newest. */
    public static function isScrollToBottom(raw:String, configured:String = ""):Bool {
        return matchesScrollBinding(raw, configured);
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
     * Classify a named HUD action without entering a persistent navigation mode.
     *
     * The widget receives control-map actions in the same stage as the text editor. Keeping
     * this classification pure makes it impossible for an ordinary character/Unmapped event to
     * fall through into channel selection. The returned value is intentionally a one-shot command.
     */
    public static function navigationAction(raw:String, nextChannel:String, previousChannel:String,
            configuredScrollUp:String = "Up", configuredScrollDown:String = "Down",
            configuredScrollBottom:String = ""):String {
        var scroll:Int = scrollDirection(raw, configuredScrollUp, configuredScrollDown);
        if (scroll < 0) return "feed-up";
        if (scroll > 0) return "feed-down";
        if (isScrollToBottom(raw, configuredScrollBottom)) return "feed-bottom";
        if (isNextChannel(raw, nextChannel)) return "next-channel";
        if (isPreviousChannel(raw, previousChannel)) return "previous-channel";
        return "";
    }

    /**
     * Resolve a physical virtual-key code to the action token used by navigationAction.
     * Built-in channel/arrow aliases are returned first; configured xScal/ZFE physical
     * tokens fill in additional keys such as F12 or a letter. Duplicate bindings follow
     * navigationAction's up, down, bottom precedence.
     */
    public static function physicalNavigationAction(keyCode:Int, configuredScrollUp:String,
            configuredScrollDown:String, configuredScrollBottom:String):String {
        var builtIn:String = physicalKeyAction(keyCode);
        if (builtIn.length > 0) return builtIn;
        if (virtualKeyCode(configuredScrollUp) == keyCode && keyCode > 0) return configuredScrollUp;
        if (virtualKeyCode(configuredScrollDown) == keyCode && keyCode > 0) return configuredScrollDown;
        if (virtualKeyCode(configuredScrollBottom) == keyCode && keyCode > 0) return configuredScrollBottom;
        return "";
    }

    /** Feed navigation is scoped to an active, visible Insert-open editor session. */
    public static function feedNavigationEnabled(inputOpen:Bool, hidden:Bool):Bool {
        return inputOpen && !hidden;
    }

    /** A latched action has already been handled; this accepts key-up-only loaders as well. */
    public static function navigationEdgeIsNew(alreadyLatched:Bool):Bool {
        return !alreadyLatched;
    }

    /**
     * Normalize the key-edge field emitted by HUDModLoader variants.
     *
     * The documented field is a boolean, but some loader bridges expose the
     * value as 1/0 or as a descriptive string. Treat unknown values as a key
     * release so an unfamiliar payload cannot repeatedly trigger navigation.
     */
    public static function eventIsDown(raw:Dynamic):Bool {
        if (raw == true || raw == 1) return true;
        if (raw == null) return false;
        var value:String = StringTools.trim(Std.string(raw)).toLowerCase();
        return value == "true" || value == "1" || value == "down"
            || value == "keydown" || value == "pressed";
    }

    /**
     * True when Fallout is about to hand keyboard focus to another modal input surface.
     * OpenSocial is the named action emitted for the in-game Ctrl+Tab social shortcut;
     * the token matching also covers loader/game-version aliases for quick actions and
     * the friends list. These actions must be handled before normal widget navigation.
     */
    public static function acceptsInputCallback(open:Bool, current:Int, callback:Int):Bool {
        return open && current == callback;
    }

    /**
     * General is a view of the six public HUD feeds. Records keep their source channel,
     * so tab switching, self-echo matching and replay guards share one canonical row.
     * SERVER records are room-validated on ingestion and cleared on leave.
     */
    public static function channelVisible(active:String, channel:String):Bool {
        switch (channel) {
            case "global", "server", "trade", "events", "infests", "raids":
                return active == "global" || active == channel;
            default: return false;
        }
    }

    public static function isExternalInputAction(raw:String):Bool {
        var action:String = normalizeAction(raw);
        return action == "escape" || action == "cancel" || action == "pipboy"
            || action.indexOf("quick") >= 0
            || action.indexOf("friend") >= 0
            || action.indexOf("social") >= 0
            || action == "controltab"
            || action == "ctrltab";
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

    /**
     * Infer whether a native input provider returns a cumulative buffer or one-character
     * deltas. The provider contract changed between ZFE builds, so this decision is made from
     * two logical reads and then held for the lifetime of the edit session.
     */
    public static function detectNativeInputMode(previousObserved:String, observed:String,
            currentMode:String):String {
        if (currentMode == "cumulative" || currentMode == "delta") return currentMode;
        var before:String = previousObserved == null ? "" : previousObserved;
        var current:String = observed == null ? "" : observed;
        if (before.length == 0 || current.length == 0) return "unknown";
        if (current.length > before.length && StringTools.startsWith(current, before)) {
            return "cumulative";
        }
        if (before.length == 1 && current.length == 1 && before != current) return "delta";
        return "unknown";
    }

    /**
     * Merge one parsed native read using the detected provider mode. Keep the old helper above
     * for legacy callers/tests; new callers must supply the prior observed value so a cumulative
     * provider never turns the second character into an accidental append.
     */
    public static function mergeNativeInputTextWithMode(previous:String, previousObserved:String,
            observed:String, currentMode:String):String {
        var before:String = previous == null ? "" : previous;
        var priorRead:String = previousObserved == null ? "" : previousObserved;
        var current:String = observed == null ? "" : observed;
        if (current.length == 0) return "";

        // Some native builds report backspace as a control character rather than a shorter
        // cumulative buffer. Treat it as an edit operation in either mode.
        if (current == String.fromCharCode(8)
                || current == String.fromCharCode(127)) {
            return before.length > 0 ? before.substr(0, before.length - 1) : "";
        }

        var mode:String = detectNativeInputMode(priorRead, current, currentMode);
        if (mode == "cumulative") return current;
        if (mode == "delta") return before + current;

        // Before the mode is known, a growing value with the previous value as its prefix is
        // cumulative; a changed one-character value is a delta. Otherwise fail closed and use
        // the provider's value rather than manufacturing text.
        if (priorRead.length > 0 && current.length >= priorRead.length
                && StringTools.startsWith(current, priorRead)) return current;
        if (priorRead.length == 1 && current.length == 1 && priorRead != current) {
            return before + current;
        }
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

    static function matchesScrollBinding(raw:String, configured:String):Bool {
        var action:String = normalizeAction(raw);
        var target:String = normalizeAction(configured);
        if (action.length == 0 || target.length == 0) return false;
        if (action == target) return true;
        var actionGroup:String = scrollAliasGroup(action);
        var targetGroup:String = scrollAliasGroup(target);
        if (actionGroup.length > 0 && actionGroup == targetGroup) return true;
        // The physical provider emits canonical tokens (PageDown/ArrowUp), while
        // configuration may use aliases (PGDN/Up), including reversed directions.
        var keyCode:Int = virtualKeyCode(action);
        return keyCode > 0 && keyCode == virtualKeyCode(target);
    }

    static function scrollAliasGroup(action:String):String {
        switch (action) {
            case "up", "arrowup", "cursorup", "dpadup": return "up";
            case "down", "arrowdown", "cursordown", "dpaddown": return "down";
            default: return "";
        }
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
