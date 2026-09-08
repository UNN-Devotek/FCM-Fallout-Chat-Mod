class TestFcmEmoji {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        var emoji = FcmEmoji.plan("Hi 😀 ❤️ 👍🏽 👨‍👩‍👧‍👦 🇺🇸 1️⃣!", true);
        check(emoji.slots.length == 6, "longest match preserves skin tones, ZWJ families, flags, selectors and keycaps");
        check(emoji.text.indexOf("Hi ") == 0 && StringTools.endsWith(emoji.text, "!"), "surrounding text intact");
        for (slot in emoji.slots) check(slot.token.length <= 15, "GFx substitution token bound");
        check(FcmEmoji.plan("😀", false).text == ":grinning face:", "readable fallback");
        check(FcmEmoji.plan("hello <font color='#ff0000'>world</font>", true).text == "hello <font color='#ff0000'>world</font>", "no HTML interpretation");
        check(FcmEmoji.plan("<:missing:123456789012345678>", true).text == ":missing:", "unknown custom emoji name fallback");
        check(FcmEmoji.plan("<a:missing:123456789012345678>", true).text == ":missing:", "animated unknown fallback");
        check(FcmEmoji.plan("<:bad!:123>", true).text == "<:bad!:123>", "malformed markup stays literal");
        check(FcmEmoji.plan("©\uFE0E", true).text == "©\uFE0E", "explicit text presentation preserved");
        check(FcmEmoji.plan("👁️‍🗨️", true).slots.length == 1, "selector alias resolves the complete eye speech bubble");
        var plainTransport = FcmEmoji.plan("😀 <:renamed:123456789012345678>", true);
        var decoded:Dynamic = FcmJson.parse('{"body":"😀 <:renamed:123456789012345678>"}');
        var jsonTransport = FcmEmoji.plan(decoded.body, true);
        check(plainTransport.text == jsonTransport.text, "native-object and JSON transport text share one render plan");
        var many = "";
        for (_ in 0...50) many += "😀";
        var bounded = FcmEmoji.plan(many, true);
        check(bounded.slots.length == 32 && bounded.text.indexOf(":grinning face:") >= 0, "bounded images with readable overflow");
        var collision = FcmEmoji.plan("\uE000E0\uE001 😀", true);
        check(collision.slots[0].token != "\uE000E0\uE001", "user text cannot impersonate generated substitution");
        var known = "";
        for (line in FcmEmojiCatalog.data().split("\n")) {
            if (StringTools.startsWith(line, "discord:")) { known = line.split("\t")[0].substr(8); break; }
        }
        check(known.length > 0, "custom catalog present");
        var a = FcmEmoji.plan("<:old_name:" + known + ">", true);
        var b = FcmEmoji.plan("<a:renamed:" + known + ">", true);
        check(a.slots.length == 1 && b.slots.length == 1 && a.slots[0].image == b.slots[0].image, "custom lookup uses ID for renamed and animated emoji");
        var body = FcmEmoji.plan("line 😀\nnext 👍🏽", true);
        var row = FcmFeedText.compose("General", "", "VIP", "ColoredName", body.text, 3, " [queued]");
        check(row.text.substring(row.nameStart, row.nameEnd) == "ColoredName", "emoji does not alter name color offsets");
        check(row.text.substring(row.nameEnd, row.statusStart) == ": " + body.text, "body remains independently formatted and multiline");
        trace("FcmEmoji tests passed");
    }
}
