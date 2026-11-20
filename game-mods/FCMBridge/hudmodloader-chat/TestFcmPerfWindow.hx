class TestFcmPerfWindow {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        var p = new FcmPerfWindow();
        check("first call only starts the window", p.summaryIfDue(1000) == null);

        p.notePoll(2, 0);
        p.notePoll(6, 3);
        p.notePoll(-5, 0);
        check("polls counted", p.polls == 3);
        check("empty polls counted", p.emptyPolls == 2);
        check("negative poll time clamps to zero", p.pollTotalMs == 8);
        check("poll max tracked", p.pollMaxMs == 6);

        p.noteRenderTurn(12);
        p.noteRenderTurn(4);
        check("render turns counted", p.renderTurns == 2);
        check("render max tracked", p.renderMaxMs == 12);
        p.noteRows(1, 44);
        p.noteRows(0, 45);
        check("rows built summed", p.rowsBuilt == 1);
        check("rows reused summed", p.rowsReused == 89);

        p.noteFrame(1000);
        check("first frame has no gap", p.frames == 0);
        p.noteFrame(1016);
        p.noteFrame(1033);
        p.noteFrame(1100);
        p.noteFrame(5000);
        p.noteFrame(5017);
        check("normal and hitch frames counted", p.frames == 4);
        check("max gap ignores pauses", p.frameMaxGapMs == 67);
        check("hitch at or over 50 ms counted", p.hitches == 1);
        check("loading-screen gap counted as a pause", p.pauses == 1);

        check("not due before a minute", p.summaryIfDue(60999) == null);
        var line = p.summaryIfDue(61000);
        check("due after a minute", line != null);
        check("summary reports polls", line.indexOf("polls=3 empty=2") >= 0);
        check("summary reports average", line.indexOf("pollAvg=2.7ms") >= 0);
        check("summary reports reuse", line.indexOf("rowsBuilt=1 rowsReused=89") >= 0);
        check("summary reports hitches", line.indexOf("hitches>=50ms=1 pauses=1") >= 0);
        check("summary resets counters", p.polls == 0 && p.hitches == 0 && p.rowsReused == 0);
        check("next window starts at the summary", p.summaryIfDue(120999) == null);
        check("next window becomes due", p.summaryIfDue(121000) != null);
    }
}
