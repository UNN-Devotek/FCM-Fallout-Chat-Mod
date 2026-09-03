/** Pure geometry for the supporter marker's measured feed placement. */
typedef FcmStarPlacement = {
    var x:Float;
    var y:Float;
}

class FcmStarLayout {
    /** Place the marker after the measured channel tag and center it on the author line. */
    public static function betweenChannelAndAuthor(channelEndX:Float, authorY:Float,
            authorHeight:Float, markerSize:Float, gap:Float):FcmStarPlacement {
        return {
            x: channelEndX + gap,
            y: authorY + (authorHeight - markerSize) / 2
        };
    }
}
