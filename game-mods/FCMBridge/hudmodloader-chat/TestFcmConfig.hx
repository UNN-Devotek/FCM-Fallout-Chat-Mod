/**
 * Unit tests for FcmConfig — the pure config parser/clamp unit (CAP-001..005, #303/#304).
 * Run: haxe test-config.hxml   (compiles with --interp, no flash deps)
 *
 * Minimal hand-rolled assert harness (utest/munit not in the toolchain). Non-zero exit
 * on any failure so CI fails the step.
 */
class TestFcmConfig {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }
    static function eqi(name:String, got:Int, want:Int):Void {
        check(name + " (got=" + got + " want=" + want + ")", got == want);
    }
    static function eqs(name:String, got:String, want:String):Void {
        check(name + " (got=" + got + " want=" + want + ")", got == want);
    }
    static function eqb(name:String, got:Bool, want:Bool):Void {
        check(name + " (got=" + got + " want=" + want + ")", got == want);
    }

    static function main():Void {
        // ── parseHexColor: accepts #RRGGBB / RRGGBB / 0xRRGGBB; invalid -> fallback ──
        eqi("hex #RRGGBB",       FcmConfig.parseHexColor("#F5CB5B", 0), 0xF5CB5B);
        eqi("hex RRGGBB",        FcmConfig.parseHexColor("F5CB5B", 0),  0xF5CB5B);
        eqi("hex 0xRRGGBB",      FcmConfig.parseHexColor("0xF5CB5B", 0), 0xF5CB5B);
        eqi("hex whitespace",    FcmConfig.parseHexColor("  #0A0907 ", 0), 0x0A0907);
        eqi("hex bad->fallback", FcmConfig.parseHexColor("nope", 0x123456), 0x123456);
        eqi("hex short->fallbk", FcmConfig.parseHexColor("#FFF", 0x123456), 0x123456);
        eqi("hex empty->fallbk", FcmConfig.parseHexColor("", 0x111111), 0x111111);
        eqi("hex null->fallbk",  FcmConfig.parseHexColor(null, 0x222222), 0x222222);
        // Supporter transport parsing and vector-render color selection share the same
        // validation path. The SWF draws the marker as geometry, never as a Unicode glyph.
        eqb("supporter marker accepts server flag", FcmConfig.supporterStarPresent(true, ""), true);
        eqb("supporter marker accepts validated colour", FcmConfig.supporterStarPresent(false, "#FD4DA6"), true);
        eqb("supporter marker rejects unsafe colour", FcmConfig.supporterStarPresent(false, "url(evil)"), false);
        eqi("supporter color validates server value", FcmConfig.supporterStarColor("#FD4DA6", 0), 0xFD4DA6);
        eqi("supporter color falls back safely", FcmConfig.supporterStarColor("url(evil)", 0xF5CB5B), 0xF5CB5B);
        var hudWire:String = "FCMHUD/1;m=m-1;s=1;c=%23FD4DA6;t=X%3BY";
        eqs("HUD transport decodes message id", FcmConfig.hudTransportMessageId(hudWire), "m-1");
        eqb("HUD transport recognizes prefix", FcmConfig.hudTransportHasStar(hudWire), true);
        eqs("HUD transport decodes tag", FcmConfig.hudTransportTag(hudWire), "X;Y");
        eqs("HUD transport validates color", FcmConfig.hudTransportStarColor(hudWire), "#FD4DA6");
        eqs("HUD name color carrier", FcmConfig.hudTransportNameColor("FCMHUD/1;n=%23FF8800"), "#FF8800");
        eqs("HUD rejects invalid name color", FcmConfig.hudTransportNameColor("FCMHUD/1;n=url%28evil%29"), "");
        eqb("HUD transport rejects ordinary target", FcmConfig.hudTransportHasStar("user_123"), false);
        eqs("HUD transport rejects invalid color",
            FcmConfig.hudTransportStarColor("FCMHUD/1;c=url%28evil%29"), "");
        eqs("json string compact", FcmConfig.extractJsonString('{"tag":"X"}', "tag"), "X");
        eqs("json string whitespace", FcmConfig.extractJsonString('{ "tag" : \"X\" }', "tag"), "X");
        eqs("json string newline whitespace", FcmConfig.extractJsonString('{\n tag\t:\n \"X\"\n}', "tag"), "X");
        eqs("json string escaped quote", FcmConfig.extractJsonString('{"tag":"a\\\"b"}', "tag"), "a\\\"b");
        eqs("custom emoji markup becomes readable shortcode",
            FcmConfig.normalizeDiscordEmojiMarkup("hello <:vaultboy:123456789012345678>"),
            "hello :vaultboy:");
        eqs("animated custom emoji markup drops the numeric id",
            FcmConfig.normalizeDiscordEmojiMarkup("<a:wave:987654321098765432>"), ":wave:");
        eqs("multiple custom emoji tokens normalize",
            FcmConfig.normalizeDiscordEmojiMarkup("<:one:123456789012345678> <a:two:987654321098765432>"),
            ":one: :two:");
        eqs("malformed custom emoji stays unchanged",
            FcmConfig.normalizeDiscordEmojiMarkup("<:bad-name:123456789012345678>"),
            "<:bad-name:123456789012345678>");
        eqb("json bool compact", FcmConfig.extractJsonBool('{"supporterStar":true}', "supporterStar"), true);
        eqb("json bool whitespace", FcmConfig.extractJsonBool('{ "supporterStar" : true }', "supporterStar"), true);
        eqb("json bool unquoted native", FcmConfig.extractJsonBool('{supporterStar: true}', "supporterStar"), true);
        eqb("json bool numeric native", FcmConfig.extractJsonBool('{supporterStar: 1}', "supporterStar"), true);
        eqb("json bool false", FcmConfig.extractJsonBool('{"supporterStar":false}', "supporterStar"), false);
        eqb("json bool body key is ignored", FcmConfig.extractJsonBool('{"body":"supporterStar: true"}', "supporterStar"), false);
        eqb("json bool quoted body key is ignored", FcmConfig.extractJsonBool('{"body":"\\"supporterStar\\":true"}', "supporterStar"), false);

        // ── clampInt / clampFloat ──
        eqi("clampInt below", FcmConfig.clampInt(5, 10, 20), 10);
        eqi("clampInt above", FcmConfig.clampInt(99, 10, 20), 20);
        eqi("clampInt within", FcmConfig.clampInt(15, 10, 20), 15);
        check("clampFloat below", FcmConfig.clampFloat(-1.0, 0.0, 1.0) == 0.0);
        check("clampFloat above", FcmConfig.clampFloat(9.0, 0.0, 1.0) == 1.0);
        check("clampFloat within", FcmConfig.clampFloat(0.5, 0.0, 1.0) == 0.5);

        // ── parseBool ──
        eqb("bool true",   FcmConfig.parseBool("true", false), true);
        eqb("bool false",  FcmConfig.parseBool("false", true), false);
        eqb("bool 1",      FcmConfig.parseBool("1", false), true);
        eqb("bool bad->fb", FcmConfig.parseBool("xyz", true), true);

        // ── defaults (empty INI) = today's look + locked keybinds ──
        var d = FcmConfig.parse("");
        eqi("default x", d.x, 10);
        eqi("default y", d.y, 10);
        eqi("default width", d.width, 400);
        eqi("default height", d.height, 260);
        eqi("default fontSize", d.fontSize, 14);
        eqi("default input height", d.effectiveInputHeight(), 28);
        eqi("default shared input font", d.effectiveInputFontSize(), 14);
        eqi("default native input font", d.effectiveInputFontSize(true), 13);
        var input = FcmConfig.parse("[FCMChat]\ninputHeight=48\ninputFontSize=24\nfontSize=16\n");
        eqi("independent input height", input.effectiveInputHeight(), 48);
        eqi("independent input font", input.effectiveInputFontSize(), 24);
        eqi("native input font override", input.effectiveInputFontSize(true), 24);
        eqi("feed font unchanged", input.fontSize, 16);
        eqs("input settings survive save", FcmConfig.parse(input.toIni()).toIni(), input.toIni());
        var inherited = FcmConfig.parse("[FCMChat]\nfontSize=22\ninputFontSize=0\n");
        eqi("inherit feed font", inherited.effectiveInputFontSize(), 22);
        eqi("input grows to fit text", inherited.effectiveInputHeight(), 32);
        var invalidInput = FcmConfig.parse("[FCMChat]\ninputHeight=no\ninputFontSize=no\n");
        eqi("invalid input height defaults", invalidInput.inputHeight, 28);
        eqi("invalid input font inherits", invalidInput.inputFontSize, 0);
        var small = FcmConfig.parse("[FCMChat]\nheight=120\ninputHeight=999\ninputFontSize=999\n");
        eqi("input height cap", small.inputHeight, 120);
        eqi("input glyph cap", small.inputFontSize, 47);
        eqi("small panel reserves feed", small.effectiveInputHeight(), 50);
        eqi("small panel fits font", small.effectiveInputFontSize(), 40);
        small.height = 260;
        eqi("resize restores requested height", small.effectiveInputHeight(), 120);
        eqi("resize restores requested font", small.effectiveInputFontSize(), 47);
        var low = FcmConfig.parse("[FCMChat]\ninputHeight=-1\ninputFontSize=-1\n");
        eqi("input height minimum", low.inputHeight, 28);
        eqi("input font minimum", low.inputFontSize, 8);
        eqi("reset input height", FcmConfig.resetToDefaults(input).inputHeight, 28);
        eqi("reset input font", FcmConfig.resetToDefaults(input).inputFontSize, 0);

        eqi("default autoHideSec", d.autoHideSec, 60);
        eqi("default bgColor", d.bgColor, 0x0A0907);
        eqi("default borderColor", d.borderColor, 0xF5CB5B);
        eqi("default textColor", d.textColor, 0xFAF4DA);
        eqi("default channelTagColor", d.channelTagColor, 0x8FBC8F);
        check("default bgAlpha", d.bgAlpha == 0.94);
        eqi("default maxMessages", d.maxMessages, 200);
        eqi("default maxSendLen", d.maxSendLen, 225);
        eqi("default pollMs", d.pollMs, 5000);
        eqi("parse pollMs", FcmConfig.parse("[FCMChat]\npollMs=8000\n").pollMs, 8000);
        eqi("clamp pollMs min", FcmConfig.parse("[FCMChat]\npollMs=10\n").pollMs, 1000);
        eqi("clamp pollMs max", FcmConfig.parse("[FCMChat]\npollMs=999999\n").pollMs, 60000);
        eqs("default openKey", d.openKey, "INSERT");
        // openKey is interpolated into htmlText (idle prompt) — must be a safe key token
        // ([A-Za-z0-9_]); anything else falls back to default (crash rule #2, htmlText injection).
        eqs("openKey safe kept", FcmConfig.parse("[FCMChat]\nopenKey=PAGE_DOWN\n").openKey, "PAGE_DOWN");
        eqs("openKey unsafe->default", FcmConfig.parse("[FCMChat]\nopenKey=<b>&x\n").openKey, "INSERT");
        eqs("default channelNextKey", d.channelNextKey, "NextPage");
        eqs("default channelPrevKey", d.channelPrevKey, "PrevPage");
        eqs("default hideKey (unset)", d.hideKey, "");
        eqb("default showChannelTag", d.showChannelTag, true);
        eqb("default showHints", d.showHints, false);
        eqs("default linkUrl", d.linkUrl, "falloutchatmod.com/link");
        eqs("parse linkUrl (dev)",
            FcmConfig.parse("[FCMChat]\nlinkUrl=dev.falloutchatmod.com/link\n").linkUrl, "dev.falloutchatmod.com/link");
        eqs("linkUrl unsafe->default",
            FcmConfig.parse("[FCMChat]\nlinkUrl=<b>&x\n").linkUrl, "falloutchatmod.com/link");
        eqs("default displayNameOverride (unset)", d.displayNameOverride, "");
        eqs("parse displayNameOverride",
            FcmConfig.parse("[FCMChat]\ndisplayName=Kate6H\n").displayNameOverride, "Kate6H");
        eqs("displayNameOverride unsafe->default",
            FcmConfig.parse("[FCMChat]\ndisplayName=<b>&x\n").displayNameOverride, "");
        eqs("displayNameOverride trims",
            FcmConfig.parse("[FCMChat]\ndisplayName=  Kate6H  \n").displayNameOverride, "Kate6H");
        check("displayNameOverride clamps to 64",
            FcmConfig.parse("[FCMChat]\ndisplayName=" + [for (k in 0...80) "a"].join("") + "\n").displayNameOverride.length == 64);
        check("displayNameOverride round-trips",
            FcmConfig.parse(FcmConfig.parse("[FCMChat]\ndisplayName=Kate6H\n").toIni()).displayNameOverride == "Kate6H");
        eqs("default broadcastEventsMode", d.broadcastEventsMode, "allow");
        check("default broadcastEvents has 7 wiki-sourced names", d.broadcastEvents.length == 7);
        check("default broadcastEvents includes Scorched Earth",
            FcmConfig.eventPassesFilter("Scorched Earth", d.broadcastEvents, d.broadcastEventsMode));
        check("default broadcastEvents excludes Head Hunt",
            !FcmConfig.eventPassesFilter("Head Hunt", d.broadcastEvents, d.broadcastEventsMode));
        check("default broadcastEvents excludes Distinguished Guests",
            !FcmConfig.eventPassesFilter("Distinguished Guests", d.broadcastEvents, d.broadcastEventsMode));
        eqs("parse broadcastEventsMode deny",
            FcmConfig.parse("[FCMChat]\nbroadcastEventsMode=DENY\n").broadcastEventsMode, "deny");
        eqs("parse broadcastEventsMode garbage->allow",
            FcmConfig.parse("[FCMChat]\nbroadcastEventsMode=sometimes\n").broadcastEventsMode, "allow");
        check("parse broadcastEvents list",
            FcmConfig.parse("[FCMChat]\nbroadcastEvents=Free Range, Project Paradise\n").broadcastEvents.join("|") == "Free Range|Project Paradise");
        check("parse broadcastEvents dedupes case-insensitively",
            FcmConfig.parse("[FCMChat]\nbroadcastEvents=Tea Time, tea time ,TEA TIME\n").broadcastEvents.length == 1);
        check("allow match is case-insensitive",
            FcmConfig.eventPassesFilter("scorched earth", ["Scorched Earth"], "allow"));
        check("allow match trims",
            FcmConfig.eventPassesFilter("  Encryptid ", ["Encryptid"], "allow"));
        check("allow rejects unlisted",
            !FcmConfig.eventPassesFilter("Distinguished Guests", ["Scorched Earth"], "allow"));
        check("allow rejects substring (Hunt vs Head Hunt)",
            !FcmConfig.eventPassesFilter("Head Hunt", ["Hunt"], "allow"));
        check("allow rejects substring (Head Hunt vs Hunt entry)",
            !FcmConfig.eventPassesFilter("Hunt", ["Head Hunt"], "allow"));
        check("deny passes unlisted",
            FcmConfig.eventPassesFilter("Distinguished Guests", ["Scorched Earth"], "deny"));
        check("deny rejects listed",
            !FcmConfig.eventPassesFilter("Scorched Earth", ["Scorched Earth"], "deny"));
        check("filter rejects blank name",
            !FcmConfig.eventPassesFilter("   ", ["Scorched Earth"], "allow"));
        check("empty allow-list reads as broadcast off",
            !FcmConfig.parse("[FCMChat]\nautoBroadcastWorldEvents=true\nbroadcastEvents=\n").autoBroadcastActive());
        check("non-empty allow-list with toggle on reads as active",
            FcmConfig.parse("[FCMChat]\nautoBroadcastWorldEvents=true\nbroadcastEvents=Tea Time\n").autoBroadcastActive());
        check("deny with empty list reads as active",
            FcmConfig.parse("[FCMChat]\nautoBroadcastWorldEvents=true\nbroadcastEvents=\nbroadcastEventsMode=deny\n").autoBroadcastActive());
        check("master toggle off reads as inactive regardless",
            !FcmConfig.parse("[FCMChat]\nautoBroadcastWorldEvents=false\nbroadcastEvents=Tea Time\n").autoBroadcastActive());
        check("broadcast filter round-trips",
            FcmConfig.parse(FcmConfig.parse("[FCMChat]\nbroadcastEvents=Free Range,Project Paradise\nbroadcastEventsMode=deny\n").toIni()).broadcastEvents.join("|") == "Free Range|Project Paradise"
            && FcmConfig.parse(FcmConfig.parse("[FCMChat]\nbroadcastEvents=Free Range,Project Paradise\nbroadcastEventsMode=deny\n").toIni()).broadcastEventsMode == "deny");

        var menuCfg = new FcmConfig();
        check("width action accepted", menuCfg.customizeSize("cz_width_up"));
        eqi("width grows independently", menuCfg.width, 430);
        eqi("width leaves height", menuCfg.height, 260);
        menuCfg.customizeSize("cz_height_dn");
        eqi("height shrinks independently", menuCfg.height, 240);
        eqi("height leaves width", menuCfg.width, 430);
        menuCfg.customizeSize("cz_input_font_up");
        eqi("input font exits auto", menuCfg.inputFontSize, 15);
        eqi("input font leaves feed", menuCfg.fontSize, 14);
        menuCfg.customizeSize("cz_input_font_auto");
        eqi("input font returns to auto", menuCfg.inputFontSize, 0);
        menuCfg.customizeSize("cz_input_height_up");
        eqi("input row grows independently", menuCfg.inputHeight, 32);
        eqi("input height leaves panel", menuCfg.height, 240);
        for (item in menuCfg.sizingMenu())
            check("menu action supported " + item.id, menuCfg.customizeSize(item.id));
        check("unknown sizing action rejected", !menuCfg.customizeSize("bogus"));
        menuCfg.width = 1920;
        menuCfg.customizeSize("cz_width_up");
        eqi("menu width bounded", menuCfg.width, 1920);
        menuCfg.height = 120;
        menuCfg.customizeSize("cz_height_dn");
        eqi("menu height bounded", menuCfg.height, 120);

        var hideCfg = FcmConfig.parse("[FCMChat]\nautoHideEnabled=false\nautoHideSec=95\n");
        check("auto-hide can be off with positive delay", !hideCfg.autoHideActive());
        hideCfg.adjustAutoHideDelay(5);
        check("delay change does not enable auto-hide", !hideCfg.autoHideActive());
        eqi("delay changes while disabled", hideCfg.autoHideSec, 100);
        hideCfg.toggleAutoHide();
        check("toggle restores auto-hide", hideCfg.autoHideActive());
        eqi("toggle preserves delay", hideCfg.autoHideSec, 100);
        hideCfg.toggleAutoHide();
        var restoredHide = FcmConfig.parse(hideCfg.toIni());
        check("disabled state survives save", !restoredHide.autoHideActive());
        eqi("saved delay retained", restoredHide.autoHideSec, 100);
        var legacyHide = FcmConfig.parse("[FCMChat]\nautoHideSec=0\n");
        check("legacy zero is off", !legacyHide.autoHideActive());
        legacyHide.adjustAutoHideDelay(5);
        check("legacy disabled stays disabled on delay change", !legacyHide.autoHideActive());
        legacyHide.autoHideSec = 0;
        legacyHide.toggleAutoHide();
        eqi("enabling legacy zero supplies default delay", legacyHide.autoHideSec, 60);
        legacyHide.adjustAutoHideDelay(999);
        eqi("delay maximum", legacyHide.autoHideSec, 600);
        legacyHide.adjustAutoHideDelay(-999);
        eqi("delay minimum", legacyHide.autoHideSec, 1);
        var editorCfg = FcmConfig.parse("[FCMChat]\nwidth=600\nheight=300\ninputHeight=48\ninputFontSize=24\n");
        var editor = editorCfg.inputRect();
        eqi("editor width matches panel padding", editor.width, 588);
        eqi("editor height matches input padding", editor.height, 42);
        eqi("editor vertical placement", editor.y, 256);
        check("editor remains inside panel", editor.y + editor.height <= editorCfg.height);
        editorCfg.customizeSize("cz_width_up");
        eqi("editor follows live width", editorCfg.inputRect().width, 618);
        editorCfg.customizeSize("cz_input_height_up");
        eqi("editor follows live input height", editorCfg.inputRect().height, 46);

        var colors = FcmConfig.parse("[FCMChat]\ninputBgColor=#123456\ninputTextColor=#ABCDEF\nbgAlpha=0.25\n");
        eqi("input background parses", colors.inputBgColor, 0x123456);
        eqi("input font color parses", colors.inputTextColor, 0xABCDEF);
        eqs("appearance survives local save", FcmConfig.parse(colors.toIni()).toIni(), colors.toIni());
        for (field in FcmConfig.COLOR_FIELDS) {
            check("color menu action " + field, colors.customizeColor("cz_color_" + field + "_5"));
            eqi("color applied " + field, Reflect.field(colors,field), 0xFFFFFF);
        }
        check("bad color index rejected", !colors.customizeColor("cz_color_bgColor_99"));
        check("partial index rejected", !colors.customizeColor("cz_color_bgColor_5oops"));
        for (field in ["showChannelTag", "chanColorGlobal", "defaultChannel", "inputWidth", "inputAlignment"])
            check("restricted menu field " + field, !colors.customizeColor("cz_color_" + field + "_5"));
        var locked = FcmConfig.parse("[FCMChat]\nshowChannelTag=false\nchannelTagColor=#123456\ncolorGeneral=#123456\ninputWidth=999\ninputAlignment=right\n");
        check("tags remain enabled", locked.showChannelTag);
        eqi("tag identity stays fixed", locked.channelTagColor, 0x8FBC8F);
        eqi("channel identity stays fixed", locked.channelColor("global"), 0x1ABAFF);
        eqi("input width stays bounded", locked.inputRect().width, locked.width - 12);
        eqi("input alignment stays fixed", locked.inputRect().x, 6);
        check("locked keys not saved", locked.toIni().indexOf("showChannelTag") < 0 && locked.toIni().indexOf("colorGeneral") < 0);

        // Reset restores the authoritative defaults, retaining only the environment-owned link URL.
        var customized = FcmConfig.parse("[FCMChat]\n"
            + "x=900\ny=500\nwidth=800\nheight=500\nfontSize=20\nbgAlpha=0.25\n"
            + "borderColor=123456\nmaxMessages=250\nautoHideSec=0\nshowHints=true\n"
            + "linkUrl=dev.falloutchatmod.com/link\n");
        var reset = FcmConfig.resetToDefaults(customized);
        var expectedReset = new FcmConfig();
        expectedReset.linkUrl = "dev.falloutchatmod.com/link";
        eqs("reset all settings to defaults", reset.toIni(), expectedReset.toIni());
        check("reset returns a new config", reset != customized);
        eqs("decode storage JSON text",
            FcmConfig.decodeJsonText("[FCMChat]\\nx=42\\nlinkUrl=dev.falloutchatmod.com/link\\n"),
            "[FCMChat]\nx=42\nlinkUrl=dev.falloutchatmod.com/link\n");
        eqs("decode storage escaped quote and slash", FcmConfig.decodeJsonText("a\\\"b\\\\c"), "a\"b\\c");

        // ── full parse ──
        var ini = "[FCMChat]\n"
            + "x=50\ny=60\nwidth=600\nheight=400\nfontSize=18\n"
            + "bgColor=#101010\nbgAlpha=0.5\nborderColor=00FF00\ntextColor=0xABCDEF\n"
            + "maxMessages=250\nmaxSendLen=120\n"
            + "openKey=INSERT\nchannelNextKey=NextPage\nchannelPrevKey=PrevPage\nhideKey=DiagnosticSnapshot\n"
            + "showChannelTag=false\nshowHints=true\n";
        var c = FcmConfig.parse(ini);
        eqi("parse x", c.x, 50);
        eqi("parse width", c.width, 600);
        eqi("parse fontSize", c.fontSize, 18);
        eqi("parse bgColor", c.bgColor, 0x101010);
        check("parse bgAlpha", c.bgAlpha == 0.5);
        eqi("parse borderColor (bare)", c.borderColor, 0x00FF00);
        eqi("parse textColor (0x)", c.textColor, 0xABCDEF);
        eqi("parse maxMessages", c.maxMessages, 250);
        eqi("parse maxSendLen", c.maxSendLen, 120);
        eqs("parse hideKey", c.hideKey, "DiagnosticSnapshot");
        eqb("channel tag visibility override ignored", c.showChannelTag, true);
        eqb("parse showHints", c.showHints, true);
        check("legacy timestamp settings are ignored", FcmConfig.parse(
            "[FCMChat]\nshowTimestamps=true\ntimestampColor=#FFFFFF\n").toIni().indexOf("showTimestamps") < 0);

        // ── clamps + invalid fallbacks ──
        var bad = FcmConfig.parse("[FCMChat]\nwidth=5\nheight=99999\nfontSize=999\nbgAlpha=9\n"
            + "maxMessages=1\nmaxSendLen=9999\nchannelNextKey=Jump\nbgColor=zzz\n");
        eqi("clamp width min", bad.width, 200);
        eqi("clamp height max", bad.height, 1080);
        eqi("clamp fontSize max", bad.fontSize, 47);
        check("clamp bgAlpha max", bad.bgAlpha == 1.0);
        eqi("clamp maxMessages min", bad.maxMessages, 10);
        eqi("clamp maxSendLen max", bad.maxSendLen, 500);
        eqs("invalid action->default", bad.channelNextKey, "NextPage");
        eqi("invalid color->default", bad.bgColor, 0x0A0907);

        // ── x/y clamped into the 1920x1080 viewport given width/height ──
        var off = FcmConfig.parse("[FCMChat]\nx=5000\ny=5000\nwidth=480\nheight=306\n");
        eqi("clamp x to viewport", off.x, 1920 - 480);
        eqi("clamp y to viewport", off.y, 1080 - 306);

        // ── section-scoped: keys outside [FCMChat] ignored; comments skipped ──
        var scoped = FcmConfig.parse("x=999\n[Other]\nwidth=999\n[FCMChat]\n; comment\nx=42\n");
        eqi("section scope x", scoped.x, 42);
        eqi("section scope width default", scoped.width, 400);

        // ── chanLabel: slug -> proper-cased channel name (CAP-012, D-09) ──
        eqs("chanLabel global",  FcmConfig.chanLabel("global"),  "General");
        eqs("chanLabel trade",   FcmConfig.chanLabel("trade"),   "Trading");
        eqs("chanLabel events",  FcmConfig.chanLabel("events"),  "Events");
        eqs("chanLabel infests", FcmConfig.chanLabel("infests"), "Infests");
        eqs("chanLabel raids",   FcmConfig.chanLabel("raids"),   "Raids");
        eqs("chanLabel server",  FcmConfig.chanLabel("server"),  "Server");
        eqs("chanLabel unknown->TitleCase", FcmConfig.chanLabel("foobar"), "Foobar");
        eqs("chanLabel empty",   FcmConfig.chanLabel(""),        "");
        eqs("chanLabel null",    FcmConfig.chanLabel(null),      "");

        // ── channelColor: per-channel colors mirror website chat_rooms.color (prod 2026-06-28) ──
        eqi("chanColor global (General)",  d.channelColor("global"),  0x1ABAFF);
        eqi("chanColor trade (Trading)",   d.channelColor("trade"),   0x008F37);
        eqi("chanColor events",            d.channelColor("events"),  0xC88A51);
        eqi("chanColor infests",           d.channelColor("infests"), 0x5ABD0A);
        eqi("chanColor raids",             d.channelColor("raids"),   0xCE0909);
        eqi("chanColor server",            d.channelColor("server"),  0xECBB51);
        eqi("chanColor unknown->tagColor", d.channelColor("nope"),    d.channelTagColor);
        eqi("chanColor null->tagColor",    d.channelColor(null),      d.channelTagColor);
        eqi("chanColor case-insensitive",  d.channelColor("  RAIDS "), 0xCE0909);
        eqi("channel color override ignored",
            FcmConfig.parse("[FCMChat]\ncolorRaids=#123456\n").channelColor("raids"), 0xCE0909);
        eqs("config serialization round-trip", FcmConfig.parse(c.toIni()).toIni(), c.toIni());

        // ── dimColor: scales a color toward black (inactive sub-tabs) ──
        eqi("dimColor 0.5",      FcmConfig.dimColor(0xFFFFFF, 0.5), 0x7F7F7F);
        eqi("dimColor 0.0",      FcmConfig.dimColor(0xABCDEF, 0.0), 0x000000);
        eqi("dimColor 1.0",      FcmConfig.dimColor(0xABCDEF, 1.0), 0xABCDEF);
        eqi("dimColor clamp >1", FcmConfig.dimColor(0x102030, 2.0), 0x102030);

        // ── htmlEscape: numeric refs for unsanitized relay input (SR-001, crash rule #2) ──
        eqs("htmlEscape plain",  FcmConfig.htmlEscape("hello world"), "hello world");
        eqs("htmlEscape lt",     FcmConfig.htmlEscape("a<b"),   "a&#60;b");
        eqs("htmlEscape gt",     FcmConfig.htmlEscape("a>b"),   "a&#62;b");
        eqs("htmlEscape amp",    FcmConfig.htmlEscape("a&b"),   "a&#38;b");
        eqs("htmlEscape quote",  FcmConfig.htmlEscape("a\"b"),  "a&#34;b");
        // amp escaped first so the refs we emit are not double-encoded
        eqs("htmlEscape no double-encode", FcmConfig.htmlEscape("a&b<c"), "a&#38;b&#60;c");
        // markup-injection / GFx-crash payloads are neutralized
        eqs("htmlEscape font tag", FcmConfig.htmlEscape("</font><font color=\"#FF0000\">x"),
            "&#60;/font&#62;&#60;font color=&#34;#FF0000&#34;&#62;x");
        eqs("htmlEscape img tag",  FcmConfig.htmlEscape("<img src='evil.swf'>"),
            "&#60;img src='evil.swf'&#62;");
        eqs("htmlEscape null",   FcmConfig.htmlEscape(null), "");
        eqs("htmlEscape empty",  FcmConfig.htmlEscape(""),   "");

        if (failures > 0) { Sys.println(failures + " FAILURE(S)"); Sys.exit(1); }
        Sys.println("ALL PASS");
    }
}
