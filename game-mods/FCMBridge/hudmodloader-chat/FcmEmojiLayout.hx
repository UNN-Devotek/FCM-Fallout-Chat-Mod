typedef FcmInlineEmoji = {index:Int, image:Int};
/** Reserve one measurable blank glyph per image; preserve full-width native reflow. */
class FcmEmojiLayout {
    public static function prepare(plan:FcmEmoji.FcmEmojiPlan):{text:String,slots:Array<FcmInlineEmoji>} {
        var text = StringTools.replace(StringTools.replace(plan.text, "\r\n", "\n"), "\r", "\n");
        var slots:Array<FcmInlineEmoji> = [];
        for (slot in plan.slots) {
            var index = text.indexOf(slot.token);
            if (index < 0) continue;
            text = text.substring(0, index) + String.fromCharCode(160) + text.substr(index + slot.token.length);
            slots.push({index:index, image:slot.image});
        }
        return {text:text, slots:slots};
    }
}
