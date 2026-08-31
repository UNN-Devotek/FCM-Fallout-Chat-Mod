/**
 * FcmConfig — the FCMChatWidget user-config model + parser (CAP-001..005, #303/#304).
 *
 * Pure: NO flash imports, so it is unit-testable under `haxe --interp`
 * (see TestFcmConfig.hx / test-config.hxml). FCMChatWidget calls FcmConfig.parse()
 * on the `Data/FCMChat.ini` text and reads the typed, clamped fields from it,
 * instead of the old `static inline var` constants + inline parseIni().
 *
 * Colors are stored as Int 0xRRGGBB. Defaults reproduce today's amber Pip-Boy look.
 * Every value is clamped/defaulted on parse so a malformed config can never crash or
 * push the panel off-screen (CAP-009).
 */
class FcmConfig {

    /** Immutable supporter marker. The HUD never renders a client-supplied glyph. */
    public static inline var SUPPORTER_STAR_GLYPH:String = "★";

    // ── HUD viewport (HUDModLoader fixed 1920x1080 space) ──────────────────────
    public static inline var VIEW_W:Int = 1920;
    public static inline var VIEW_H:Int = 1080;

    // ── Geometry + font ────────────────────────────────────────────────────────
    public var x:Int            = 10;
    public var y:Int            = 10;
    public var width:Int        = 400;
    public var height:Int       = 260;
    public var fontSize:Int     = 14;

    // ── Colors (0xRRGGBB) + opacity ────────────────────────────────────────────
    public var bgColor:Int          = 0x0A0907;
    public var bgAlpha:Float        = 0.94;
    public var borderColor:Int      = 0xF5CB5B;
    public var textColor:Int        = 0xFAF4DA;
    public var senderColor:Int      = 0xF5CB5B;
    public var channelTagColor:Int  = 0x8FBC8F;
    public var tabActiveColor:Int   = 0xF5CB5B;
    public var tabInactiveColor:Int = 0xB49544;
    public var promptColor:Int      = 0xAC9043;
    public var tabRowColor:Int      = 0x080705;

    // ── Per-channel colors — mirror the website chat_rooms.color (pulled from PROD
    //    2026-06-28). Drive the channel sub-tabs + the [Channel] message tag so each
    //    channel renders in its website color. Overridable in FCMChat.ini
    //    (colorGeneral / colorTrading / colorEvents / colorInfests / colorRaids /
    //    colorServer). Option A will overwrite these at runtime from relay-fed live
    //    colors once in-game chat connects (channelColor() is the read point).
    public var chanColorGlobal:Int  = 0x1ABAFF;   // General
    public var chanColorTrade:Int   = 0x008F37;   // Trading
    public var chanColorEvents:Int  = 0xC88A51;   // Events
    public var chanColorInfests:Int = 0x5ABD0A;   // Infests
    public var chanColorRaids:Int   = 0xCE0909;   // Raids
    public var chanColorServer:Int  = 0xECBB51;   // Server / world (Fallout 76 parent)

    // ── Limits ─────────────────────────────────────────────────────────────────
    public var maxMessages:Int  = 100;
    public var maxSendLen:Int   = 225;

    // Event-poll interval (ms). Each poll opens a fresh wss connection — a full TLS handshake
    // (~120ms under Wine/Proton) — so a low value churns handshakes and can stutter the game.
    // Higher = smoother but slower message refresh. Clamped 1000..60000. (The real fix is ZFE
    // reusing its persistent connection for polls; until then this is the lag knob.)
    public var pollMs:Int       = 5000;

    // Auto-hide: hide the panel after this many seconds of no activity; reveal on a new message.
    // 0 disables auto-hide (always visible). Toggled live from the F11 menu.
    public var autoHideSec:Int  = 60;

    // ── Keybinds ───────────────────────────────────────────────────────────────
    // openKey = the ONE native ZFE key (free-choice; ZFE reads it via isChatKeyPressed).
    // channelNext/Prev + hide map to FO76 control-map ACTIONS the loader forwards.
    public var openKey:String        = "INSERT";
    public var channelNextKey:String = "NextPage";
    public var channelPrevKey:String = "PrevPage";
    public var hideKey:String        = "";        // unset = use /hide or the F11 menu

    // ── Feed toggles ───────────────────────────────────────────────────────────
    public var showChannelTag:Bool  = true;
    public var showHints:Bool       = false;      // blank idle prompt by default (CAP-014)

    // ── Link flow ────────────────────────────────────────────────────────────────
    // URL shown in the widget's link prompt (linkHint fallback). DEV builds set this to
    // dev.falloutchatmod.com/link via FCMChat.ini; prod uses the default. URL-safe charset
    // only (it is interpolated into htmlText — crash rule #2; invalid -> default).
    public var linkUrl:String       = "falloutchatmod.com/link";

    // Deliverable FO76 control-map actions a HUD-layer widget can actually receive.
    static var ACTIONS:Array<String> =
        ["NextPage", "PrevPage", "Console", "ConsoleToggles", "TeamChat", "DiagnosticSnapshot"];

    public function new() {}

    /** Restore every user setting while retaining the build environment's link destination. */
    public static function resetToDefaults(current:FcmConfig):FcmConfig {
        var defaults:FcmConfig = new FcmConfig();
        if (current != null) defaults.linkUrl = current.linkUrl;
        return defaults;
    }

    /** Decode the escaped `text` member returned by ZFE readStorage. */
    public static function decodeJsonText(s:String):String {
        if (s == null) return "";
        var out:StringBuf = new StringBuf();
        var i:Int = 0;
        while (i < s.length) {
            var c:String = s.charAt(i);
            if (c != "\\" || i + 1 >= s.length) {
                out.add(c);
                i++;
                continue;
            }
            var n:String = s.charAt(i + 1);
            switch (n) {
                case "n": out.add("\n");
                case "r": out.add("\r");
                case "t": out.add("\t");
                case "\"": out.add("\"");
                case "\\": out.add("\\");
                default: out.add("\\" + n);
            }
            i += 2;
        }
        return out.toString();
    }

    /**
     * Per-channel tag/sub-tab color, mirroring the website's chat_rooms.color.
     * Unknown/empty slug -> channelTagColor (generic fallback). Option A will set the
     * chanColor* fields from relay-fed live colors once in-game chat connects.
     */
    public function channelColor(slug:String):Int {
        if (slug == null) return channelTagColor;
        switch (StringTools.trim(slug).toLowerCase()) {
            case "global":  return chanColorGlobal;
            case "trade":   return chanColorTrade;
            case "events":  return chanColorEvents;
            case "infests": return chanColorInfests;
            case "raids":   return chanColorRaids;
            case "server":  return chanColorServer;
        }
        return channelTagColor;
    }

    // ── Pure helpers ───────────────────────────────────────────────────────────

    /** Parse a color: accepts "#RRGGBB", "RRGGBB", or "0xRRGGBB". Invalid -> fallback. */
    public static function parseHexColor(s:String, fallback:Int):Int {
        if (s == null) return fallback;
        var t:String = StringTools.trim(s);
        if (t.length == 0) return fallback;
        if (t.charAt(0) == "#") {
            t = t.substr(1);
        } else if (t.length >= 2 && t.charAt(0) == "0" && (t.charAt(1) == "x" || t.charAt(1) == "X")) {
            t = t.substr(2);
        }
        if (!(~/^[0-9a-fA-F]{6}$/.match(t))) return fallback;
        var v:Null<Int> = Std.parseInt("0x" + t);
        return (v == null) ? fallback : v;
    }

    /** Parse a server-provided cosmetic colour, failing closed to the HUD theme. */
    public static function supporterStarColor(s:String, fallback:Int):Int {
        return parseHexColor(s, fallback);
    }

    /** Dim a color toward black by `factor` (0..1) — used for inactive channel sub-tabs. */
    public static function dimColor(c:Int, factor:Float):Int {
        var f:Float = (factor < 0) ? 0.0 : (factor > 1 ? 1.0 : factor);
        var r:Int = Std.int(((c >> 16) & 0xFF) * f);
        var g:Int = Std.int(((c >> 8)  & 0xFF) * f);
        var b:Int = Std.int(( c        & 0xFF) * f);
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Proper-cased channel name for a slug (CAP-012, D-09). Known slugs map to their
     * canonical label; an unknown slug falls back to a Title-Case of itself.
     */
    public static function chanLabel(slug:String):String {
        if (slug == null) return "";
        var s:String = StringTools.trim(slug);
        if (s.length == 0) return "";
        switch (s.toLowerCase()) {
            case "global":  return "General";
            case "trade":   return "Trading";
            case "events":  return "Events";
            case "infests": return "Infests";
            case "raids":   return "Raids";
            case "server":  return "Server";
        }
        var lo:String = s.toLowerCase();
        return lo.charAt(0).toUpperCase() + lo.substr(1);
    }

    /**
     * Escape user-controlled text (chat body, sender name, in-progress input) before it
     * is interpolated into a Scaleform GFx `htmlText` string. The relay does NOT sanitize
     * message content or display names (SR-001), so a message containing &, < or > would
     * otherwise crash the GFx htmlText parser (crash rule #2 — HUD-wide render break) or
     * inject markup that spoofs another sender's name/color. Uses NUMERIC character refs
     * only (named entities like &amp; can trip the GFx parser; numeric refs such as
     * &#x203A; are proven safe). `&` is escaped first so the refs we emit aren't re-encoded.
     */
    public static function htmlEscape(s:String):String {
        if (s == null) return "";
        s = StringTools.replace(s, "&", "&#38;");
        s = StringTools.replace(s, "<", "&#60;");
        s = StringTools.replace(s, ">", "&#62;");
        s = StringTools.replace(s, "\"", "&#34;");
        return s;
    }

    public static function clampInt(v:Int, lo:Int, hi:Int):Int {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    public static function clampFloat(v:Float, lo:Float, hi:Float):Float {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    public static function parseBool(s:String, fallback:Bool):Bool {
        if (s == null) return fallback;
        var t:String = StringTools.trim(s).toLowerCase();
        if (t == "true" || t == "1" || t == "yes" || t == "on") return true;
        if (t == "false" || t == "0" || t == "no" || t == "off") return false;
        return fallback;
    }

    /** Parse an int with fallback (Std.parseInt returns null on garbage). */
    static function parseIntOr(s:String, fallback:Int):Int {
        if (s == null) return fallback;
        var v:Null<Int> = Std.parseInt(StringTools.trim(s));
        return (v == null) ? fallback : v;
    }

    static function parseFloatOr(s:String, fallback:Float):Float {
        if (s == null) return fallback;
        var v:Float = Std.parseFloat(StringTools.trim(s));
        return Math.isNaN(v) ? fallback : v;
    }

    /** Validate a control-map action; invalid -> fallback ("" = unset for hideKey). */
    static function validAction(s:String, fallback:String):String {
        if (s == null) return fallback;
        var t:String = StringTools.trim(s);
        if (t.length == 0) return fallback;
        for (a in ACTIONS) if (a == t) return t;
        return fallback;
    }

    // ── Parse the [FCMChat] section of an INI string into a clamped config ──────

    public static function parse(raw:String):FcmConfig {
        var cfg:FcmConfig = new FcmConfig();
        if (raw == null) return cfg;

        var lines:Array<String> = raw.split("\n");
        var inSection:Bool = false;
        for (rawLine in lines) {
            var l:String = StringTools.trim(rawLine);
            if (l.length == 0 || l.charAt(0) == ";") continue;
            if (l == "[FCMChat]") { inSection = true; continue; }
            if (l.charAt(0) == "[") { inSection = false; continue; }
            if (!inSection) continue;
            var eq:Int = l.indexOf("=");
            if (eq < 0) continue;
            var key:String = StringTools.trim(l.substr(0, eq)).toLowerCase();
            var val:String = StringTools.trim(l.substr(eq + 1));

            switch (key) {
                case "x":               cfg.x = parseIntOr(val, cfg.x);
                case "y":               cfg.y = parseIntOr(val, cfg.y);
                case "width":           cfg.width = parseIntOr(val, cfg.width);
                case "height":          cfg.height = parseIntOr(val, cfg.height);
                case "fontsize":        cfg.fontSize = parseIntOr(val, cfg.fontSize);
                case "bgcolor":         cfg.bgColor = parseHexColor(val, cfg.bgColor);
                case "bgalpha":         cfg.bgAlpha = parseFloatOr(val, cfg.bgAlpha);
                case "bordercolor":     cfg.borderColor = parseHexColor(val, cfg.borderColor);
                case "textcolor":       cfg.textColor = parseHexColor(val, cfg.textColor);
                case "sendercolor":     cfg.senderColor = parseHexColor(val, cfg.senderColor);
                case "channeltagcolor": cfg.channelTagColor = parseHexColor(val, cfg.channelTagColor);
                case "colorgeneral":    cfg.chanColorGlobal = parseHexColor(val, cfg.chanColorGlobal);
                case "colortrading":    cfg.chanColorTrade = parseHexColor(val, cfg.chanColorTrade);
                case "colorevents":     cfg.chanColorEvents = parseHexColor(val, cfg.chanColorEvents);
                case "colorinfests":    cfg.chanColorInfests = parseHexColor(val, cfg.chanColorInfests);
                case "colorraids":      cfg.chanColorRaids = parseHexColor(val, cfg.chanColorRaids);
                case "colorserver":     cfg.chanColorServer = parseHexColor(val, cfg.chanColorServer);
                case "tabactivecolor":  cfg.tabActiveColor = parseHexColor(val, cfg.tabActiveColor);
                case "tabinactivecolor": cfg.tabInactiveColor = parseHexColor(val, cfg.tabInactiveColor);
                case "promptcolor":     cfg.promptColor = parseHexColor(val, cfg.promptColor);
                case "tabrowcolor":     cfg.tabRowColor = parseHexColor(val, cfg.tabRowColor);
                case "maxmessages":     cfg.maxMessages = parseIntOr(val, cfg.maxMessages);
                case "maxsendlen":      cfg.maxSendLen = parseIntOr(val, cfg.maxSendLen);
                case "pollms":          cfg.pollMs = parseIntOr(val, cfg.pollMs);
                case "autohidesec":     cfg.autoHideSec = parseIntOr(val, cfg.autoHideSec);
                case "openkey":
                    // openKey is interpolated into htmlText (idle prompt) — restrict to a safe key
                    // token; anything with &/</> etc. falls back to default (crash rule #2 guard).
                    var ok:String = StringTools.trim(val);
                    cfg.openKey = (ok.length > 0 && ~/^[A-Za-z0-9_]+$/.match(ok)) ? ok : cfg.openKey;
                case "channelnextkey":  cfg.channelNextKey = validAction(val, cfg.channelNextKey);
                case "channelprevkey":  cfg.channelPrevKey = validAction(val, cfg.channelPrevKey);
                case "hidekey":         cfg.hideKey = validAction(val, "");
                case "showchanneltag":  cfg.showChannelTag = parseBool(val, cfg.showChannelTag);
                case "showhints":       cfg.showHints = parseBool(val, cfg.showHints);
                case "linkurl":
                    // URL-safe charset only — interpolated into htmlText (crash rule #2).
                    var lu:String = StringTools.trim(val);
                    cfg.linkUrl = (lu.length > 0 && ~/^[A-Za-z0-9._:\/-]+$/.match(lu)) ? lu : cfg.linkUrl;
                default: // unknown key — ignore
            }
        }

        cfg.clamp();
        return cfg;
    }

    /** Clamp every numeric value to a safe range; keep the panel on-screen. */
    public function clamp():Void {
        // Size first (x/y bounds depend on it).
        width    = clampInt(width, 200, VIEW_W);
        height   = clampInt(height, 120, VIEW_H);
        x        = clampInt(x, 0, VIEW_W - width);
        y        = clampInt(y, 0, VIEW_H - height);
        fontSize = clampInt(fontSize, 8, 47);          // GFx glyph cache < 48
        bgAlpha  = clampFloat(bgAlpha, 0.0, 1.0);
        maxMessages = clampInt(maxMessages, 10, 500);
        maxSendLen  = clampInt(maxSendLen, 1, 500);     // server hard cap 500
        pollMs      = clampInt(pollMs, 1000, 60000);    // 1s..60s event-poll interval
        autoHideSec = clampInt(autoHideSec, 0, 600);    // 0 = off, else 1s..10min
    }

    /** Serialize back to the [FCMChat] INI (for F11 Customize persistence via ZFE storage).
        Outputs EVERY field so a round-trip never drops settings (linkUrl, keys, per-channel colors). */
    public function toIni():String {
        var h = function(c:Int):String return StringTools.hex(c & 0xFFFFFF, 6);
        var b = function(v:Bool):String return v ? "true" : "false";
        var s = new StringBuf();
        s.add("[FCMChat]\n");
        s.add("x=" + x + "\n");                 s.add("y=" + y + "\n");
        s.add("width=" + width + "\n");         s.add("height=" + height + "\n");
        s.add("fontSize=" + fontSize + "\n");
        s.add("bgColor=" + h(bgColor) + "\n");  s.add("bgAlpha=" + bgAlpha + "\n");
        s.add("borderColor=" + h(borderColor) + "\n");
        s.add("textColor=" + h(textColor) + "\n");
        s.add("senderColor=" + h(senderColor) + "\n");
        s.add("channelTagColor=" + h(channelTagColor) + "\n");
        s.add("tabActiveColor=" + h(tabActiveColor) + "\n");
        s.add("tabInactiveColor=" + h(tabInactiveColor) + "\n");
        s.add("promptColor=" + h(promptColor) + "\n");
        s.add("tabRowColor=" + h(tabRowColor) + "\n");
        s.add("colorGeneral=" + h(chanColorGlobal) + "\n");
        s.add("colorTrading=" + h(chanColorTrade) + "\n");
        s.add("colorEvents=" + h(chanColorEvents) + "\n");
        s.add("colorInfests=" + h(chanColorInfests) + "\n");
        s.add("colorRaids=" + h(chanColorRaids) + "\n");
        s.add("colorServer=" + h(chanColorServer) + "\n");
        s.add("maxMessages=" + maxMessages + "\n");
        s.add("maxSendLen=" + maxSendLen + "\n");
        s.add("pollMs=" + pollMs + "\n");
        s.add("autoHideSec=" + autoHideSec + "\n");
        s.add("openKey=" + openKey + "\n");
        s.add("channelNextKey=" + channelNextKey + "\n");
        s.add("channelPrevKey=" + channelPrevKey + "\n");
        s.add("hideKey=" + hideKey + "\n");
        s.add("showChannelTag=" + b(showChannelTag) + "\n");
        s.add("showHints=" + b(showHints) + "\n");
        s.add("linkUrl=" + linkUrl + "\n");
        return s.toString();
    }
}
