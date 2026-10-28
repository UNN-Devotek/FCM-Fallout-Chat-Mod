/** Local presentation only: the editor owns text, selection and key handling. */
class FcmInputCaret {
    public var visible(default, null):Bool = false;
    public var position(default, null):Int = -1;
    var active:Bool = false;
    var length:Int = -1;
    var changedAt:Float = 0;

    public function new() {}
    public function activity(now:Float):Void { changedAt = now; }

    public function observe(now:Float, editing:Bool, focused:Bool, textLength:Int,
            index:Int, selected:Bool = false):Bool {
        if (!editing || !focused || index < 0 || index > textLength) {
            active = false; visible = false; position = -1;
            return false;
        }
        if (!active || position != index || length != textLength) activity(now);
        active = true; position = index; length = textLength;
        visible = !selected && Std.int(Math.max(0, now - changedAt) / 500) % 2 == 0;
        return visible;
    }

    #if flash
    public var marker(default, null):flash.display.Sprite = null;

    /** Attach beside the actual editor, in its coordinate space. No marker glyph
     * ever enters TextField.text, a draft, a submit callback, or a relay payload. */
    public function updateField(field:flash.text.TextField, now:Float, color:Int):Void {
        var focused = field != null && field.stage != null && field.stage.focus == field;
        var shown = field != null && observe(now, field.visible && field.parent != null,
            focused, field.length, field.caretIndex, field.selectionBeginIndex != field.selectionEndIndex);
        if (!shown) { if (marker != null) marker.visible = false; return; }
        if (marker == null) {
            marker = new flash.display.Sprite();
            marker.mouseEnabled = false; marker.mouseChildren = false;
        }
        if (marker.parent != field.parent) {
            if (marker.parent != null) marker.parent.removeChild(marker);
            field.parent.addChild(marker);
        }
        marker.transform.matrix = field.transform.matrix;
        var line = field.length == 0 ? 0 : position == field.length
            ? field.numLines - 1 : field.getLineIndexOfChar(position);
        var metrics = field.getLineMetrics(line);
        var px:Float = metrics.x;
        var py:Float = 2;
        for (i in 0...line) py += field.getLineMetrics(i).height;
        var bounds = field.length == 0 ? null
            : field.getCharBoundaries(position < field.length ? position : position - 1);
        if (bounds != null) {
            px = bounds.x;
            if (position == field.length) {
                var last = field.text.charAt(position - 1);
                if (last != "\n" && last != "\r") px += bounds.width;
                else px = metrics.x;
            }
        }
        px -= field.scrollH;
        for (i in 0...field.scrollV - 1) py -= field.getLineMetrics(i).height;
        var height = Math.min(metrics.ascent + metrics.descent, field.height - py - 2);
        marker.graphics.clear();
        marker.visible = px >= 0 && px <= field.width - 2 && py >= 0 && height > 0;
        if (marker.visible) {
            marker.graphics.beginFill(color);
            marker.graphics.drawRect(px, py, 2, height);
            marker.graphics.endFill();
        }
    }

    public function clear():Void {
        observe(0, false, false, 0, -1);
        if (marker != null) {
            marker.visible = false;
            if (marker.parent != null) marker.parent.removeChild(marker);
        }
    }
    #end
}
