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
        Sys.println("FCM render-generation tests passed");
    }
}
