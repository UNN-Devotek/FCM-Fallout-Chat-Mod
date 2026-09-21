class MockZfe {
    public static var queuedSendCount(default, null):Int = 0;
    public static var ownedBeginCount(default, null):Int = 0;
    public static var ownedPollCount(default, null):Int = 0;
    public static var ownedEndCount(default, null):Int = 0;
    static var ownedMode:String = "release";
    static var inputActive:Bool = false;
    static var inputBuffer:String = "";
    static var inputSubmitted:Bool = false;
    static var hotkey:String = "INSERT";
    static var hotkeyDown:Bool = false;
    static var nextRequestId:Int = 1;
    static var ownedSession:Int = 0;
    static var ownedRevision:Int = 0;
    static var ownedCancelled:Bool = false;
    static var ownedKeysDown:Int = 0;
    static var nextRegistration:Int = 1;
    static var hotkeyRegistrations:Map<Int, Int> = new Map();
    static var hotkeyPresses:Map<Int, Int> = new Map();

    public static function configure(scenario:String):Void {
        ownedMode = scenario == "owned-input-busy" ? "busy"
            : scenario == "owned-input-expiry" ? "expiry" : "release";
        ownedBeginCount = 0; ownedPollCount = 0; ownedEndCount = 0;
        ownedSession = 0; ownedRevision = 0; ownedCancelled = false; ownedKeysDown = 0;
        inputBuffer = ""; inputSubmitted = false;
        hotkeyRegistrations = new Map(); hotkeyPresses = new Map(); nextRegistration = 1;
    }

    public static function traceCompletion(kind:String):Void {
        trace("ZFE completion delivered kind=" + kind);
    }

    public static function handleKey(keyCode:Int, charCode:Int, down:Bool):Void {
        if (keyCode == FcmCommand.virtualKeyCode(hotkey)) hotkeyDown = down;
        if (down) {
            for (registration in hotkeyRegistrations.keys()) {
                if (hotkeyRegistrations.get(registration) == keyCode && ownedSession == 0) {
                    hotkeyPresses.set(registration, (hotkeyPresses.exists(registration)
                        ? hotkeyPresses.get(registration) : 0) + 1);
                }
            }
        }
        if (ownedSession != 0) {
            if (down) ownedKeysDown++ else if (ownedKeysDown > 0) ownedKeysDown--;
            if (!down) return;
            if (keyCode == 13) { inputSubmitted = true; return; }
            if (keyCode == 27) { ownedCancelled = true; return; }
            if (keyCode == 8 || keyCode == 46) {
                if (inputBuffer.length > 0) { inputBuffer = inputBuffer.substr(0, inputBuffer.length - 1); ownedRevision++; }
                return;
            }
            if (charCode >= 32 && charCode <= 126 && inputBuffer.length < 500) {
                inputBuffer += String.fromCharCode(charCode); ownedRevision++;
            }
            return;
        }
        if (!down) return;
        if (!inputActive) return;
        if (keyCode == 13) { inputSubmitted = true; return; }
        if (keyCode == 8) {
            if (inputBuffer.length > 0) inputBuffer = inputBuffer.substr(0, inputBuffer.length - 1);
            return;
        }
        if (charCode >= 32 && charCode <= 126 && inputBuffer.length < 500) inputBuffer += String.fromCharCode(charCode);
    }

    public static function root():Dynamic {
        var xscal:Dynamic = MockXscal.root();
        var chat:Dynamic = Reflect.field(xscal, "chatInterface");
        var out:Dynamic = {};
        Reflect.setField(out, "call", function(verb:String, payload:Dynamic = null):Dynamic {
            if (verb == "getRuntimeInfo") return haxe.Json.stringify({success:true,capabilities:[
                "zfe-storage-v1","zfe-input-v1","zfe-input-release-v1","zfe-hotkeys-v1"]});
            if (verb == "input.v1.begin") {
                ownedBeginCount++;
                if (ownedMode == "busy") return '{"success":false,"error":{"code":"input_busy"}}';
                if (ownedSession != 0) return '{"success":false,"error":{"code":"input_busy"}}';
                ownedSession = 42; ownedRevision = 0; inputBuffer = ""; inputSubmitted = false;
                ownedCancelled = false; ownedKeysDown = 0;
                return haxe.Json.stringify({success:true,session:ownedSession,revision:0,
                    rawSuppression:true,releaseBarrier:true});
            }
            if (verb == "input.v1.poll") {
                ownedPollCount++;
                if (ownedMode == "expiry") return '{"success":false,"error":{"code":"input_expired"}}';
                return haxe.Json.stringify({success:ownedSession != 0,
                session:ownedSession,active:ownedSession != 0,revision:ownedRevision,text:inputBuffer,
                submitted:inputSubmitted,cancelled:ownedCancelled,
                releaseReady:(inputSubmitted || ownedCancelled) && ownedKeysDown == 0});
            }
            if (verb == "input.v1.end") {
                ownedEndCount++;
                ownedSession = 0; inputSubmitted = false; ownedCancelled = false; ownedKeysDown = 0;
                return '{"success":true,"status":"ended"}';
            }
            if (verb == "hotkeys.v1.register") {
                var args:Dynamic = haxe.Json.parse(Std.string(payload));
                var code = FcmCommand.virtualKeyCode(Std.string(args.key));
                if (code <= 0) return '{"success":false}';
                var registration = nextRegistration++;
                hotkeyRegistrations.set(registration, code); hotkeyPresses.set(registration, 0);
                return haxe.Json.stringify({success:true,registration:registration});
            }
            if (verb == "hotkeys.v1.poll") {
                var args:Dynamic = haxe.Json.parse(Std.string(payload));
                var registration:Int = Std.int(args.registration);
                var count = hotkeyPresses.exists(registration) ? hotkeyPresses.get(registration) : 0;
                hotkeyPresses.set(registration, 0);
                return haxe.Json.stringify({success:hotkeyRegistrations.exists(registration),
                    registration:registration,presses:count});
            }
            if (verb == "hotkeys.v1.unregister") {
                var args:Dynamic = haxe.Json.parse(Std.string(payload));
                var registration:Int = Std.int(args.registration);
                hotkeyRegistrations.remove(registration); hotkeyPresses.remove(registration);
                return '{"success":true}';
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
