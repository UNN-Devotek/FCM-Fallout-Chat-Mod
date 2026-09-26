/** Compiled widget flow against the exact xScal 0.2.18 JSON session shape. */
@:access(FCMChatWidget)
@:access(SharedHUDTools)
class XscalInputScenario {
    static function check(ok:Bool, label:String):Void if (!ok) throw label;

    public static function start(widget:FCMChatWidget, scenario:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(100);
        timer.run = function():Void {
            try {
                if (++attempts > 40) throw "xScal provider setup timed out";
                if (widget._api == null || (scenario == "xscal-period-native" && !widget._connected)) return;
                timer.stop();
                if (scenario == "xscal-period-native") {
                    periodNative(widget);
                    return;
                }
                if (scenario == "xscal-session-fallback") fallback(widget);
                else if (scenario == "xscal-shared-config") configuredShared(widget);
                else {
                    run(widget);
                    return;
                }
                flash.Lib.trace("XSCAL-SESSION-INPUT PASS " + scenario);
            } catch (error:Dynamic) {
                timer.stop();
                widget.shutdown();
                flash.Lib.trace("XSCAL-SESSION-INPUT FAIL " + Std.string(error));
            }
        };
    }

    static function run(widget:FCMChatWidget):Void {
        widget.openInput();
        check(widget._xscalSessionInput && widget._inputOpen && MockXscal.sessionBeginCount == 1,
            "xScal session opened");
        MockXscal.setSessionInput("hello!", "active");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(widget._inProgress == "hello!", "native text snapshot displayed");
        MockXscal.setSessionInput("hello", "cancelled");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(!widget._inputOpen && MockXscal.sessionEndCount == 1,
            "cancel ends without submission");
        check(widget._xscalCancelDiagnosticPending,
            "cancel arms one-shot post-cancel input diagnostic");
        widget.handleUserEvent("unmapped", true);
        check(!widget._xscalCancelDiagnosticPending,
            "first subsequent HUD event consumes diagnostic marker");
        widget.openInput();
        check(widget._xscalSessionInput && MockXscal.sessionBeginCount == 2,
            "reopen gets a new session");
        MockXscal.setSessionInput("hello", "submitted");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(!widget._inputOpen && MockXscal.sessionEndCount == 2,
            "submit ends exactly once");
        MockXscal.sessionInputBusy = true;
        widget.openInput();
        check(!widget._inputOpen && !SharedHUDTools.hasActiveEditor(),
            "busy native owner must not open SharedHUDTools");
        check(widget._promptTf != null
            && widget._promptTf.text.indexOf("xScal text input unavailable") >= 0,
            "busy native input is visible to the player");
        MockXscal.sessionInputBusy = false;
        widget.openInput();
        check(widget._xscalSessionInput && MockXscal.sessionBeginCount == 3,
            "third session opened");
        // EndInput's return is undocumented. Verify a dead old ID before reopening.
        MockXscal.sessionEndResult = "unexpected-return";
        var sentBefore = MockXscal.ordinarySendCount;
        MockXscal.setSessionInput("terminal message", "submitted");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(MockXscal.sessionEndCount == 3 && !widget._xscalSessionReleaseUncertain,
            "invalid-session probe confirms release despite unknown end result");
        widget.openInput();
        check(MockXscal.sessionBeginCount == 4 && widget._inputOpen,
            "confirmed release permits another session");
        MockXscal.sessionEndKeepsActive = true;
        MockXscal.setSessionInput("", "cancelled");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(widget._xscalSessionReleaseUncertain && !widget._inputOpen,
            "active old session keeps input fail-closed");
        widget.openInput();
        check(MockXscal.sessionBeginCount == 4 && !widget._inputOpen,
            "unreleased session prevents a competing begin");
        haxe.Timer.delay(function():Void {
            try {
                check(MockXscal.ordinarySendCount >= sentBefore + 1,
                    "submitted snapshot dispatches despite unknown end response");
                widget.shutdown();
                flash.Lib.trace("XSCAL-SESSION-INPUT PASS xscal-session-input");
            } catch (error:Dynamic) {
                widget.shutdown();
                flash.Lib.trace("XSCAL-SESSION-INPUT FAIL " + Std.string(error));
            }
        }, 250);
    }

    static function fallback(widget:FCMChatWidget):Void {
        widget.openInput();
        check(widget._inputOpen && !widget._xscalSessionInput
            && SharedHUDTools.hasActiveEditor(), "old xScal retains SharedHUDTools");
        widget.shutdown();
        check(!SharedHUDTools.hasActiveEditor() && MockXscal.sessionEndCount == 0,
            "fallback editor cleans up without a native session");
    }

    static function configuredShared(widget:FCMChatWidget):Void {
        widget._cfg.xscalInputMode = "shared";
        MockXscal.sessionInputBusy = true;
        var before = MockXscal.sessionBeginAttempts;
        widget.openInput();
        check(widget._inputOpen && !widget._xscalSessionInput && SharedHUDTools.hasActiveEditor(),
            "configured shared editor opens despite unavailable native input");
        check(MockXscal.sessionBeginAttempts == before,
            "configured shared editor never calls xScal BeginInput");
        widget.shutdown();
        check(!SharedHUDTools.hasActiveEditor() && MockXscal.sessionEndCount == 0,
            "configured host editor releases without a native session");
    }

    static function periodNative(widget:FCMChatWidget):Void {
        widget._cfg.openKey = "PERIOD";
        widget.stopPhysicalNavigation();
        widget.startPhysicalNavigation();
        check(widget._physicalOpenKey == 0xBE, "period maps to VK_OEM_PERIOD");
        MockXscal.setVirtualKey(0xBE, true);
        widget.runPhysicalNavigationSafely();
        check(widget._xscalSessionInput && widget._inputOpen
            && MockXscal.sessionBeginCount == 1,
            "period opens the xScal native session");
        MockXscal.setVirtualKey(0xBE, false);
        MockXscal.setSessionInput("", "cancelled");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(!widget._inputOpen && MockXscal.sessionEndCount == 1,
            "period session releases through xScal");
        widget._cfg.openKey = "VK_188";
        widget.stopPhysicalNavigation();
        widget.startPhysicalNavigation();
        check(widget._physicalOpenKey == 0xBC, "decimal VK token maps to comma");
        MockXscal.setVirtualKey(0xBC, true);
        widget.runPhysicalNavigationSafely();
        check(widget._xscalSessionInput && MockXscal.sessionBeginCount == 2,
            "decimal VK token opens the xScal native session");
        MockXscal.setVirtualKey(0xBC, false);
        MockXscal.setSessionInput("", "cancelled");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(!widget._inputOpen && MockXscal.sessionEndCount == 2,
            "decimal VK session releases through xScal");
        widget._cfg.openKey = "PERIOD";
        widget.stopPhysicalNavigation();
        widget.startPhysicalNavigation();
        MockXscal.sessionInputBusy = true;
        var attemptsBefore = MockXscal.sessionBeginAttempts;
        MockXscal.setVirtualKey(0xBE, true);
        widget.runPhysicalNavigationSafely();
        check(!widget._inputOpen && widget._xscalBeginAfterReleaseKey == 0xBE
            && MockXscal.sessionBeginAttempts == attemptsBefore + 1,
            "busy key-down arms one release retry");
        MockXscal.sessionInputBusy = false;
        MockXscal.setVirtualKey(0xBE, false);
        widget.runPhysicalNavigationSafely();
        check(widget._xscalSessionInput && MockXscal.sessionBeginCount == 3
            && MockXscal.sessionBeginAttempts == attemptsBefore + 2
            && widget._xscalBeginAfterReleaseKey == 0,
            "release retries BeginInput once and accepts the native session");
        widget.runPhysicalNavigationSafely();
        check(MockXscal.sessionBeginAttempts == attemptsBefore + 2,
            "idle polls cannot retry BeginInput again");
        MockXscal.setSessionInput("", "cancelled");
        widget.runXscalSessionInputSafely(widget._inputGeneration);
        check(!widget._inputOpen && MockXscal.sessionEndCount == 3,
            "release-probe session closes through xScal");
        widget.shutdown();
        flash.Lib.trace("XSCAL-SESSION-INPUT PASS xscal-period-native");
    }
}
