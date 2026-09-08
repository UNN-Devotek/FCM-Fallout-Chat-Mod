class TestFcmEmojiCommand {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        check(FcmEmojiCommand.resolve("/emoji heart").body == "❤️", "Unicode alias");
        check(FcmEmojiCommand.resolve("EMOJI THUMBS_UP").body == "👍", "slash stripped and case insensitive");
        check(FcmEmojiCommand.resolve("/emoji\tgrinning face").body == "😀", "multiword name");
        check(FcmEmojiCommand.resolve("/emoji :grinning_face:").body == "😀", "colon shortcode");
        check(FcmEmojiCommand.resolve("/emoji unicode:heart").body == "❤️", "explicit Unicode namespace");
        for (input in ["/emoji", "emoji", "/emoji unknown_emoji_123", "/emoji smile extra"]) {
            var result = FcmEmojiCommand.resolve(input);
            check(result.handled && result.body == "" && result.error.length > 0, "invalid command stays local");
        }
        for (input in ["hello emoji heart", "/emojis heart", "emojify heart", "hello 😀"])
            check(!FcmEmojiCommand.resolve(input).handled, "ordinary text unaffected");
        var customs = 0;
        for (line in FcmEmojiCatalog.commands().split("\n")) {
            var parts = line.split("\t");
            if (!StringTools.startsWith(parts[0], "discord:")) continue;
            var result = FcmEmojiCommand.resolve("/emoji " + parts[0]);
            check(result.body == parts[1], "custom ID and animated prefix preserved");
            check(FcmEmoji.plan(result.body, true).slots.length == 1, "sent custom emoji renders in the HUD");
            customs++;
        }
        check(customs > 0, "custom commands present");
        trace("FcmEmojiCommand tests passed");
    }
}
