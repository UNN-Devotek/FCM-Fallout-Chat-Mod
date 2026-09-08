import flash.display.Sprite;
import flash.text.TextField;
import flash.text.TextFormat;

/** Native linked sprites: no BitmapData, image substitution, or optional GFx classes. */
class FcmEmojiRenderer {
    public static var stage:String = "idle";
    public static function decorate(row:Sprite, field:TextField,
            slots:Array<FcmEmojiLayout.FcmInlineEmoji>, offset:Int, size:Int, font:String, color:Int):Bool {
        if (slots.length == 0) return true;
        stage = "measure-space";
        var sample = new TextField();
        sample.embedFonts = true;
        sample.defaultTextFormat = new TextFormat(font, size);
        sample.text = "M\u00a0M";
        var spaced = sample.textWidth;
        sample.text = "MM";
        var advance = spaced - sample.textWidth;
        if (advance <= 0 || !Math.isFinite(advance)) return false;
        stage = "reserve-space";
        // Letter spacing reserves the picture's horizontal advance without enlarging the line.
        for (slot in slots) {
            var format = new TextFormat(font, size, color);
            format.letterSpacing = Math.max(0, size + 2 - advance);
            field.setTextFormat(format, offset + slot.index, offset + slot.index + 1);
        }
        for (slot in slots) {
            stage = "character-bounds";
            var bounds = field.getCharBoundaries(offset + slot.index);
            if (bounds == null || bounds.height <= 0) return false;
            stage = "sprite-construction";
            var sprite = FcmEmojiAssets.get(slot.image);
            if (sprite == null || sprite.width <= 0 || sprite.height <= 0) return false;
            sprite.scaleX = size / sprite.width;
            sprite.scaleY = size / sprite.height;
            sprite.x = field.x + bounds.x;
            sprite.y = field.y + bounds.y + (bounds.height - size) / 2;
            sprite.mouseEnabled = false;
            sprite.mouseChildren = false;
            row.addChild(sprite);
        }
        stage = "complete";
        return true;
    }
}
