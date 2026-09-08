typedef FcmEmojiSlot = { token:String, image:Int };
typedef FcmEmojiEntry = { key:String, image:Int, name:String };
typedef FcmEmojiPlan = { text:String, slots:Array<FcmEmojiSlot> };

/** Transport-independent display conversion. Never modify queued or transmitted messages. */
class FcmEmoji {
    // Avoid Haxe map/interface and generic string-conversion dependencies in GFx.
    static var catalog:Array<FcmEmojiEntry> = null;
    static var maxLength:Int = 0;
    public static var stage:String = "idle";
    public static inline var MAX_PER_ROW:Int = 32;

    static function init():Void {
        if (catalog != null) return;
        stage = "catalog-read";
        var rows = FcmEmojiCatalog.data().split("\n");
        var entries:Array<FcmEmojiEntry> = [];
        stage = "catalog-parse";
        for (line in rows) {
            var cells = line.split("\t");
            if (cells.length != 3) continue;
            var id = 0;
            for (i in 0...cells[1].length) id = id * 10 + cells[1].charCodeAt(i) - 48;
            entries.push({key:cells[0], image:id, name:cells[2]});
            if (!StringTools.startsWith(cells[0], "discord:") && cells[0].length > maxLength)
                maxLength = cells[0].length;
        }
        // Sort in the target VM: Flash uses UTF-16 ordering, the interpreter does not.
        stage = "catalog-sort";
        entries.sort(function(a, b) return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
        catalog = entries;
    }

    static function lookup(key:String):FcmEmojiEntry {
        var low = 0;
        var high = catalog.length - 1;
        while (low <= high) {
            var mid = (low + high) >> 1;
            var entry = catalog[mid];
            if (entry.key == key) return entry;
            if (entry.key < key) low = mid + 1; else high = mid - 1;
        }
        return null;
    }

    public static function plan(source:String, images:Bool, reserved:String = ""):FcmEmojiPlan {
        stage = "init";
        init();
        stage = "scan";
        if (source == null) source = "";
        var prefix = "\uE000E";
        while ((source + reserved).indexOf(prefix) >= 0 && prefix.length < 8) prefix += "E";
        if ((source + reserved).indexOf(prefix) >= 0) images = false;
        var slots:Array<FcmEmojiSlot> = [];
        var out = "";
        var i = 0;
        while (i < source.length) {
            var entry:FcmEmojiEntry = null;
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
                        entry = lookup("discord:" + id.substr(0, id.length - 1));
                        if (entry == null) {
                            out += normalized;
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
                    entry = lookup(source.substr(i, length));
                    if (entry != null) { consumed = length; break; }
                    length--;
                }
                // Explicit text presentation requests stay text rather than becoming pictures.
                if (entry != null && source.charCodeAt(i + consumed) == 0xFE0E) {
                    out += source.substr(i, consumed + 1); i += consumed + 1; continue;
                }
            }
            if (entry == null) { out += source.charAt(i++); continue; }
            if (images && slots.length < MAX_PER_ROW) {
                var token = prefix + slots.length + "\uE001";
                slots.push({token:token, image:entry.image});
                out += token;
            } else out += ":" + entry.name + ":";
            i += consumed;
        }
        stage = "complete";
        return {text:out, slots:slots};
    }
}
