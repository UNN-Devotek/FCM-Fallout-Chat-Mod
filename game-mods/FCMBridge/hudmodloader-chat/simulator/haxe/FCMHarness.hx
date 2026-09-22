import flash.display.Sprite;
import flash.events.Event;
import flash.events.KeyboardEvent;
import flash.external.ExternalInterface;
import MockXscal.SimLog;

class FCMHarness extends Sprite {
    public var __SFECodeObj:Dynamic;
    public var __SFCodeObj:Dynamic;
    public var __ZFE:Dynamic;
    public var BSUIDataManager:Dynamic;
    var widget:FCMChatWidget;
    var provider:String = "xscal";
    var scenario:String = "";

    static function main():Void {
        flash.Lib.current.addChild(new FCMHarness());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onAddedToStage);
        try {
            // This Sprite is not attached yet; its loaderInfo is null in AVM2. Read the
            // loaded movie's parameters so ZFE/scenario tests cannot silently run xScal.
            var parameters = flash.Lib.current.loaderInfo.parameters;
            var requested = Std.string(parameters.provider).toLowerCase();
            if (requested == "zfe") provider = "zfe";
            scenario = Std.string(parameters.scenario);
        } catch (_:Dynamic) {}
        if (scenario == "quoted-echo") MockXscal.resetEvents();
        if (scenario == "delayed-auth") MockXscal.authReady = false;
        if (provider == "zfe") { MockZfe.configure(scenario); __ZFE = MockZfe.root(); }
        else __SFECodeObj = MockXscal.root();
        if (scenario == "bridge-fast-travel" && provider == "xscal") __SFCodeObj = MockBridgeStorage.root();
        // Deterministic regressions must never load a user's hosted snapshot or send live chat.
        if (scenario != "browser-links" && scenario != "fast-travel" && scenario != "bridge-fast-travel" && scenario != "delayed-auth" && scenario != "queue-loss" && scenario != "typing-renewal" && scenario != "visibility" && scenario != "quoted-echo")
            MockXscal.loadScenario("/hosted-dev-snapshot.json");
        BSUIDataManager = scenario == "bridge-fast-travel" ? MockBridgeGameData.manager() : MockGameData.manager();
        // Keep the class linked so the production getDefinitionByName path resolves it.
        var sharedClass:Class<SharedHUDTools> = SharedHUDTools;
        if (ExternalInterface.available) {
            ExternalInterface.addCallback("simDispatch", simDispatch);
            ExternalInterface.addCallback("simSubmit", simSubmit);
            ExternalInterface.addCallback("simSnapshot", simSnapshot);
            ExternalInterface.addCallback("simSetHudMode", simSetHudMode);
            ExternalInterface.addCallback("simUnload", simUnload);
            ExternalInterface.call("fcmSimLog", "SIMULATED xScal host initialized");
        }
    }

    function onAddedToStage(_:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onAddedToStage);
        stage.addEventListener(KeyboardEvent.KEY_DOWN, onStageKeyDown, false, 1000);
        stage.addEventListener(KeyboardEvent.KEY_UP, onStageKeyUp, false, 1000);
        // FCMChatWidget reads stage/root provider surfaces during construction. Creating it
        // in this harness's constructor leaves stage null under Ruffle and silently produces
        // a blank preview, while browser-side key probes continue to pass.
        try {
            if (scenario == "bridge-fast-travel") {
                var bridge = new FCMServerBridge();
                addChild(bridge); // Never coinstall the visible widget in a background-bridge scenario.
                flash.Lib.trace("HARNESS bridge constructed provider=" + provider);
                BridgeRosterScenario.start(bridge, provider);
                return;
            }
            widget = new FCMChatWidget();
            addChild(widget);
            flash.Lib.trace("HARNESS widget constructed provider=" + provider + " scenario=" + scenario);
            if (scenario == "browser-links") BrowserScenario.start(widget, provider);
            if (scenario == "fast-travel") RosterScenario.start(widget, provider);
            if (scenario == "delayed-auth") DelayedAuthScenario.start(widget, provider);
            if (scenario == "queue-loss") QueueLossScenario.start(widget, provider);
            if (scenario == "visibility") VisibilityScenario.start(widget, provider);
            if (scenario == "quoted-echo") QuotedEchoScenario.start(widget, provider);
            if (scenario == "typing-renewal") TypingRenewalScenario.start(widget, provider);
            if (scenario == "ultrawide") UltrawideScenario.start(widget, provider);
            if (scenario == "cosmetics-history") CosmeticsHistoryScenario.start(widget, provider);
            if (scenario == "server-history-chronology") ServerHistoryChronologyScenario.start(widget, provider);
            if (StringTools.startsWith(scenario, "owned-input-")) OwnedInputScenario.start(widget, scenario);
        } catch (error:Dynamic) {
            flash.Lib.trace("HARNESS widget construction failed: " + Std.string(error));
            SimLog.emit("HARNESS widget construction failed: " + Std.string(error));
        }
    }

    function onStageKeyDown(event:KeyboardEvent):Void {
        // Harness-only HUD-state controls. They let browser tests drive the same
        // BSUIDataManager subscription path without requiring game input automation.
        if (event.keyCode == 0x78) MockGameData.setHudMode("ContainerMode"); // F9
        if (event.keyCode == 0x79) MockGameData.setHudMode("All");           // F10
        if (provider == "zfe") MockZfe.handleKey(event.keyCode, event.charCode, true);
        dispatchVirtualKey(event.keyCode, true);
    }

    function onStageKeyUp(event:KeyboardEvent):Void {
        if (provider == "zfe") MockZfe.handleKey(event.keyCode, event.charCode, false);
        dispatchVirtualKey(event.keyCode, false);
    }

    function dispatchVirtualKey(keyCode:Int, down:Bool):Void {
        MockXscal.setVirtualKey(keyCode, down);
        var action = switch (keyCode) {
            case 0x2D: "INSERT";
            case 0x26: "Up";
            case 0x28: "Down";
            case 0x21: "PrevPage";
            case 0x22: "NextPage";
            case 0x2E: "DELETE";
            default:
                if (keyCode >= 0x41 && keyCode <= 0x5A) String.fromCharCode(keyCode)
                else if (keyCode >= 0x30 && keyCode <= 0x39) String.fromCharCode(keyCode)
                else if (keyCode >= 0x70 && keyCode <= 0x7B) "F" + (keyCode - 0x6F)
                else "";
        };
        if (action.length == 0) return;
        stage.dispatchEvent(new SimUserEvent(action, down));
    }

    function simDispatch(action:String, down:Bool):Bool {
        if (stage == null) return false;
        stage.dispatchEvent(new SimUserEvent(action, down));
        MockXscal.setPressed(action, down);
        return true;
    }

    function simSubmit(text:String):Bool {
        return SharedHUDTools.submitActive(text);
    }


    function simSetHudMode(mode:String):Bool {
        MockGameData.setHudMode(mode);
        return true;
    }

    function simUnload():Bool {
        if (widget != null) widget.shutdown();
        return true;
    }

    function simSnapshot():String {
        return haxe.Json.stringify({
            provider: provider,
            editorActive: SharedHUDTools.hasActiveEditor(),
            callCount: MockXscal.callCount,
            pollCount: MockXscal.pollCount,
            historyDoneDeliveries: MockXscal.historyDoneDeliveries,
            serverControlCount: MockXscal.serverControlCount,
            zfeQueuedSendCount: MockZfe.queuedSendCount,
            zfeOwnedBeginCount: MockZfe.ownedBeginCount,
            zfeOwnedPollCount: MockZfe.ownedPollCount,
            zfeOwnedEndCount: MockZfe.ownedEndCount,
            asyncCompletionDeliveries: MockXscal.asyncCompletionDeliveries,
            logCount: SimLog.count
        });
    }
}

class SimUserEvent extends Event {
    public var EventName:String;
    public var IsKeyDown:Bool;
    public function new(action:String, down:Bool) {
        super("HUDMod::UserEvent", true, false);
        EventName = action;
        IsKeyDown = down;
    }
}
