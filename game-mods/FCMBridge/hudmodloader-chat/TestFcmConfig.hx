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
        eqi("default width", d.width, 480);
        eqi("default height", d.height, 306);
        eqi("default fontSize", d.fontSize, 14);
        eqi("default bgColor", d.bgColor, 0x0A0907);
        eqi("default borderColor", d.borderColor, 0xF5CB5B);
        eqi("default textColor", d.textColor, 0xFAF4DA);
        eqi("default channelTagColor", d.channelTagColor, 0x8FBC8F);
        check("default bgAlpha", d.bgAlpha == 0.94);
        eqi("default maxMessages", d.maxMessages, 100);
        eqi("default maxSendLen", d.maxSendLen, 225);
        eqs("default openKey", d.openKey, "INSERT");
        // openKey is interpolated into htmlText (idle prompt) — must be a safe key token
        // ([A-Za-z0-9_]); anything else falls back to default (crash rule #2, htmlText injection).
        eqs("openKey safe kept", FcmConfig.parse("[FCMChat]\nopenKey=PAGE_DOWN\n").openKey, "PAGE_DOWN");
        eqs("openKey unsafe->default", FcmConfig.parse("[FCMChat]\nopenKey=<b>&x\n").openKey, "INSERT");
        eqs("default channelNextKey", d.channelNextKey, "NextPage");
        eqs("default channelPrevKey", d.channelPrevKey, "PrevPage");
        eqs("default hideKey (unset)", d.hideKey, "");
        eqb("default showChannelTag", d.showChannelTag, true);
        eqb("default showTimestamps", d.showTimestamps, true);
        eqb("default showHints", d.showHints, false);

        // ── full parse ──
        var ini = "[FCMChat]\n"
            + "x=50\ny=60\nwidth=600\nheight=400\nfontSize=18\n"
            + "bgColor=#101010\nbgAlpha=0.5\nborderColor=00FF00\ntextColor=0xABCDEF\n"
            + "maxMessages=250\nmaxSendLen=120\n"
            + "openKey=INSERT\nchannelNextKey=NextPage\nchannelPrevKey=PrevPage\nhideKey=DiagnosticSnapshot\n"
            + "showChannelTag=false\nshowTimestamps=false\nshowHints=true\n";
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
        eqb("parse showTimestamps", c.showTimestamps, false);
        eqb("parse showHints", c.showHints, true);

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
        eqi("section scope width default", scoped.width, 480);

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

        // ── hhmm: ISO 8601 UTC -> "HH:MM" (24h, substring only, CAP-013, D-08) ──
        eqs("hhmm typical", FcmConfig.hhmm("2026-06-26T12:34:56.000Z"), "12:34");
        eqs("hhmm midnight", FcmConfig.hhmm("2026-01-01T00:00:00Z"), "00:00");
        eqs("hhmm no T", FcmConfig.hhmm("2026-06-26 12:34:56"), "");
        eqs("hhmm empty", FcmConfig.hhmm(""), "");
        eqs("hhmm null", FcmConfig.hhmm(null), "");
        // fail-closed: only digit:digit may reach htmlText (crash rule #2 — no raw &<> entities)
        eqs("hhmm entity amp",  FcmConfig.hhmm("2026-06-26T12&34:56Z"), "");
        eqs("hhmm entity lt",   FcmConfig.hhmm("2026-06-26T<2:34:56Z"), "");
        eqs("hhmm non-numeric", FcmConfig.hhmm("2026-06-26Tab:cdZ"),    "");
        eqs("hhmm no colon",    FcmConfig.hhmm("2026-06-26T1234:56Z"),  "");

        if (failures > 0) { Sys.println(failures + " FAILURE(S)"); Sys.exit(1); }
        Sys.println("ALL PASS");
    }
}
