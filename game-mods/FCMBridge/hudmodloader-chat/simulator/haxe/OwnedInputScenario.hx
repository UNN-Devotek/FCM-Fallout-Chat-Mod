/** Deterministic ZFE input.v1 ownership, release-barrier, fallback and cleanup checks. */
@:access(FCMChatWidget)
@:access(SharedHUDTools)
class OwnedInputScenario {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, scenario:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(100);
        timer.run = function():Void {
            try {
                if (++attempts > 40) throw "input capability setup timed out";
                if (widget._api == null || !widget._ownedInputUsable) return;
                timer.stop();
                run(widget, scenario);
                flash.Lib.trace("OWNED-INPUT PASS " + scenario
                    + " session=bounded release=stable fallback=legacy cleanup=ended");
            } catch (error:Dynamic) {
                timer.stop();
                widget.shutdown();
                flash.Lib.trace("OWNED-INPUT FAIL " + scenario + " " + Std.string(error));
            }
        };
    }

    static function run(widget:FCMChatWidget, scenario:String):Void {
        widget.openInput();
        if (scenario == "owned-input-busy") {
            check(!widget._ownedInput && widget._inputOpen && SharedHUDTools.hasActiveEditor(),
                "busy owner falls back to SharedHUDTools");
            widget.shutdown();
            check(!SharedHUDTools.hasActiveEditor(), "fallback editor released on unload");
            return;
        }
        check(widget._ownedInput && widget._inputOpen && MockZfe.ownedBeginCount == 1,
            "owner-scoped session opened");
        if (scenario == "owned-input-expiry") {
            widget.pollOwnedInput();
            check(!widget._ownedInput && MockZfe.ownedEndCount == 1,
                "expired session ends ownership");
            return;
        }
        MockZfe.handleKey(65, 65, true);
        MockZfe.handleKey(49, 49, true);
        MockZfe.handleKey(8, 0, true);
        MockZfe.handleKey(13, 0, true);
        widget.pollOwnedInput();
        check(widget._ownedInput, "terminal input waits before release barrier");
        widget.pollOwnedInput();
        widget.pollOwnedInput();
        check(widget._ownedInput, "releaseReady must remain stable");
        widget.pollOwnedInput();
        check(!widget._ownedInput && MockZfe.ownedEndCount == 1,
            "stable release barrier ends exactly once");
        widget.openInput();
        check(widget._ownedInput, "rapid reopen obtains a fresh session");
        widget.shutdown();
        check(!widget._ownedInput && MockZfe.ownedEndCount == 2,
            "unload ends the owned session");
    }
}
