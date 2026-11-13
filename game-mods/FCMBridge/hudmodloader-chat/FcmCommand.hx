/**
 * Pure HUD command matching helpers.
 *
 * Fallout 76 can consume a leading slash while the widget is using the native
 * keyboard path, so commands that are safe to recognize without the slash are
 * deliberately handled here. Keep this module free of Flash imports so it can
 * be exercised by the CI interpreter tests.
 */
class FcmCommand {
    /** Resolve a destination independently of the visible tab. Only standalone unprefixed aliases navigate. */
    public static function channelSubmission(raw:String):{handled:Bool, channelIndex:Int, body:String, selectTab:Bool} {
        var text = raw == null ? "" : StringTools.trim(raw);
        var explicit = text.charAt(0) == "/" || text.charAt(0) == ".";
        var start = explicit ? 1 : 0;
        var end = start;
        while (end < text.length && !StringTools.isSpace(text, end)) end++;
        var body = StringTools.trim(text.substr(end));
        var index = channelShortcutIndex(text.substring(start, end).toLowerCase());
        // Only standalone bare aliases survive slash stripping safely; ordinary prose stays intact.
        if (index < 0 || (!explicit && body.length > 0))
            return {handled:false, channelIndex:-1, body:text, selectTab:false};
        return {handled:true, channelIndex:index, body:body,
            selectTab:!explicit};
    }

    static function channelShortcutIndex(command:String):Int {
        return switch (command) {
            case "g", "gen", "general": 0;
            case "t", "trade", "trading": 1;
            case "e", "event", "events": 2;
            case "i", "inf", "infests": 3;
            case "r", "raid", "raids": 4;
            case "s", "server": 5;
            default: -1;
        };
    }

    /** Native keyboard input may consume the slash; help is a standalone local command. */
    public static function isHelp(raw:String):Bool {
        if (raw == null) return false;
        var command = StringTools.trim(raw).toLowerCase();
        return command == "/help" || command == ".help" || command == "help";
    }

    public static function hudHelp():String {
        return "HUD COMMANDS (private)\n"
            + "/help — show this guide\n"
            + "/g /t /e /i /r /s <message> — send to General, Trading, Events, Infests, Raids, Server\n"
            + "g / t / e / i / r / s alone — select that tab\n"
            + "Channel-prefixed messages keep your current tab; add text after the prefix.\n"
            + "/hide — hide chat; open key restores it\n"
            + "/relink — reset ZFE chat link\n"
            + "/emoji <name> — send a named emoji\n"
            + "/giveaway — show giveaway help\n"
            + "/giveaway start <item> [minutes]\n"
            + "/giveaway list | /giveaway last [count]\n"
            + "/giveaway join <id> | /giveaway leave <id>\n"
            + "/giveaway stop <id>\n"
            + "/event help — show event commands\n"
            + "/mod help — staff commands";
    }

    /** Native keyboard input can consume the leading slash. Keep only this command family. */
    public static function giveawayCommand(raw:String):String {
        if (raw == null) return "";
        var text = StringTools.trim(raw);
        var lower = text.toLowerCase();
        var start = lower.charAt(0) == "/" || lower.charAt(0) == "." ? 1 : 0;
        if (lower.substr(start, 8) != "giveaway") return "";
        var rest = text.substr(start + 8);
        if (rest.length > 0 && rest.charAt(0) != " ") return "";
        return "/giveaway" + rest;
    }

    /** Bare giveaway (or explicit help) is a local, private feed instruction. */
    public static function isGiveawayHelp(raw:String):Bool {
        var command = giveawayCommand(raw);
        if (command.length == 0) return false;
        var rest = StringTools.trim(command.substr(9)).toLowerCase();
        return rest == "" || rest == "help";
    }

    public static function giveawayHelp():String {
        return "GIVEAWAY COMMANDS\n"
            + "giveaway start <item> [minutes] (1-60, default 5)\n"
            + "giveaway list | giveaway last [count]\n"
            + "giveaway join <id> | giveaway leave <id>\n"
            + "giveaway stop <id> (creator or mod)";
    }

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
            case 0x0D: return "Enter";
            case 0x21: return "PageUp";
            case 0x22: return "PageDown";
            case 0x24: return "Home";
            case 0x23: return "End";
            case 0x26: return "ArrowUp";
            case 0x28: return "ArrowDown";
            default: return "";
        }
    }

    /** Convert an INI key token to a Windows virtual-key code for provider polling. */
    public static function virtualKeyCode(raw:String):Int {
        var key:String = normalizeAction(raw);
        // VK_### covers keys whose physical name varies by layout or keyboard.
        // Keep 0 (no key) and 255 (reserved) out of active registrations.
        if (~/^vk[0-9]{1,3}$/.match(key)) {
            var numeric:Null<Int> = Std.parseInt(key.substr(2));
            return numeric != null && numeric > 0 && numeric < 255 ? numeric : 0;
        }
        switch (key) {
            case "insert", "ins": return 0x2D;
            case "delete", "del": return 0x2E;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup", "prevpage", "pgup", "prior": return 0x21;
            case "pagedown", "nextpage", "pgdn", "next": return 0x22;
            case "up", "arrowup": return 0x26;
            case "down", "arrowdown": return 0x28;
            case "left", "arrowleft": return 0x25;
            case "right", "arrowright": return 0x27;
            case "escape", "esc": return 0x1B;
            case "enter", "return": return 0x0D;
            case "tab": return 0x09;
            case "space": return 0x20;
            case "backspace", "back": return 0x08;
            case "capslock", "capital": return 0x14;
            case "numlock": return 0x90;
            case "scrolllock": return 0x91;
            case "printscreen", "snapshot": return 0x2C;
            case "pause": return 0x13;
            case "shift": return 0x10;
            case "leftshift", "lshift": return 0xA0;
            case "rightshift", "rshift": return 0xA1;
            case "control", "ctrl": return 0x11;
            case "leftcontrol", "lcontrol", "lctrl": return 0xA2;
            case "rightcontrol", "rcontrol", "rctrl": return 0xA3;
            case "alt", "menu": return 0x12;
            case "leftalt", "lalt": return 0xA4;
            case "rightalt", "ralt": return 0xA5;
            case "comma", "oemcomma": return 0xBC;
            case "period", "oemperiod": return 0xBE;
            case "semicolon", "oem1": return 0xBA;
            case "equals", "equal", "oemplus": return 0xBB;
            case "minus", "hyphen", "oemminus": return 0xBD;
            case "slash", "forwardslash", "oem2": return 0xBF;
            case "grave", "backtick", "oem3": return 0xC0;
            case "leftbracket", "openbracket", "oem4": return 0xDB;
            case "backslash", "oem5": return 0xDC;
            case "rightbracket", "closebracket", "oem6": return 0xDD;
            case "apostrophe", "quote", "oem7": return 0xDE;
            case "numpadmultiply", "multiply": return 0x6A;
            case "numpadadd", "add": return 0x6B;
            case "numpadsubtract", "subtract": return 0x6D;
            case "numpaddecimal", "decimal": return 0x6E;
            case "numpaddivide", "divide": return 0x6F;
            default:
                if (~/^f([1-9]|1[0-9]|2[0-4])$/.match(key))
                    return 0x6F + Std.parseInt(key.substr(1));
                if (~/^numpad[0-9]$/.match(key))
                    return 0x60 + Std.parseInt(key.substr(6));
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
        return sameAction(action, configured) || samePhysicalKey(action, configured);
    }

    public static function isPreviousChannel(raw:String, configured:String):Bool {
        var action:String = normalizeAction(raw);
        return sameAction(action, configured) || samePhysicalKey(action, configured);
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

    /** Link activation is an editor-owned action, never an idle gameplay hotkey. */
    public static function linkActivationEnabled(raw:String, configured:String,
            inputOpen:Bool, selectedHasLink:Bool):Bool {
        if (!inputOpen || !selectedHasLink) return false;
        var binding:String = StringTools.trim(configured == null ? "" : configured);
        // Enter belongs exclusively to the host editor's submit contract.
        if (virtualKeyCode(binding) == 0x0D) return false;
        return binding.length > 0 && sameAction(normalizeAction(raw), binding);
    }

    /** A configured hide action is inactive while an editor owns keyboard input. */
    public static function configuredHideAction(raw:String, configured:String, inputOpen:Bool):String {
        if (StringTools.trim(configured == null ? "" : configured).length == 0
                || !sameAction(normalizeAction(raw), configured)) return "";
        return inputOpen ? "editor" : "hide";
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
     * SERVER records are room-validated on ingestion and retained only in memory
     * for the current widget/game session when membership changes.
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
     * Bound capability-gated, nonblocking roster controls. Editor ownership must
     * not pause membership renewal. Renew before the 30s cosmetic evidence
     * deadline, leaving headroom for timer drift and private-reply delivery.
     * Fresh observations and provider safety are checked before this scheduler.
     */
    public static function shouldSendRoster(automaticTransportSafe:Bool,
            serverSessionReady:Bool, elapsedSinceSend:Float, hasSent:Bool):Bool {
        if (!automaticTransportSafe) return false;
        if (!hasSent) return true;
        if (serverSessionReady) return elapsedSinceSend >= 10000;
        return elapsedSinceSend >= 10000;
    }

    /** Additive membership evidence; old relays safely treat markers as unmatched peer names. */
    public static function rosterControlBody(selfNames:Array<String>, namesField:String):String {
        var aliases:Array<String> = [];
        if (selfNames != null) for (name in selfNames) {
            var clean = name == null ? "" : StringTools.trim(StringTools.replace(name, "|", ""));
            if (clean.length > 0 && clean.length <= 64 && aliases.indexOf(clean) < 0 && aliases.length < 4) aliases.push(clean);
        }
        if (aliases.length == 0) return "";
        var fields = [for (alias in aliases) "@self:" + alias];
        if (namesField != null && namesField.length > 0) fields = fields.concat(namesField.split("|"));
        return "FCMCTL/1/ROSTER:" + fields.join("|");
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

    static function samePhysicalKey(normalized:String, configured:String):Bool {
        var keyCode:Int = virtualKeyCode(normalized);
        return keyCode > 0 && keyCode == virtualKeyCode(configured);
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

    // =========================================================================
    // Staff /mod commands (pure; the widget owns targets and transport)
    // =========================================================================

    public static inline var MOD_MAX_MINUTES:Int = 43200; // 30 days
    public static inline var MOD_DEFAULT_MUTE_MINUTES:Int = 10;
    /** ZFE-safe carrier in the unused messageId member of account-level actions. */
    public static inline var MOD_ENVELOPE_PREFIX:String = "FCMMOD/1;";
    /** Private relay system body announcing a removed message. */
    public static inline var MOD_DELETE_EVENT_PREFIX:String = "FCMDEL/1;";

    /**
     * Classify one duration token. `none` is not a duration (it starts the reason);
     * `invalid` looks like a duration (leading digit or sign) but is zero, negative,
     * fractional, out of range or has an unknown unit. Units: none/m minutes, h, d, w.
     */
    public static function moderationDuration(raw:String):{kind:String, minutes:Int} {
        var word:String = raw == null ? "" : StringTools.trim(raw).toLowerCase();
        if (word == "perm" || word == "permanent") return {kind:"permanent", minutes:0};
        if (word.length == 0) return {kind:"none", minutes:0};
        var first:Int = word.charCodeAt(0);
        var digit:Int = (first == "-".code || first == "+".code) && word.length > 1 ? word.charCodeAt(1) : first;
        if (digit < "0".code || digit > "9".code) return {kind:"none", minutes:0};
        var re = ~/^([0-9]{1,6})([mhdw]?)$/;
        if (!re.match(word)) return {kind:"invalid", minutes:0};
        var amount:Null<Int> = Std.parseInt(re.matched(1));
        var unit:Int = switch (re.matched(2)) { case "h": 60; case "d": 1440; case "w": 10080; default: 1; };
        if (amount == null || amount <= 0 || amount > MOD_MAX_MINUTES) return {kind:"invalid", minutes:0};
        var minutes:Int = amount * unit;
        if (minutes > MOD_MAX_MINUTES) return {kind:"invalid", minutes:0};
        return {kind:"minutes", minutes:minutes};
    }

    /**
     * Parse `<action> [duration] <reason>` after the target. A mute without a duration uses
     * the 10-minute default; a ban needs a duration or an explicit `perm`, so a forgotten
     * duration can never become a permanent ban. A non-duration token starts the reason.
     */
    public static function parseModerationAction(actionWord:String, rest:String):
            {action:String, minutes:Int, permanent:Bool, reason:String, error:String} {
        var verb:String = actionWord == null ? "" : StringTools.trim(actionWord).toLowerCase();
        var tail:String = rest == null ? "" : StringTools.trim(rest);
        var action:String = switch (verb) {
            case "delete": "deleteMessage";
            case "kick": "kickUser";
            case "mute": "muteUser";
            case "unmute": "unmuteUser";
            case "ban": "banUser";
            case "unban": "unbanUser";
            default: "";
        };
        var result = {action:action, minutes:0, permanent:false, reason:tail, error:""};
        if (action.length == 0) { result.error = "help"; return result; }
        if (action == "muteUser" || action == "banUser") {
            var split:Int = 0;
            while (split < tail.length && !StringTools.isSpace(tail, split)) split++;
            var duration = moderationDuration(tail.substr(0, split));
            var afterDuration:String = StringTools.trim(tail.substr(split));
            if (action == "muteUser") {
                switch (duration.kind) {
                    case "minutes": result.minutes = duration.minutes; result.reason = afterDuration;
                    case "none": result.minutes = MOD_DEFAULT_MUTE_MINUTES;
                    case "permanent": result.error = "Mutes cannot be permanent. Use ban perm instead.";
                    default: result.error = "Mute duration must be 1 minute to 30 days, e.g. 30, 30m, 2h, 1d.";
                }
            } else {
                switch (duration.kind) {
                    case "minutes": result.minutes = duration.minutes; result.reason = afterDuration;
                    case "permanent": result.permanent = true; result.reason = afterDuration;
                    case "none": result.error = "Ban needs a duration (30m, 2h, 1d, 1w) or perm before the reason.";
                    default: result.error = "Ban duration must be 1 minute to 30 days (30m, 2h, 1d, 1w) or perm.";
                }
            }
            if (result.error.length > 0) return result;
        }
        if (StringTools.trim(result.reason).length == 0) result.error = "A moderation reason is required.";
        return result;
    }

    public static function moderationHelp():String {
        return "HUD MODERATION\n"
            + "Use an exact visible name (quote names with spaces), or [#XXXXXXXX]:\n"
            + "/mod Alice mute [duration] <reason>  (default 10m)\n"
            + "/mod Alice ban <duration|perm> <reason>\n"
            + "/mod \"Alice Smith\" kick <reason>\n"
            + "/mod #ref delete <reason>\n"
            + "/mod Alice unmute <reason> | /mod Alice unban <reason>\n"
            + "Durations: 30 or 30m, 2h, 1d, 1w (max 30d). perm = permanent ban.\n"
            + "Unban/unmute also accept an exact account name with no visible message.\n"
            + "Server messages cannot be deleted. Slow mode is not available.";
    }

    /**
     * Short visible reference for a message ID. Persisted rows use the UUID prefix; Server
     * rows (`server:r:<room>:<seq>`) share a long common prefix, so they use `s` plus the
     * last seven sequence characters (never hex, so never confused with a UUID prefix).
     */
    public static function moderationReference(messageId:String):String {
        if (messageId == null || messageId.length == 0) return "";
        var id:String = messageId.toLowerCase();
        if (StringTools.startsWith(id, "server:")) {
            var tail:String = id.substr(id.lastIndexOf(":") + 1);
            var clean:String = "";
            for (i in 0...tail.length) {
                var c:Int = tail.charCodeAt(i);
                if ((c >= "0".code && c <= "9".code) || (c >= "a".code && c <= "z".code)) clean += tail.charAt(i);
            }
            if (clean.length == 0) return "";
            while (clean.length < 7) clean = "0" + clean;
            return "s" + clean.substr(clean.length - 7);
        }
        return id.length >= 8 ? id.substr(0, 8) : "";
    }

    /** True for an FCM account UUID (the only target ID the relay accepts). */
    public static function isAccountId(value:String):Bool {
        return value != null && ~/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.match(value);
    }

    /** `FCMMOD/1;` messageId carrier for durations, explicit permanence and by-name targets. */
    public static function moderationEnvelope(minutes:Int, permanent:Bool, targetName:String):String {
        var fields:Array<String> = [];
        if (permanent) fields.push("p=1");
        else if (minutes > 0) fields.push("d=" + minutes);
        if (targetName != null && StringTools.trim(targetName).length > 0)
            fields.push("n=" + StringTools.urlEncode(StringTools.trim(targetName)));
        return fields.length == 0 ? "" : MOD_ENVELOPE_PREFIX + fields.join(";");
    }

    /** Message ID removed by a private `FCMDEL/1;m=<id>` relay event, or "" for other bodies. */
    public static function deletedMessageId(body:String):String {
        if (body == null || !StringTools.startsWith(body, MOD_DELETE_EVENT_PREFIX)) return "";
        for (field in body.substr(MOD_DELETE_EVENT_PREFIX.length).split(";")) {
            if (!StringTools.startsWith(field, "m=")) continue;
            try {
                var id:String = StringTools.urlDecode(field.substr(2));
                return id.length > 0 && id.length <= 128 ? id : "";
            } catch (_:Dynamic) {
                return "";
            }
        }
        return "";
    }

    /** Player-facing text for a relay or provider moderation failure; unknown codes stay generic. */
    public static function moderationErrorText(code:String, message:String):String {
        switch (code == null ? "" : code) {
            case "permission_denied": return "Moderation denied. Your linked staff role may have changed.";
            case "protected_target": return "Staff members cannot be moderated from the HUD. Use Discord.";
            case "already_banned": return "That player is already banned. Unban first to change the ban.";
            case "not_banned": return "That player has no active ban.";
            case "target_not_found": return "No FCM player has that exact name.";
            case "ambiguous_target": return "More than one FCM player has that name. Use [#XXXXXXXX] from a visible message.";
            case "message_not_found": return "That message was not found or was already deleted.";
            case "unsupported_target": return "Server messages are temporary and cannot be deleted. Kick, mute or ban the sender instead.";
            case "invalid_duration":
                return "Invalid duration" + (message != null && message.length > 0 ? ": " + message : ".");
            case "moderation_unavailable": return "Moderation is temporarily unavailable. Try again shortly.";
            case "unsupported_command", "unsupported", "not_supported":
                return "Moderation is not supported by this chat provider.";
            case "rate_limited": return "Too many moderation requests. Try again shortly.";
            case "user_banned", "user_kicked": return "Chat session ended - reconnecting...";
            default:
        }
        if (message != null && message.length > 0) return "Moderation failed: " + message;
        if (code != null && code.length > 0) return "Moderation failed: " + code;
        return "Moderation failed.";
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
