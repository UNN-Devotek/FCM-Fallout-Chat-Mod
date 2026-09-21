class MockZfe {
    public static var queuedSendCount(default, null):Int = 0;
    public static var ownedBeginCount(default, null):Int = 0;
    public static var ownedPollCount(default, null):Int = 0;
    public static var ownedEndCount(default, null):Int = 0;
    public static var forceOwnedBusy:Bool = false;
    public static var forceOwnedExpiry:Bool = false;
    static var inputActive:Bool = false;
    static var inputBuffer:String = "";
    static var inputSubmitted:Bool = false;
    static var hotkey:String = "INSERT";
    static var hotkeyDown:Bool = false;
    static var nextRequestId:Int = 1;
    static var ownedSession:Int = 0;
    static var ownedRevision:Int = 0;
    static var ownedCancelled:Bool = false;
    static var terminalPolls:Int = 0;

    public static function configure(scenario:String):Void {
        forceOwnedBusy = scenario == "owned-input-busy";
        forceOwnedExpiry = scenario == "owned-input-expiry";
    }

    public static function traceCompletion(kind:String):Void {
        trace("ZFE completion delivered kind=" + kind);
    }

    public static function handleKey(keyCode:Int, charCode:Int, down:Bool):Void {
        if (keyCode == FcmCommand.virtualKeyCode(hotkey)) hotkeyDown = down;
        if (!down) return;
        if (!inputActive) return;
        if (keyCode == 13) { inputSubmitted = true; ownedRevision++; return; }
        if (keyCode == 27) { ownedCancelled = true; ownedRevision++; return; }
        if (keyCode == 8) {
            if (inputBuffer.length > 0) { inputBuffer = inputBuffer.substr(0, inputBuffer.length - 1); ownedRevision++; }
            return;
        }
        if (charCode >= 32 && charCode <= 126 && inputBuffer.length < 500) {
            inputBuffer += String.fromCharCode(charCode); ownedRevision++;
        }
    }

    public static function root():Dynamic {
        var xscal:Dynamic = MockXscal.root();
        var chat:Dynamic = Reflect.field(xscal, "chatInterface");
        var out:Dynamic = {};
        Reflect.setField(out, "call", function(verb:String, payload:Dynamic = null):Dynamic {
            if (verb == "getRuntimeInfo") return haxe.Json.stringify({success:true,capabilities:[
                "zfe-storage-v1","zfe-input-v1","zfe-input-release-v1"]});
            if (verb == "input.v1.begin") {
                ownedBeginCount++;
                if (forceOwnedBusy || ownedSession != 0) return haxe.Json.stringify({success:false,error:{code:"input_busy"}});
                ownedSession = 42; ownedRevision = 0; inputActive = true; inputBuffer = "";
                inputSubmitted = false; ownedCancelled = false; terminalPolls = 0;
                return haxe.Json.stringify({success:true,session:ownedSession,revision:0,
                    rawSuppression:true,releaseBarrier:true});
            }
            if (verb == "input.v1.poll") {
                ownedPollCount++;
                if (forceOwnedExpiry) return haxe.Json.stringify({success:false,error:{code:"input_expired"}});
                if (inputSubmitted || ownedCancelled) terminalPolls++;
                return haxe.Json.stringify({success:ownedSession != 0,session:ownedSession,
                    active:inputActive,revision:ownedRevision,text:inputBuffer,
                    submitted:inputSubmitted,cancelled:ownedCancelled,
                    releaseReady:(inputSubmitted || ownedCancelled) && terminalPolls >= 2});
            }
            if (verb == "input.v1.end") {
                ownedEndCount++;
                ownedSession = 0; inputActive = false; inputSubmitted = false; ownedCancelled = false;
                return haxe.Json.stringify({success:true,status:"ended"});
            }
            if (verb == "writeStorage") {
                var args:Dynamic = haxe.Json.parse(Std.string(payload));
                if (args.vendor != "FCMServerBridge") return '{"success":false}';
                var saved = MockBridgeStorage.save(args.text);
                return haxe.Json.stringify({success:saved,status:saved ? "saved" : "failed"});
            }
            if (verb == "Input.RegisterKey" || verb == "Input.IsKeyPressed" || verb == "Input.UnregisterKey") {
                return Reflect.callMethod(xscal, Reflect.field(xscal, "call"), [verb, payload]);
            }
            if (verb == "chat.v1.getRuntimeInfo") {
                return haxe.Json.stringify({success:true, runtime:"ZFE Chat", version:"0.15.0",
                    protocol:1, capabilities:["zfe-chat-online-v1","zfe-chat-async-send-v1",
                        "zfe-chat-async-control-v1"]});
            }
            if (verb == "chat.v1.log" || verb == "log") {
                MockXscal.SimLog.emit(Std.string(payload));
                return haxe.Json.stringify({success:true});
            }
            if (verb == "setChatInputActive") {
                inputActive = Std.string(payload).toLowerCase() == "true";
                if (!inputActive) inputSubmitted = false;
                return true;
            }
            if (verb == "updateChatHotkey") { hotkey = Std.string(payload); hotkeyDown = false; return true; }
            if (verb == "isChatInputActive") return inputActive;
            if (verb == "readChatInput") return inputBuffer;
            if (verb == "clearChatInput") { inputBuffer = ""; inputSubmitted = false; return true; }
            if (verb == "consumeChatInputSubmitted") {
                var submitted = inputSubmitted;
                inputSubmitted = false;
                return submitted;
            }
            if (verb == "isChatKeyPressed") return hotkeyDown;
            var method = StringTools.startsWith(verb, "chat.v1.") ? verb.substr(8) : verb;
            if (method == "report") method = "reportMessage";
            var fn:Dynamic = Reflect.field(chat, method);
            if (!Reflect.isFunction(fn)) return haxe.Json.stringify({success:false, error:{code:"unsupported_command"}});
            var noArgs = method == "getRuntimeInfo" || method == "getConnectionState"
                || method == "disconnect" || method == "clearChatAuth";
            if (noArgs) return Reflect.callMethod(chat, fn, []);
            var args:Dynamic = {};
            if (payload != null && Std.string(payload).length > 0) {
                try args = haxe.Json.parse(Std.string(payload)) catch (_:Dynamic) {
                    return haxe.Json.stringify({success:false, error:{code:"invalid_json"}});
                }
            }
            if (method == "sendMessage") {
                var requestId:Int = nextRequestId++;
                queuedSendCount++;
                trace("ZFE queued requestId=" + requestId);
                MockXscal.SimLog.emit("ZFE queued requestId=" + requestId);
                var relayRaw:String = Std.string(Reflect.callMethod(chat, fn, [args]));
                var relayResult:Dynamic = null;
                try relayResult = haxe.Json.parse(relayRaw) catch (_:Dynamic) {}
                var accepted:Bool = relayResult != null && Reflect.field(relayResult, "success") == true;
                MockXscal.enqueueEvent(accepted
                    ? {kind:"chat.send.accepted", requestId:requestId, result:relayResult}
                    : {kind:"chat.send.failed", requestId:requestId,
                        error:relayResult == null ? {code:"invalid_response"} : Reflect.field(relayResult, "error")});
                return haxe.Json.stringify({success:true, status:"queued", requestId:requestId});
            }
            return Reflect.callMethod(chat, fn, [args]);
        });
        return out;
    }
}
