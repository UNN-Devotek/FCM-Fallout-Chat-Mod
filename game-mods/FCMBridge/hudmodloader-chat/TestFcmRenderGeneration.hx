class TestFcmRenderGeneration {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        var gate = new FcmRenderGeneration();
        var first = gate.begin();
        check("first render token is current", gate.isCurrent(first));

        var second = gate.begin();
        check("new render invalidates the previous callback", !gate.isCurrent(first));
        check("new render token is current", gate.isCurrent(second));

        var third = gate.invalidate();
        check("rebuild invalidates the active callback", !gate.isCurrent(second));
        check("invalidation produces a fresh generation", gate.isCurrent(third));

        check("stale callbacks cannot become current", !gate.isCurrent(first));
        var calls = 0;
        var failures = 0;
        var pending = gate.begin();
        var delayed = function() {
            gate.runCurrent(pending, function() { calls++; throw "row layout failed"; }, function(error) {
                check("failure reaches the shared fallback", error == "row layout failed");
                failures++;
                gate.invalidate();
            });
        };
        // Invoke outside the scheduling stack, as Flash's next Timer tick does.
        delayed();
        check("delayed layout failure is contained", calls == 1 && failures == 1);
        delayed();
        check("failed generation cannot resume rendering", calls == 1 && failures == 1);
        var current = gate.begin();
        gate.runCurrent(current, function() { calls++; }, function(_) { failures++; });
        check("next render can recover", calls == 2 && failures == 1);
        gate.runCurrent(current, function() { gate.begin(); throw "superseded"; }, function(_) { failures++; });
        check("stale failure cannot replace a newer feed", failures == 1);
        Sys.println("FCM render-generation tests passed");
    }
}
