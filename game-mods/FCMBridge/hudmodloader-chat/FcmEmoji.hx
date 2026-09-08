typedef FcmEmojiSlot = { token:String, image:Int };
typedef FcmEmojiPlan = { text:String, slots:Array<FcmEmojiSlot> };

/** Transport-independent display conversion. Never modify queued or transmitted messages. */
class FcmEmoji {
    static var catalog:Map<String, {image:Int, name:String}> = null;
    static var maxLength:Int = 0;
    public static inline var MAX_PER_ROW:Int = 32;

    static function init():Void {
        if (catalog != null) return;
        catalog = new Map();
        for (line in FcmEmojiCatalog.data().split("\n")) {
            var cells = line.split("\t");
            if (cells.length != 3) continue;
            var id = Std.parseInt(cells[1]);
            if (id == null) continue;
            catalog.set(cells[0], {image:id, name:cells[2]});
            if (!StringTools.startsWith(cells[0], "discord:")) maxLength = Std.int(Math.max(maxLength, cells[0].length));
        }
    }

    public static function plan(source:String, images:Bool, reserved:String = ""):FcmEmojiPlan {
        init();
        if (source == null) source = "";
        var prefix = "\uE000E";
        while ((source + reserved).indexOf(prefix) >= 0 && prefix.length < 8) prefix += "E";
        if ((source + reserved).indexOf(prefix) >= 0) images = false;
        var slots:Array<FcmEmojiSlot> = [];
        var out = new StringBuf();
        var i = 0;
        while (i < source.length) {
            var entry:{image:Int,name:String} = null;
            var consumed = 0;
            // Snowflakes are identifiers, never names: renamed/duplicate custom emoji stay distinct.
            if (source.substr(i, 2) == "<:" || source.substr(i, 3) == "<a:") {
                var end = source.indexOf(">", i);
                if (end >= i && end - i <= 94) {
                    var markup = source.substring(i, end + 1);
                    var normalized = FcmConfig.normalizeDiscordEmojiMarkup(markup);
                    if (normalized != markup) {
                        var parts = markup.split(":");
                        var id = parts[parts.length - 1];
                        entry = catalog.get("discord:" + id.substr(0, id.length - 1));
                        if (entry == null) {
                            out.add(normalized);
                            i = end + 1;
                            continue;
                        }
                        consumed = markup.length;
                    }
                }
            }
            if (entry == null) {
                var length = Std.int(Math.min(maxLength, source.length - i));
                while (length > 0) {
                    entry = catalog.get(source.substr(i, length));
                    if (entry != null) { consumed = length; break; }
                    length--;
                }
                // Explicit text presentation requests stay text rather than becoming pictures.
                if (entry != null && source.charCodeAt(i + consumed) == 0xFE0E) {
                    out.add(source.substr(i, consumed + 1)); i += consumed + 1; continue;
                }
            }
            if (entry == null) { out.add(source.charAt(i++)); continue; }
            if (images && slots.length < MAX_PER_ROW) {
                var token = prefix + slots.length + "\uE001";
                slots.push({token:token, image:entry.image});
                out.add(token);
            } else out.add(":" + entry.name + ":");
            i += consumed;
        }
        return {text:out.toString(), slots:slots};
    }
}
