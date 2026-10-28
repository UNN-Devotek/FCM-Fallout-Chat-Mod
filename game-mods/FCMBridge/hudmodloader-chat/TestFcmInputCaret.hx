class TestFcmInputCaret {
    static function check(value:Bool, label:String):Void { if (!value) throw label; }
    static function main():Void {
        var caret = new FcmInputCaret();
        check(!caret.observe(0, false, false, 0, 0), "idle editor has no caret");
        check(caret.observe(100, true, true, 0, 0), "empty focused editor starts visible");
        check(!caret.observe(600, true, true, 0, 0), "caret hides after half a second");
        check(caret.observe(1100, true, true, 0, 0), "caret blinks back on");
        check(caret.observe(1600, true, true, 4, 4), "typing resets blink");
        check(caret.observe(2100, true, true, 4, 2) && caret.position == 2, "left movement resets blink at new position");
        check(caret.observe(2600, true, true, 4, 3) && caret.position == 3, "right movement resets blink");
        check(!caret.observe(2700, true, true, 4, 3, true), "selection hides insertion caret");
        check(!caret.observe(2800, true, false, 4, 3), "focus loss hides caret");
        check(caret.observe(2900, true, true, 4, 3), "regaining focus resets blink");
        check(!caret.observe(3000, false, true, 4, 3), "closed editor hides caret immediately");
        check(!caret.observe(3100, true, true, 4, 5), "invalid caret is hidden");
        Sys.println("PASS FcmInputCaret");
    }
}
