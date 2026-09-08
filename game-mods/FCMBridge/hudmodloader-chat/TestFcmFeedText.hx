class TestFcmFeedText {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        var row = FcmFeedText.compose("General", "[#12345678] ", "VIP", "A<&B", "hello\r\nsecond <font> line", 3, " [queued]");
        check(row.text.substring(0, row.channelEnd) == "[General] ", "channel range");
        check(row.text.substring(row.channelEnd, row.moderationEnd) == "[#12345678] ", "moderator range");
        check(row.text.substring(row.moderationEnd, row.tagEnd) == "[VIP] ", "tag range");
        check(row.nameStart - row.tagEnd == 3, "star slot");
        check(row.text.substring(row.nameStart, row.nameEnd) == "A<&B", "name range excludes punctuation and markup interpretation");
        check(row.text.substring(row.nameEnd, row.statusStart) == ": hello\nsecond <font> line", "body range retains standard color through newline");
        check(row.text.substr(row.statusStart) == " [queued]", "status range");
        var plain = FcmFeedText.compose("", "", "", "Name", "", 0, "");
        check(plain.nameStart == 0 && plain.nameEnd == 4 && plain.text == "Name: ", "no optional prefixes");
        var long = FcmFeedText.compose("Trading", "", "", "Long name", "verylongunbrokenmessage", 0, "");
        check(long.text.substr(long.nameEnd) == ": verylongunbrokenmessage", "reflow doesn't alter character ranges");
        trace("FcmFeedText tests passed");
    }
}
