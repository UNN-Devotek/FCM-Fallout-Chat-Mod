class TestFcmEmojiLayout {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        var layout = FcmEmojiLayout.prepare(FcmEmoji.plan("😀\r\nhello 👍🏽🇺🇸", true));
        check(layout.slots.length == 3, "combined Unicode sequences keep one slot each");
        check(layout.text.indexOf("\r") < 0, "normalize newlines before computing glyph indices");
        for (slot in layout.slots) check(layout.text.charCodeAt(slot.index) == 160, "sprite anchors to its own reserved glyph");
        check(layout.slots[0].index == 0 && layout.slots[2].index == layout.slots[1].index + 1, "adjacent emoji retain separate slots");
        var row = FcmFeedText.compose("General", "", "VIP", "Name", layout.text, 3, " [queued]");
        for (slot in layout.slots) check(row.text.charCodeAt(row.nameEnd + 2 + slot.index) == 160, "body offsets preserve channel/name/style boundaries");
        var fallback = FcmEmojiLayout.prepare(FcmEmoji.plan("😀", false));
        check(fallback.slots.length == 0 && fallback.text == ":grinning face:", "failure fallback retains readable styled text");
        trace("FcmEmojiLayout tests passed");
    }
}
