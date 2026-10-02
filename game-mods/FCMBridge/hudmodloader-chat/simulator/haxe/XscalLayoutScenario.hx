/** Exact widget path through xScal named modStorage with a truncated auth state. */
@:access(FCMChatWidget)
class XscalLayoutScenario {
    static function check(ok:Bool, label:String):Void if (!ok) throw label;

    public static function start(widget:FCMChatWidget):Void {
        var attempts:Int = 0;
        var timer = new haxe.Timer(100);
        timer.run = function():Void {
            try {
                if (++attempts > 40) throw "xScal setup timed out";
                if (widget._api == null || !widget._connected || widget._authState != "authenticated") return;
                timer.stop();
                check(widget._xscalLayoutStorage != null, "named local storage discovered");
                check(!widget._hudLayoutSupported, "truncated auth omits relay layout permission");
                check(MockXscal.localLayoutLoadCount == 1, "initial local load attempted");
                var originalX:Int = widget._cfg.x;
                widget._cfg.openKey = "HOME";
                widget._cfg.x += 20;
                widget.persistConfig();
                check(MockXscal.localLayoutSaveCount == 1 && MockXscal.layoutSendCount == 0,
                    "customization saves locally without relay layout control");
                check(MockXscal.lastLocalLayoutDocument.indexOf("openKey") < 0,
                    "keybinds are not persisted in local layout");
                widget.shutdown();
                var restored = new FcmConfig();
                restored.openKey = "PERIOD";
                var storage = FcmXscalLayoutStorage.fromRoot(MockXscal.root());
                check(storage != null && storage.load(restored) == "loaded"
                    && restored.x == originalX + 20, "fresh load restores appearance");
                check(restored.openKey == "PERIOD", "fresh INI key remains authoritative");
                flash.Lib.trace("XSCAL-LAYOUT PASS local named save=load keybind=ini");
            } catch (error:Dynamic) {
                timer.stop();
                widget.shutdown();
                flash.Lib.trace("XSCAL-LAYOUT FAIL " + Std.string(error));
            }
        };
    }
}
