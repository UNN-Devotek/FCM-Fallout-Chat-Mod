import flash.external.ExternalInterface;
import flash.events.Event;
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.net.URLRequestMethod;

class MockXscal {
    public static var callCount(default, null):Int = 0;
    public static var pollCount(default, null):Int = 0;
    public static var historyDoneDeliveries(default, null):Int = 0;
    public static var serverControlCount(default, null):Int = 0;
    public static var leaveControlCount(default, null):Int = 0;
    public static var roomDiagnosticCount(default, null):Int = 0;
    public static var asyncCompletionDeliveries(default, null):Int = 0;
    public static var authReady:Bool = true;
    public static var authPollCount(default, null):Int = 0;
    public static var connectCount(default, null):Int = 0;
    public static var ordinarySendCount(default, null):Int = 0;
    public static var giveawayMode:Bool = false;
    public static var lastGiveawayBody(default, null):String = "";
    public static var lastGiveawayChannel(default, null):String = "";
    public static var lastRosterBody(default, null):String = "";
    public static var lastRoomDiagnosticBody(default, null):String = "";
    public static var sessionInputEnabled:Bool = false;
    public static var sessionInputBusy:Bool = false;
    public static var sessionEndResult:Dynamic = true;
    public static var sessionEndKeepsActive:Bool = false;
    public static var sessionBeginCount(default, null):Int = 0;
    public static var sessionBeginAttempts(default, null):Int = 0;
    public static var sessionEndCount(default, null):Int = 0;
    static var sessionId:Int = 0;
    static var sessionRevision:Int = 0;
    static var sessionText:String = "";
    static var sessionState:String = "active";
    static var pressed:Map<Int, Bool> = new Map();
    static var registered:Map<Int, Bool> = new Map();
    static var cursor:Int = 0;
    static var scenarioEvents:Array<Dynamic> = null;
    static var serverRooms:Map<String, String> = new Map();
    static var nextServerRoom:Int = 0;

    public static function resetEvents():Void {
        scenarioEvents = [];
        cursor = 0;
        pollCount = 0;
        callCount = 0;
    }

    public static function enqueueEvent(event:Dynamic):Void {
        if (scenarioEvents == null) scenarioEvents = [];
        scenarioEvents.push(event);
    }

    public static function enqueueServerHistory(room:String):Void {
        if (scenarioEvents == null) scenarioEvents = [];
        scenarioEvents.push({kind:"chat.message", id:scenarioEvents.length + 1,
            messageId:"server:" + room + ":fast-travel-fixture", channel:"server",
            senderUserId:"sim-peer", senderDisplayName:"HarnessPeer",
            body:"Retained through same-server fast travel", targetUserId:""});
    }

    public static function enqueueServerReady(requestId:String, room:String):Void {
        if (scenarioEvents == null) scenarioEvents = [];
        scenarioEvents.push({kind:"chat.message", id:scenarioEvents.length + 1,
            messageId:"sim-retained-ready", channel:"system", senderUserId:"system", senderDisplayName:"FCM",
            body:"FCMCTL/1/SERVER-READY:" + requestId + "|" + room, targetUserId:""});
    }

    public static function enqueueRetainedHistory(marker:String, id:Int):Void {
        if (scenarioEvents == null) scenarioEvents = [];
        var messageId = "server:r:00000000-0000-4000-8000-000000000001:" + id;
        scenarioEvents.push({kind:"chat.message", id:scenarioEvents.length + 1,
            messageId:messageId, channel:"server", senderUserId:"sim-peer", senderDisplayName:"HarnessPeer",
            body:"Authorized retained history", targetUserId:"FCMHUD/1;m=" + StringTools.urlEncode(messageId)
                + (marker.length > 0 ? ";h=" + StringTools.urlEncode(marker) : "")});
    }

    public static function loadScenario(url:String):Void {
        var loader = new URLLoader();
        loader.addEventListener(Event.COMPLETE, function(_:Event):Void {
            try {
                var parsed:Dynamic = haxe.Json.parse(Std.string(loader.data));
                var incoming:Dynamic = Reflect.field(parsed, "events");
                if (Std.isOfType(incoming, Array)) {
                    scenarioEvents = cast incoming;
                    scenarioEvents.push({kind:"chat.message", id:scenarioEvents.length + 1,
                        messageId:"sim-history-done", channel:"system", senderUserId:"system",
                        senderDisplayName:"FCM", body:"FCMCTL/1/HISTORY-DONE", targetUserId:""});
                    cursor = 0;
                    pollCount = 0;
                    historyDoneDeliveries = 0;
                    SimLog.emit("HOSTED DEV snapshot loaded events=" + scenarioEvents.length);
                }
            } catch (_:Dynamic) {
                SimLog.emit("HOSTED DEV snapshot rejected");
            }
        });
        try loader.load(new URLRequest(url)) catch (_:Dynamic) {}
    }

    public static function root():Dynamic {
        var chat:Dynamic = {};
        Reflect.setField(chat, "getRuntimeInfo", function():String {
            return response({success:true, runtime:"xScal Chat", version:"sim-1", protocol:1,
                mode:"simulated", capabilities:["xscal-chat-interface"]});
        });
        Reflect.setField(chat, "connect", function(_:Dynamic):String {
            connectCount++;
            SimLog.emit("CHAT connect accepted");
            if (!authReady) return response({success:true, status:"connecting", code:"connecting"});
            return response({success:true, status:"authenticated", code:"connected"});
        });
        Reflect.setField(chat, "getAuthState", function(_:Dynamic):String {
            authPollCount++;
            if (!authReady) return response({success:true, state:"connecting", status:"connecting"});
            return response({success:true, state:"authenticated", status:"authenticated",
                userId:"sim-relay-user", linkedUserId:"sim-linked-user", canRetryHudSend:true,
                canSaveHudLayout:true, canSendRoomDiagnostics:true});
        });
        Reflect.setField(chat, "getConnectionState", function():String {
            return response({success:true, state:"authenticated", status:"authenticated"});
        });
        Reflect.setField(chat, "pollEvents", function(args:Dynamic):String {
            callCount++;
            pollCount++;
            SimLog.emit("CHAT poll cursor=" + cursor);
            if (scenarioEvents == null) {
                scenarioEvents = [];
                for (index in 0...40) scenarioEvents.push({kind:"chat.message", id:index + 1,
                    messageId:"sim-history-" + index, channel:index % 2 == 0 ? "global" : "trade",
                    senderUserId:"sim-user-1", senderDisplayName:"VaultTester",
                    body:"Deterministic history row " + index, targetUserId:""});
                scenarioEvents.push({kind:"chat.message", id:41, messageId:"sim-history-done",
                    channel:"system", senderUserId:"system", senderDisplayName:"FCM",
                    body:"FCMCTL/1/HISTORY-DONE", targetUserId:""});
            }
            if (scenarioEvents != null) {
                var max:Int = args == null ? 16 : Std.int(Reflect.field(args, "max"));
                if (max < 1) max = 1;
                if (max > 16) max = 16;
                var start:Int = args == null ? cursor : Std.int(Reflect.field(args, "cursor"));
                if (start < 0 || start > scenarioEvents.length) start = cursor;
                var end:Int = Std.int(Math.min(scenarioEvents.length, start + max));
                var hosted = scenarioEvents.slice(start, end);
                for (event in hosted) {
                    if (Reflect.field(event, "body") == "FCMCTL/1/HISTORY-DONE") historyDoneDeliveries++;
                    var kind:String = Std.string(Reflect.field(event, "kind"));
                    if (kind == "chat.send.accepted" || kind == "chat.send.failed") {
                        asyncCompletionDeliveries++;
                        MockZfe.traceCompletion(kind);
                        SimLog.emit("ZFE completion delivered kind=" + kind);
                    }
                }
                cursor = end;
                return response({success:true, cursor:cursor, events:hosted});
            }
            return response({success:true, cursor:cursor, events:[]});
        });
        Reflect.setField(chat, "sendMessage", function(args:Dynamic):String {
            callCount++;
            var body:String = args == null ? "" : Std.string(Reflect.field(args, "body"));
            var channel:String = args == null ? "global" : Std.string(Reflect.field(args, "channel"));
            var messageId:String = "sim-send-" + callCount;
            SimLog.emit("CHAT send len=" + body.length);
            if (scenarioEvents == null) scenarioEvents = [];
            if (giveawayMode && StringTools.startsWith(body, "/giveaway")) {
                lastGiveawayBody = body;
                lastGiveawayChannel = channel;
                var feedback = StringTools.startsWith(body, "/giveaway join OWN123")
                    ? "You can't enter your own giveaway."
                    : StringTools.startsWith(body, "/giveaway join ABC234")
                        ? "You've entered giveaway [ABC234]! Total entries: 1."
                        : "Giveaway started";
                return response({success:true, messageId:messageId,
                    targetUserId:"FCMHUD/1;g=" + StringTools.urlEncode(feedback)});
            }
            if (channel == "server" && StringTools.startsWith(body, "FCMCTL/1/")) {
                if (StringTools.startsWith(body, "FCMCTL/1/DIAG:")) {
                    roomDiagnosticCount++;
                    lastRoomDiagnosticBody = body;
                } else serverControlCount++;
                if (body == "FCMCTL/1/LEAVE") leaveControlCount++;
                if (StringTools.startsWith(body, "FCMCTL/1/ROSTER:")) {
                    lastRosterBody = body;
                    var target:String = Std.string(Reflect.field(args, "targetUserId"));
                    var separator:Int = target.indexOf(";");
                    var requestId:String = separator >= 0 ? target.substr(separator + 1) : "";
                    if (!serverRooms.exists(requestId)) serverRooms.set(requestId, "r:sim-room-" + (++nextServerRoom));
                    var room:String = serverRooms.get(requestId);
                    var controlId:Int = scenarioEvents.length + 1;
                    scenarioEvents.push({kind:"chat.message", id:controlId,
                        messageId:"sim-server-ready-" + controlId, channel:"system",
                        senderUserId:"system", senderDisplayName:"FCM",
                        body:"FCMCTL/1/SERVER-READY:" + requestId + "|" + room, targetUserId:""});
                }
                return response({success:true, messageId:messageId, targetUserId:""});
            }
            ordinarySendCount++;
            var nextId:Int = scenarioEvents.length + 1;
            scenarioEvents.push({kind:"chat.message", id:nextId, messageId:messageId,
                channel:channel, senderUserId:"sim-linked-user", senderDisplayName:"Simulator76",
                body:body, targetUserId:""});
            if (channel != "server") sendHostedDev(channel, body);
            return response({success:true, messageId:messageId, targetUserId:""});
        });
        Reflect.setField(chat, "reportMessage", function(_:Dynamic):String {
            callCount++;
            return response({success:true, reportId:"sim-report-" + callCount});
        });
        Reflect.setField(chat, "disconnect", function():String return response({success:true}));
        Reflect.setField(chat, "clearChatAuth", function():String return response({success:true}));

        var root:Dynamic = {chatInterface:chat};
        Reflect.setField(root, "call", function(name:String, value:Dynamic = null):Dynamic {
            callCount++;
            if (name == "GetXSRuntimeInfo") return response({runtime:"xScal", version:"sim-1", platform:"Simulator"});
            if (name == "log") { SimLog.emit(Std.string(value)); return true; }
            if (name == "Input.BeginInput") {
                sessionBeginAttempts++;
                if (!sessionInputEnabled) return false;
                if (sessionInputBusy || sessionId != 0)
                    return response({success:false,error:"input_unavailable"});
                sessionId = ++sessionBeginCount;
                sessionRevision = 0;
                sessionText = "";
                sessionState = "active";
                return response({success:true,sessionId:sessionId,revision:0,text:"",state:"active"});
            }
            if (name == "Input.PollInput") {
                if (!sessionInputEnabled || sessionId == 0 || Std.int(value) != sessionId)
                    return response({success:false,error:"invalid_session"});
                return response({success:true,sessionId:sessionId,revision:sessionRevision,
                    text:sessionText,state:sessionState});
            }
            if (name == "Input.EndInput") {
                if (sessionId == 0 || Std.int(value) != sessionId) return false;
                sessionEndCount++;
                if (!sessionEndKeepsActive) sessionId = 0;
                return sessionEndResult;
            }
            if (name == "Input.RegisterKey") {
                var registerKey:Int = Std.int(value);
                registered.set(registerKey, true);
                return true;
            }
            if (name == "Input.UnregisterKey") {
                var unregisterKey:Int = Std.int(value);
                var existed:Bool = registered.exists(unregisterKey);
                registered.remove(unregisterKey);
                pressed.remove(unregisterKey);
                return existed;
            }
            if (name == "Input.ClearKeys") {
                registered = new Map();
                pressed = new Map();
                return true;
            }
            if (name == "Input.IsKeyPressed") {
                var key:Int = Std.int(value);
                return pressed.exists(key) && pressed.get(key) == true;
            }
            return false;
        });
        return root;
    }

    public static function setPressed(action:String, down:Bool):Void {
        var key = switch (action.toLowerCase()) {
            case "up": 0x26; case "down": 0x28; case "nextpage": 0x22;
            case "prevpage": 0x21; case "insert": 0x2D; case "delete": 0x2E;
            default: 0;
        };
        if (key > 0) pressed.set(key, down);
    }

    public static function setSessionInput(text:String, state:String):Void {
        sessionText = text;
        sessionState = state;
        sessionRevision++;
    }

    public static function setVirtualKey(key:Int, down:Bool):Void {
        if (key >= 1 && key <= 255) pressed.set(key, down);
    }

    public static function registeredKeys():String {
        var keys:Array<Int> = [];
        for (key in registered.keys()) keys.push(key);
        keys.sort(function(a:Int, b:Int):Int return a - b);
        return keys.join(",");
    }

    static function sendHostedDev(channel:String, body:String):Void {
        if (ExternalInterface.available) {
            try {
                ExternalInterface.call("fcmHostedDevSend", channel, body);
            } catch (_:Dynamic) {}
            return;
        }
        var request = new URLRequest("/__fcm/hosted-dev/send");
        request.method = URLRequestMethod.POST;
        request.contentType = "application/json";
        request.data = haxe.Json.stringify({channel:channel, body:body});
        var loader = new URLLoader();
        try loader.load(request) catch (_:Dynamic) {}
    }

    static function response(value:Dynamic):String return haxe.Json.stringify(value);
}

class SimLog {
    public static var count(default, null):Int = 0;
    public static var last(default, null):String = "";
    public static var recent:Array<String> = [];
    public static function emit(value:String):Void {
        count++;
        var clean = value == null ? "" : value.split("\n").join(" ");
        if (clean.length > 500) clean = clean.substr(0, 500);
        // Ruffle paints Haxe diagnostic output over the movie. Retain bounded
        // diagnostics in memory and forward them when ExternalInterface is
        // available, but never contaminate the HUD's rendered surface.
        last = clean;
        recent.push(clean);
        if (recent.length > 32) recent.shift();
        if (ExternalInterface.available) {
            try ExternalInterface.call("fcmSimLog", clean) catch (_:Dynamic) {}
        }
    }
}
