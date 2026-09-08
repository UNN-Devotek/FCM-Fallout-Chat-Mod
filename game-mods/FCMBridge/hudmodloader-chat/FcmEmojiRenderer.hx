import flash.display.BitmapData;
import flash.text.TextField;
import flash.text.TextFormat;

/** Uses the host GFx extension only after a measurable image-substitution probe. */
class FcmEmojiRenderer {
    static var extension:Dynamic = null;
    static var checked:Bool = false;
    static var available:Bool = false;
    static var cache:Map<Int, BitmapData> = new Map();
    static var cacheOrder:Array<Int> = [];

    static function bitmap(id:Int):BitmapData {
        if (cache.exists(id)) return cache.get(id);
        var value = FcmEmojiAssets.get(id);
        if (value == null) return null;
        // Do not dispose evicted images: native fields may still reference them.
        if (cacheOrder.length >= 128) cache.remove(cacheOrder.shift());
        cacheOrder.push(id);
        cache.set(id, value);
        return value;
    }

    public static function supported(font:String, size:Int):Bool {
        if (checked) return available;
        checked = true;
        try {
            var extensions:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("scaleform.gfx.Extensions");
            extensions.enabled = true;
            extension = untyped __global__["flash.utils.getDefinitionByName"]("scaleform.gfx.TextFieldEx");
            if (extension == null || Reflect.field(extension, "setImageSubstitutions") == null) return false;
            var probe = new TextField();
            probe.embedFonts = true;
            probe.defaultTextFormat = new TextFormat(font, size);
            probe.text = "MMMMMMMM";
            var before = probe.textWidth;
            var test = FcmEmoji.plan("😀", true);
            if (test.slots.length != 1 || before <= 0) return false;
            var image = bitmap(test.slots[0].image);
            extension.setImageSubstitutions(probe, [{subString:"MMMMMMMM", image:image, width:8, height:8}]);
            available = probe.textWidth > 0 && probe.textWidth < before * 0.75;
            extension.setImageSubstitutions(probe, null);
        } catch (_:Dynamic) { available = false; }
        return available;
    }

    public static function apply(field:TextField, slots:Array<FcmEmoji.FcmEmojiSlot>, size:Int):Bool {
        if (slots.length == 0) return true;
        if (!available) return false;
        try {
            var descriptors:Array<Dynamic> = [];
            for (slot in slots) {
                var image = bitmap(slot.image);
                if (image == null) return false;
                descriptors.push({subString:slot.token, image:image,
                    width:size, height:size, baseLineY:image.height * 0.85});
            }
            extension.setImageSubstitutions(field, descriptors);
            return true;
        } catch (_:Dynamic) {
            try { extension.setImageSubstitutions(field, null); } catch (_:Dynamic) {}
            return false;
        }
    }
}
