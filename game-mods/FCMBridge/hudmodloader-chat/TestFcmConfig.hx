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
        eqs("supporter star glyph is immutable", FcmConfig.SUPPORTER_STAR_GLYPH, "★");
        var starToken:String = FcmConfig.supporterStarToken(4);
        check("supporter star image token is bounded", starToken.length <= 15);
        check("supporter star image token is private-use delimited",
            starToken.charCodeAt(0) == 0xE000 && starToken.charCodeAt(starToken.length - 1) == 0xE001);
        eqi("supporter star colour accepts hex", FcmConfig.supporterStarColor("#58FDFD", 0x123456), 0x58FDFD);
        eqi("supporter star colour rejects unsafe input", FcmConfig.supporterStarColor("url(evil)", 0x123456), 0x123456);
        eqb("supporter marker accepts server flag", FcmConfig.supporterStarPresent(true, ""), true);
        eqb("supporter marker accepts validated colour", FcmConfig.supporterStarPresent(false, "#FD4DA6"), true);
        eqb("supporter marker rejects unsafe colour", FcmConfig.supporterStarPresent(false, "url(evil)"), false);
        eqs("json string compact", FcmConfig.extractJsonString('{"tag":"X"}', "tag"), "X");
        eqs("json string whitespace", FcmConfig.extractJsonString('{ "tag" : \"X\" }', "tag"), "X");
        eqs("json string newline whitespace", FcmConfig.extractJsonString('{\n tag\t:\n \"X\"\n}', "tag"), "X");
        eqs("json string escaped quote", FcmConfig.extractJsonString('{"tag":"a\\\"b"}', "tag"), "a\\\"b");
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
        eqi("default autoHideSec", d.autoHideSec, 60);
        eqi("default bgColor", d.bgColor, 0x0A0907);
        eqi("default borderColor", d.borderColor, 0xF5CB5B);
        eqi("default textColor", d.textColor, 0xFAF4DA);
        eqi("default channelTagColor", d.channelTagColor, 0x8FBC8F);
        check("default bgAlpha", d.bgAlpha == 0.94);
        eqi("default maxMessages", d.maxMessages, 100);
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
        eqb("parse showChannelTag", c.showChannelTag, false);
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
        eqi("chanColor INI override",
            FcmConfig.parse("[FCMChat]\ncolorRaids=#123456\n").channelColor("raids"), 0x123456);
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
