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
                    + " session=bounded release=stable fallback=shared cleanup=ended");
            } catch (error:Dynamic) {
                timer.stop();
                widget.shutdown();
                flash.Lib.trace("OWNED-INPUT FAIL " + scenario + " " + Std.string(error));
            }
        };
    }

    static function run(widget:FCMChatWidget, scenario:String):Void {
        if (scenario == "owned-input-controller-open") {
            // Simulate physical Insert reaching Input.* while ZFE's exact-chord
            // hotkey and legacy chat-key watcher report no edge in controller mode.
            SharedHUDTools.controllerMode = true;
            widget._connected = true;
            check(MockXscal.registeredKeys().split(",").indexOf("45") >= 0,
                "ZFE keeps physical Insert registered alongside its owner hotkey");
            MockXscal.setVirtualKey(45, true);
            widget.pollPhysicalNavigation();
            MockXscal.setVirtualKey(45, false);
            widget.pollPhysicalNavigation();
            check(widget._inputOpen && SharedHUDTools.hasActiveEditor(),
                "physical Insert opens the host editor without an owner-hotkey edge");
            check(SharedHUDTools.oskX == 0 && SharedHUDTools.oskY <= -180,
                "ZFE controller keyboard stays outside the viewport");
            check(SharedHUDTools.physicalKeyboardFocused(),
                "ZFE redirects host focus to its visible keyboard entry field");
            SharedHUDTools.restoreControllerFocus();
            widget.pollSharedInputDiagnostics(widget._inputGeneration);
            check(SharedHUDTools.physicalKeyboardFocused(),
                "delayed host controller focus is handed back to the visible entry");
            widget.shutdown();
            SharedHUDTools.controllerMode = false;
            check(!SharedHUDTools.hasActiveEditor(), "controller editor released on unload");
            return;
        }
        if (scenario == "owned-input-hotkey") {
            // The documented ZFE poll reply has no registration echo. Insert now
            // opens the host editor with Fallout's ControlMap lock.
            widget._connected = true;
            MockZfe.handleKey(45, 0, true);
            widget.pollOwnedHotkeysSafely();
            MockZfe.handleKey(45, 0, false);
            check(!widget._ownedInput && widget._inputOpen && SharedHUDTools.hasActiveEditor()
                    && MockZfe.ownedBeginCount == 0,
                "Insert hotkey opens the host ControlMap editor");
            for (action in ["Forward", "Map", "QuickMap", "QuickInventory"]) {
                check(widget.fcmHandleHostUserEvent(action, true), "host editor consumes " + action);
                check(widget._inputOpen && SharedHUDTools.hasActiveEditor(),
                    "host editor remains active after " + action);
            }
            widget.shutdown();
            check(!SharedHUDTools.hasActiveEditor(), "host editor released on unload");
            return;
        }
        if (scenario == "owned-input-busy") {
            widget.openInput();
            check(!widget._ownedInput && widget._inputOpen && SharedHUDTools.hasActiveEditor(),
                "busy ZFE input.v1 does not displace SharedHUDTools");
            check(MockZfe.ownedBeginCount == 0, "default route does not probe busy input.v1");
            widget.shutdown();
            check(!SharedHUDTools.hasActiveEditor(), "host editor released on unload");
            return;
        }
        check(widget.openOwnedInput(), "explicit owned-input diagnostic begins");
        check(widget._ownedInput && widget._inputOpen && MockZfe.ownedBeginCount == 1,
            "owner-scoped session opened");
        if (scenario == "owned-input-map") {
            check(widget.fcmHandleHostUserEvent("Forward", true), "movement action is consumed by HUD");
            check(widget._ownedInput && widget._inputOpen, "movement action keeps text owner");
            check(widget.fcmHandleHostUserEvent("QuickMap", true), "mapped M is consumed by HUD");
            check(widget.fcmHandleHostUserEvent("Map", true), "Map alias is consumed by HUD");
            check(widget.fcmHandleHostUserEvent("QuickInventory", true), "mapped I is consumed by HUD");
            check(widget._ownedInput && widget._inputOpen && MockZfe.ownedEndCount == 0,
                "mapped M does not release text owner");
            widget.shutdown();
            check(MockZfe.ownedEndCount == 1, "map scenario releases session on unload");
            return;
        }
        if (scenario == "owned-input-expiry") {
            widget.pollOwnedInput();
            check(!widget._ownedInput && MockZfe.ownedEndCount == 1,
                "expired session ends ownership");
            return;
        }
        MockZfe.handleKey(65, 65, true); MockZfe.handleKey(65, 65, false);
        MockZfe.handleKey(8, 0, true); MockZfe.handleKey(8, 0, false);
        MockZfe.handleKey(66, 66, true); MockZfe.handleKey(66, 66, false);
        MockZfe.handleKey(13, 0, true);
        widget.pollOwnedInput();
        check(widget._ownedInput, "terminal input waits while Enter is held");
        MockZfe.handleKey(13, 0, false);
        widget.pollOwnedInput(); widget.pollOwnedInput();
        check(widget._ownedInput, "releaseReady must remain stable");
        widget.pollOwnedInput();
        check(!widget._ownedInput && MockZfe.ownedEndCount == 1,
            "stable release barrier ends exactly once");
        check(widget.openOwnedInput(), "explicit diagnostic session reopens");
        check(widget._ownedInput, "rapid reopen obtains a fresh session");
        widget.shutdown();
        check(!widget._ownedInput && MockZfe.ownedEndCount == 2,
            "unload ends the owned session");
    }
}
