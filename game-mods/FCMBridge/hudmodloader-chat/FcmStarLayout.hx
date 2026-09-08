/** Pure row-local geometry for the supporter marker. */
class FcmStarLayout {
    /** Align actual vector bounds to the first author glyph in row coordinates. */
    public static function alignMarker(authorY:Float, authorHeight:Float, markerY:Float, markerHeight:Float):Float {
        return authorY + authorHeight / 2 - markerY - markerHeight / 2;
    }

    /** Reserve at least the vector width plus its gap using measured, non-breaking spaces. */
    public static inline function markerSpaces(markerWidth:Float, gap:Float, measuredSpace:Float, fontSize:Float):Int {
        var space = Math.isFinite(measuredSpace) && measuredSpace > 0 ? measuredSpace : Math.max(1, fontSize * 0.25);
        return Std.int(Math.max(1, Math.min(64, Math.ceil((markerWidth + gap) / space))));
    }
}
