/** Pure row-local geometry for the supporter marker. */
typedef FcmStarRowPlacement = {
    var markerX:Float;
    var markerY:Float;
    var contentX:Float;
}

class FcmStarLayout {
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
