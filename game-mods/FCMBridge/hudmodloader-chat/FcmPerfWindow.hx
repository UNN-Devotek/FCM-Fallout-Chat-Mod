/**
 * Once-a-minute timing summary for the widget's own work on the game's UI thread.
 *
 * Counts event polls (and how long each took), render turns (each synchronous row
 * build or slice), rows built versus reused, and the gap between consecutive
 * frames the widget sees. The game advances the HUD movie once per rendered
 * frame, so a long gap is a frame hitch whatever caused it. Gaps longer than
 * PAUSE_MS are loading screens or a paused movie and are counted separately.
 *
 * Pure logic with an injected clock so it runs under the Haxe interpreter tests.
 */
class FcmPerfWindow {
    public static inline var WINDOW_MS:Float = 60000;
    /** A frame gap at or above this is a visible hitch (about three frames at 60 fps). */
    public static inline var HITCH_MS:Float = 50;
    /** Longer gaps are loading screens or a paused movie, not hitches. */
    public static inline var PAUSE_MS:Float = 2000;

    var windowStart:Float = -1;
    var lastFrameAt:Float = -1;

    public var polls(default, null):Int = 0;
    public var emptyPolls(default, null):Int = 0;
    public var pollTotalMs(default, null):Float = 0;
    public var pollMaxMs(default, null):Float = 0;
    public var renderTurns(default, null):Int = 0;
    public var renderMaxMs(default, null):Float = 0;
    public var rowsBuilt(default, null):Int = 0;
    public var rowsReused(default, null):Int = 0;
    public var frames(default, null):Int = 0;
    public var frameMaxGapMs(default, null):Float = 0;
    public var hitches(default, null):Int = 0;
    public var pauses(default, null):Int = 0;

    public function new() {}

    public function notePoll(ms:Float, events:Int):Void {
        if (!Math.isFinite(ms) || ms < 0) ms = 0;
        polls++;
        if (events <= 0) emptyPolls++;
        pollTotalMs += ms;
        if (ms > pollMaxMs) pollMaxMs = ms;
    }

    public function noteRenderTurn(ms:Float):Void {
        if (!Math.isFinite(ms) || ms < 0) ms = 0;
        renderTurns++;
        if (ms > renderMaxMs) renderMaxMs = ms;
    }

    public function noteRows(built:Int, reused:Int):Void {
        if (built > 0) rowsBuilt += built;
        if (reused > 0) rowsReused += reused;
    }

    public function noteFrame(now:Float):Void {
        if (lastFrameAt >= 0) {
            var gap:Float = now - lastFrameAt;
            if (gap >= PAUSE_MS) {
                pauses++;
            } else if (gap >= 0) {
                frames++;
                if (gap > frameMaxGapMs) frameMaxGapMs = gap;
                if (gap >= HITCH_MS) hitches++;
            }
        }
        lastFrameAt = now;
    }

    /** The summary line once WINDOW_MS has passed (then resets), otherwise null. */
    public function summaryIfDue(now:Float):Null<String> {
        if (windowStart < 0) { windowStart = now; return null; }
        var elapsed:Float = now - windowStart;
        if (elapsed < WINDOW_MS) return null;
        var avg:Float = polls > 0 ? pollTotalMs / polls : 0;
        var line:String = "window=" + Math.round(elapsed / 1000) + "s"
            + " polls=" + polls + " empty=" + emptyPolls
            + " pollAvg=" + round1(avg) + "ms pollMax=" + round1(pollMaxMs) + "ms"
            + " renderTurns=" + renderTurns + " renderMax=" + round1(renderMaxMs) + "ms"
            + " rowsBuilt=" + rowsBuilt + " rowsReused=" + rowsReused
            + " frames=" + frames + " frameMaxGap=" + round1(frameMaxGapMs) + "ms"
            + " hitches>=" + Std.int(HITCH_MS) + "ms=" + hitches + " pauses=" + pauses;
        reset(now);
        return line;
    }

    function reset(now:Float):Void {
        windowStart = now;
        polls = 0; emptyPolls = 0; pollTotalMs = 0; pollMaxMs = 0;
        renderTurns = 0; renderMaxMs = 0; rowsBuilt = 0; rowsReused = 0;
        frames = 0; frameMaxGapMs = 0; hitches = 0; pauses = 0;
    }

    static function round1(v:Float):Float {
        return Math.round(v * 10) / 10;
    }
}
