/** Pure row-local geometry for the supporter marker. */
typedef FcmStarRowPlacement = {
    var markerX:Float;
    var markerY:Float;
    var contentX:Float;
}

class FcmStarLayout {
    /** Align actual vector bounds to the first author glyph in row coordinates. */
    public static function alignMarker(authorY:Float, authorHeight:Float, markerY:Float, markerHeight:Float):Float {
        return authorY + authorHeight / 2 - markerY - markerHeight / 2;
    }

    /** Preserve the marker slot, or put text underneath it in a very narrow box. */
    public static function content(viewportWidth:Float, origin:Float, fontSize:Float, narrowIndent:Float = 0):{x:Float,y:Float,width:Float} {
        var below = viewportWidth - origin < fontSize * 4;
        var x = below ? Math.max(0,Math.min(viewportWidth-1,narrowIndent)) : origin;
        return {x:x, y:below ? fontSize + 8 : 0.0, width:Math.max(1,viewportWidth-x)};
    }

    /**
     * Reserve the marker slot in the same row layout as the text.
     *
     * `channelWidth` is measured by the channel TextField itself. The marker and
     * message TextField are then siblings inside one row Sprite, so no global/local
     * transform, document index, or scroll estimate is involved.
     */
    public static function row(channelWidth:Float, lineHeight:Float, markerSize:Float,
            channelGap:Float, markerGap:Float, hasMarker:Bool,
            markerOffsetY:Float = 0):FcmStarRowPlacement {
        var markerX:Float = channelWidth + channelGap;
        return {
            markerX: markerX,
            markerY: Math.max(0, (lineHeight - markerSize) / 2 + markerOffsetY),
            contentX: hasMarker ? markerX + markerSize + markerGap : markerX
        };
    }
}
