/** Unit tests for automatic ZFE/xScal bridge selection and verb mapping. */
class TestFcmNativeApi {
    static var failures:Int = 0;

    static function payloadText(payload:Dynamic):String {
        return payload == null ? "<none>" : haxe.Json.stringify(payload);
    }

    static function check(name:String, condition:Bool):Void {
        if (condition) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        var zCalls:Array<String> = [];
        var zfe:Dynamic = {};
        zfe.call = function(verb:String, payload:String):String {
            zCalls.push(verb + "|" + payload);
            if (verb == "chat.v1.getRuntimeInfo") {
                return '{"success":true,"capabilities":["zfe-chat-online-v1"]}';
            }
            return '{"success":true,"provider":"zfe"}';
        };
        var zScope:Dynamic = {};
        Reflect.setField(zScope, "__ZFE", zfe);
        var zApi:FcmNativeApi = FcmNativeApi.discover(zScope);
        check("discovers ZFE bridge", zApi != null && zApi.provider == FcmNativeApi.ZFE);
        check("routes canonical ZFE verb", Std.string(zApi.call("chat.v1.sendMessage", "{}"))
            .indexOf('"provider":"zfe"') >= 0);
        check("ZFE uses native input", zApi.supportsNativeInput());
        check("ZFE widget requests retained-subscriber history resync",
            FcmNativeApi.widgetMustRequestHistoryResync(FcmNativeApi.ZFE));
        check("ZFE capability probe uses the ZFE chat verb", zCalls.length == 2
            && zCalls[0] == "chat.v1.getRuntimeInfo|{}");
        check("ZFE verb and payload preserved", zCalls[1] == "chat.v1.sendMessage|{}");
        check("rejects an unrecognized host object", FcmNativeApi.fromExposed({}) == null);

        // ZFE's explicit chat bridge and its legacy BRG_OBJ compatibility callback can coexist.
        // Input.* must use the generic callback with the native integer VK argument, while chat
        // continues to use __ZFE.call and never receives the physical-key operation.
        var zInputCalls:Array<String> = [];
        var zInput:Dynamic = {};
        zInput.call = function(verb:String, keyCode:Dynamic):Dynamic {
            zInputCalls.push(verb + "|" + Std.string(keyCode));
            if (verb == "Input.RegisterKey" || verb == "Input.UnregisterKey") return true;
            if (verb == "Input.IsKeyPressed") return keyCode == 0x22;
            return false;
        };
        Reflect.setField(zScope, "BRG_OBJ", zInput);
        var zInputApi:FcmNativeApi = FcmNativeApi.discover(zScope);
        check("ZFE discovers physical input compatibility callback",
            zInputApi != null && zInputApi.supportsPhysicalInput());
        check("ZFE registers Page Down with its generic callback",
            zInputApi.registerPhysicalKey(0x22));
        check("ZFE reads Page Down pressed state",
            zInputApi.isPhysicalKeyPressed(0x22));
        check("ZFE unregisters Page Down with its generic callback",
            zInputApi.unregisterPhysicalKey(0x22));
        check("ZFE physical callback receives native VK values",
            zInputCalls.length == 3
            && zInputCalls[0] == "Input.RegisterKey|34"
            && zInputCalls[1] == "Input.IsKeyPressed|34"
            && zInputCalls[2] == "Input.UnregisterKey|34");
        check("ZFE chat dispatcher never receives Input.* calls",
            zCalls.length == 3
            && zCalls[2].indexOf("Input.") < 0);

        // The real generic compatibility bridge may return null for a successful
        // RegisterKey/UnregisterKey call. The native wrapper's callSucceeded
        // result is not exposed through the raw dispatcher, so null must still
        // count as a successful mutation when no exception was raised.
        var voidInputCalls:Array<String> = [];
        var voidInput:Dynamic = {};
        voidInput.call = function(verb:String, keyCode:Dynamic):Dynamic {
            voidInputCalls.push(verb + "|" + Std.string(keyCode));
            if (verb == "Input.IsKeyPressed") return keyCode == 0x21;
            return null;
        };
        var voidInputScope:Dynamic = {};
        Reflect.setField(voidInputScope, "__ZFE", zfe);
        Reflect.setField(voidInputScope, "BRG_OBJ", voidInput);
        var voidInputApi:FcmNativeApi = FcmNativeApi.discover(voidInputScope);
        check("accepts void physical-key registration responses",
            voidInputApi != null
            && voidInputApi.registerPhysicalKey(0x21)
            && voidInputApi.isPhysicalKeyPressed(0x21)
            && voidInputApi.unregisterPhysicalKey(0x21)
            && voidInputCalls.length == 3);

        // ZFE serves Input.* from the same SFE-compatibility dispatcher that answers
        // setChatInputActive / isChatKeyPressed through __ZFE.call, and 0.12 advertises
        // zfe-input-v1 on that object. Without a separate generic callback the chat
        // dispatcher is therefore the physical-input provider, not a dead end.
        var chatOnlyCalls:Array<String> = [];
        var chatOnlyZfe:Dynamic = {};
        chatOnlyZfe.call = function(verb:String, payload:Dynamic):Dynamic {
            chatOnlyCalls.push(verb + "|" + Std.string(payload));
            if (verb == "chat.v1.getRuntimeInfo") return '{"success":true,"capabilities":["zfe-chat-online-v1"]}';
            if (verb == "Input.IsKeyPressed") return '{"success":true,"pressed":false}';
            return '{"success":true}';
        };
        var chatOnlyApi:FcmNativeApi = FcmNativeApi.fromZfe(chatOnlyZfe);
        check("uses the ZFE dispatcher for physical input when no generic callback exists",
            chatOnlyApi != null && chatOnlyApi.supportsPhysicalInput());
        check("ZFE dispatcher registration is accepted with the native VK value",
            chatOnlyApi.registerPhysicalKey(0x21)
            && chatOnlyApi.inputDispatcherName == "zfe-dispatcher"
            && chatOnlyCalls[chatOnlyCalls.length - 1] == "Input.RegisterKey|33");
        check("a successful ZFE envelope without a pressed flag is not a key-down",
            !chatOnlyApi.isPhysicalKeyPressed(0x21));
        check("last Input.* response is retained for diagnostics",
            chatOnlyApi.lastInputResponse == '{"success":true,"pressed":false}');

        // A generic callback that exists but rejects Input.* (unsupported / error) must
        // not block the fallback; the first accepting candidate is locked for later calls.
        var rejectingCalls:Array<String> = [];
        var rejecting:Dynamic = {};
        rejecting.call = function(verb:String, payload:Dynamic):Dynamic {
            rejectingCalls.push(verb + "|" + Std.string(payload));
            return '{"success":false,"error":{"code":"unsupported_command"}}';
        };
        var fallbackCalls:Array<String> = [];
        var fallbackZfe:Dynamic = {};
        var fallbackPressed:Bool = false;
        fallbackZfe.call = function(verb:String, payload:Dynamic):Dynamic {
            fallbackCalls.push(verb + "|" + Std.string(payload));
            if (verb == "chat.v1.getRuntimeInfo") return '{"success":true,"capabilities":["zfe-chat-online-v1"]}';
            if (verb == "Input.IsKeyPressed") return fallbackPressed
                ? '{"success":true,"pressed":true}' : '{"success":true,"pressed":false}';
            return '{"success":true}';
        };
        var fallbackScope:Dynamic = {};
        Reflect.setField(fallbackScope, "__ZFE", fallbackZfe);
        Reflect.setField(fallbackScope, "BRG_OBJ", rejecting);
        var fallbackApi:FcmNativeApi = FcmNativeApi.discover(fallbackScope);
        check("falls back to the ZFE dispatcher when the generic callback rejects Input.*",
            fallbackApi != null && fallbackApi.registerPhysicalKey(0x22)
            && fallbackApi.inputDispatcherName == "zfe-dispatcher"
            && rejectingCalls.length == 1 && rejectingCalls[0] == "Input.RegisterKey|34"
            && fallbackCalls[fallbackCalls.length - 1] == "Input.RegisterKey|34");
        var beforePoll:Int = rejectingCalls.length;
        check("ZFE JSON pressed=false decodes as up", !fallbackApi.isPhysicalKeyPressed(0x22));
        fallbackPressed = true;
        check("ZFE JSON pressed=true decodes as down", fallbackApi.isPhysicalKeyPressed(0x22));
        check("polling stays on the locked dispatcher", rejectingCalls.length == beforePoll
            && fallbackCalls[fallbackCalls.length - 1] == "Input.IsKeyPressed|34");
        check("second registration reuses the locked dispatcher without re-probing",
            fallbackApi.registerPhysicalKey(0x21) && rejectingCalls.length == beforePoll);
        check("unregister goes to the locked dispatcher",
            fallbackApi.unregisterPhysicalKey(0x22)
            && fallbackCalls[fallbackCalls.length - 1] == "Input.UnregisterKey|34");

        var xCalls:Array<String> = [];
        var chat:Dynamic = {};
        chat.connect = function(payload:Dynamic):String { xCalls.push("connect|" + payloadText(payload)); return '{"success":true}'; };
        chat.pollEvents = function(payload:Dynamic):String { xCalls.push("pollEvents|" + payloadText(payload)); return '{"success":true}'; };
        chat.sendMessage = function(payload:Dynamic):String { xCalls.push("sendMessage|" + payloadText(payload)); return '{"success":true}'; };
        chat.getRuntimeInfo = function():String {
            xCalls.push("getRuntimeInfo|<none>");
            return '{"success":true,"runtime":"xScal Chat","capabilities":["xscal-chat-interface"]}';
        };
        chat.getAuthState = function(payload:Dynamic):String { xCalls.push("getAuthState|" + payloadText(payload)); return '{"state":"authenticated"}'; };
        chat.reportMessage = function(payload:Dynamic):String { xCalls.push("reportMessage|" + payloadText(payload)); return '{"success":true}'; };
        var xScope:Dynamic = {};
        Reflect.setField(xScope, "__SFECodeObj", { chatInterface: chat });
        var xApi:FcmNativeApi = FcmNativeApi.discover(xScope);
        check("discovers xScal bridge", xApi != null && xApi.provider == FcmNativeApi.XSCAL);
        check("maps xScal connect", Std.string(xApi.call("chat.v1.connect", "{}"))
            .indexOf('"success":true') >= 0);
        xApi.call("chat.v1.getAuthState", "{}");
        xApi.call("chat.v1.pollEvents", "{\"cursor\":0}");
        check("maps xScal methods with object payloads", xCalls.length == 3
            && xCalls[0] == "connect|{}"
            && xCalls[1] == "getAuthState|{}"
            && xCalls[2] == "pollEvents|{\"cursor\":0}");
        xApi.call("chat.v1.report", "{\"messageId\":\"m1\"}");
        check("maps xScal report to reportMessage", xCalls.length == 4
            && xCalls[3] == "reportMessage|{\"messageId\":\"m1\"}");
        check("xScal does not claim ZFE native input", !xApi.supportsNativeInput());
        check("xScal can recover an empty retained subscriber after a HUD reload",
            FcmNativeApi.widgetMustRequestHistoryResync(FcmNativeApi.XSCAL));
        check("unsupported xScal command fails closed",
            Std.string(xApi.call("chat.v1.notACommand", "{}")).indexOf("unsupported_command") >= 0);
        check("xScal capability probe uses chatInterface", xApi.probeChatCapability()
            && xCalls[xCalls.length - 1] == "getRuntimeInfo|<none>");
        check("xScal without a logger fails log calls closed", Std.string(xApi.call("log", "{}")) == "");

        var xInputCalls:Array<String> = [];
        var xInput:Dynamic = {};
        xInput.call = function(verb:String, keyCode:Dynamic):Dynamic {
            xInputCalls.push(verb + "|" + Std.string(keyCode));
            if (verb == "Input.RegisterKey" || verb == "Input.UnregisterKey") return true;
            if (verb == "Input.IsKeyPressed") return keyCode == 0x21;
            return false;
        };
        var xInputScope:Dynamic = {};
        Reflect.setField(xInputScope, "__SFECodeObj", { chatInterface: chat });
        Reflect.setField(xInputScope, "__SFCodeObj", xInput);
        var xInputApi:FcmNativeApi = FcmNativeApi.discover(xInputScope);
        check("xScal discovers generic physical input callback",
            xInputApi != null && xInputApi.supportsPhysicalInput());
        check("xScal registers Page Up with Input.RegisterKey",
            xInputApi.registerPhysicalKey(0x21));
        check("xScal reads Page Up pressed state",
            xInputApi.isPhysicalKeyPressed(0x21));
        check("xScal unregisters Page Up with Input.UnregisterKey",
            xInputApi.unregisterPhysicalKey(0x21));
        check("xScal physical callback receives native VK values",
            xInputCalls.length == 3
            && xInputCalls[0] == "Input.RegisterKey|33"
            && xInputCalls[1] == "Input.IsKeyPressed|33"
            && xInputCalls[2] == "Input.UnregisterKey|33");
        check("xScal physical input does not route through chatInterface",
            xCalls.length == 5);

        // xScal builds that do not expose getAuthState use the documented no-argument
        // connection-state method. This must not receive the JSON placeholder payload.
        var connectionStateCalls:Array<String> = [];
        var connectionStateChat:Dynamic = {};
        connectionStateChat.getConnectionState = function():String {
            connectionStateCalls.push("getConnectionState|<none>");
            return '{"success":true,"status":"authenticated"}';
        };
        var connectionStateApi:FcmNativeApi = FcmNativeApi.fromXscal({
            chatInterface: connectionStateChat,
        });
        check("xScal auth fallback calls no-argument getConnectionState",
            connectionStateApi != null
            && Std.string(connectionStateApi.call("chat.v1.getAuthState", "{}"))
                .indexOf('"status":"authenticated"') >= 0
            && connectionStateCalls.length == 1
            && connectionStateCalls[0] == "getConnectionState|<none>");

        // A stale host-side ZFE hint must not override xScal's positive
        // chatInterface marker. This is the exact __SFCodeObj collision shape
        // seen when both extenders are installed.
        var hintedXscal:Dynamic = { chatInterface: chat };
        hintedXscal.call = function(verb:String, payload:String):String {
            return '{"success":false,"error":{"code":"dispatch_failed"}}';
        };
        var hintedApi:FcmNativeApi = FcmNativeApi.fromExposed(
            hintedXscal, FcmNativeApi.ZFE);
        check("xScal marker overrides a stale ZFE provider hint",
            hintedApi != null && hintedApi.provider == FcmNativeApi.XSCAL);
        check("fromZfe rejects an xScal chat surface",
            FcmNativeApi.fromZfe(hintedXscal) == null);

        // xScal v0.1.14 exposes both its chat interface and a generic
        // __SFCodeObj.call callback object on the movie root. The generic
        // object must never win provider discovery when the chat surface is
        // present.
        var genericXscalCalls:Array<String> = [];
        var genericXscal:Dynamic = {};
        genericXscal.call = function(verb:String, payload:String):String {
            genericXscalCalls.push(verb + "|" + payload);
            if (verb == "GetXSRuntimeInfo") return '{"runtime":"xScal","version":"0.1.14"}';
            return '{"success":false,"error":{"code":"dispatch_failed"}}';
        };
        var collisionScope:Dynamic = {};
        Reflect.setField(collisionScope, "__SFCodeObj", genericXscal);
        Reflect.setField(collisionScope, "__SFECodeObj", { chatInterface: chat });
        var collisionApi:FcmNativeApi = FcmNativeApi.discover(collisionScope);
        check("prefers xScal chat surface over generic __SFCodeObj",
            collisionApi != null && collisionApi.provider == FcmNativeApi.XSCAL);
        check("does not probe xScal generic callback when chat surface exists",
            genericXscalCalls.length == 0);

        // If both extenders are installed, the explicit xScal chat surface is
        // the stronger identity signal. A valid ZFE object must not win merely
        // because it appears under the conventional name first.
        var coinstalledZfeCalls:Array<String> = [];
        var coinstalledZfe:Dynamic = {};
        coinstalledZfe.call = function(verb:String, payload:String):String {
            coinstalledZfeCalls.push(verb + "|" + payload);
            return verb == "chat.v1.getRuntimeInfo"
                ? '{"success":true,"capabilities":["zfe-chat-online-v1"]}'
                : '{"success":true,"provider":"zfe"}';
        };
        var coinstalledScope:Dynamic = {};
        Reflect.setField(coinstalledScope, "__ZFE", coinstalledZfe);
        Reflect.setField(coinstalledScope, "__SFECodeObj", { chatInterface: chat });
        var coinstalledApi:FcmNativeApi = FcmNativeApi.discover(coinstalledScope);
        check("prefers explicit xScal when ZFE is co-installed",
            coinstalledApi != null && coinstalledApi.provider == FcmNativeApi.XSCAL);
        coinstalledApi.call("chat.v1.pollEvents", "{}");
        check("co-installed discovery never probes or routes through ZFE",
            coinstalledZfeCalls.length == 0);

        // Some xScal builds expose the same explicit chat surface directly on
        // __SFCodeObj. That property is the positive xScal discriminator; the
        // call-only shape remains ambiguous and must stay quarantined.
        var sfChatScope:Dynamic = {};
        var sfChatObject:Dynamic = { chatInterface: chat };
        Reflect.setField(sfChatObject, "call", genericXscal.call);
        Reflect.setField(sfChatScope, "__SFCodeObj", sfChatObject);
        var sfChatApi:FcmNativeApi = FcmNativeApi.discover(sfChatScope);
        check("discovers xScal chatInterface under __SFCodeObj",
            sfChatApi != null && sfChatApi.provider == FcmNativeApi.XSCAL);
        check("does not probe direct __SFCodeObj xScal callback",
            genericXscalCalls.length == 0);

        var loggerCalls:Array<String> = [];
        var logger:Dynamic = {};
        logger.call = function(verb:String, payload:String):String {
            loggerCalls.push(verb + "|" + payload);
            return "{" + '"success":true' + "}";
        };
        var loggingScope:Dynamic = {};
        Reflect.setField(loggingScope, "__SFECodeObj", { chatInterface: chat });
        Reflect.setField(loggingScope, "__SFCodeObj", logger);
        var loggingApi:FcmNativeApi = FcmNativeApi.discover(loggingScope);
        check("xScal chat discovery keeps the generic callback only as a logger",
            loggingApi != null && loggingApi.provider == FcmNativeApi.XSCAL);
        check("xScal diagnostics use the optional generic logger",
            Std.string(loggingApi.call("log", "{\"message\":\"boot\"}"))
                .indexOf('"success":true') >= 0
            && loggerCalls.length == 1
            && loggerCalls[0] == "log|{\"message\":\"boot\"}");
        check("xScal chat calls do not use the generic logger",
            loggerCalls.length == 1);

        // The widget can be a child SWF whose root is not the movie root. The
        // active xScal chat surface and its generic logger must still be found
        // from the shared main-stage object.
        var stageScope:Dynamic = {};
        var stageRoot:Dynamic = { chatInterface: chat };
        Reflect.setField(stageRoot, "call", genericXscal.call);
        var stage:Dynamic = {};
        Reflect.setField(stage, "__SFECodeObj", stageRoot);
        Reflect.setField(stage, "__SFCodeObj", logger);
        Reflect.setField(stageScope, "stage", stage);
        var stageApi:FcmNativeApi = FcmNativeApi.discover(stageScope);
        check("discovers xScal from the main-stage surface",
            stageApi != null && stageApi.provider == FcmNativeApi.XSCAL);
        stageApi.call("log", "{\"message\":\"stage\"}");
        check("finds the main-stage generic callback as diagnostics only",
            loggerCalls.length == 2 && genericXscalCalls.length == 0);

        // A legacy __SFCodeObj remains supported only when it positively
        // answers the ZFE chat capability probe.
        var legacyZfeCalls:Array<String> = [];
        var legacyZfe:Dynamic = {};
        legacyZfe.call = function(verb:String, payload:String):String {
            legacyZfeCalls.push(verb + "|" + payload);
            if (verb == "GetXSRuntimeInfo") return '{"success":false,"error":{"code":"unsupported_command"}}';
            if (verb == "chat.v1.getRuntimeInfo") return '{"success":true,"capabilities":["zfe-chat-online-v1"]}';
            return '{"success":true,"provider":"legacy-zfe"}';
        };
        var legacyScope:Dynamic = {};
        Reflect.setField(legacyScope, "__SFCodeObj", legacyZfe);
        var legacyApi:FcmNativeApi = FcmNativeApi.discover(legacyScope);
        check("accepts a legacy __SFCodeObj only as positive ZFE", legacyApi != null
            && legacyApi.provider == FcmNativeApi.ZFE);
        check("legacy probe checks xScal marker before ZFE capability",
            legacyZfeCalls.length == 2
            && legacyZfeCalls[0] == "GetXSRuntimeInfo|{}"
            && legacyZfeCalls[1] == "chat.v1.getRuntimeInfo|{}");

        var rejectedScope:Dynamic = {};
        Reflect.setField(rejectedScope, "__SFCodeObj", genericXscal);
        var rejectedApi:FcmNativeApi = FcmNativeApi.discover(rejectedScope);
        check("rejects xScal generic __SFCodeObj as ZFE", rejectedApi == null);
        check("never sends ZFE chat probe to xScal generic callback",
            genericXscalCalls.length == 1
            && genericXscalCalls[0] == "GetXSRuntimeInfo|{}");

        for (invalid in ([null, false, 1, "true", { success: true }]:Array<Dynamic>)) {
            var api = FcmNativeApi.fromExposed({ chatInterface: chat }, FcmNativeApi.XSCAL,
                { call: function(verb:String, key:Dynamic):Dynamic { return invalid; } });
            check("xScal rejects non-true Boolean registration " + Std.string(invalid), !api.registerPhysicalKey(33));
            check("xScal rejects non-true Boolean poll " + Std.string(invalid), !api.isPhysicalKeyPressed(33));
        }
        var keyCalls:Int = 0;
        var rangeApi = FcmNativeApi.fromExposed({ chatInterface: chat }, FcmNativeApi.XSCAL,
            { call: function(verb:String, key:Dynamic):Dynamic { keyCalls++; return true; } });
        for (key in [-1, 0, 256]) {
            check("invalid VK registration " + key, !rangeApi.registerPhysicalKey(key));
            check("invalid VK polling " + key, !rangeApi.isPhysicalKeyPressed(key));
            check("invalid VK unregister " + key, !rangeApi.unregisterPhysicalKey(key));
        }
        check("invalid keys never reach native bridge", keyCalls == 0);
        check("VK lower boundary", rangeApi.registerPhysicalKey(1));
        check("VK upper boundary", rangeApi.registerPhysicalKey(255));
        verifyXscalNavigationKeys(chat);
        if (failures > 0) Sys.exit(1);
    }

    /** Exercise Page, arrow, Home and End keys through the documented xScal Boolean contract. */
    static function verifyXscalNavigationKeys(chat:Dynamic):Void {
        for (placement in ["separate", "combined", "stage", "parent"]) {
            for (withZfe in [false, true]) {
                var label = "xScal navigation keys " + placement + (withZfe ? " with ZFE" : " alone");
                var registered:Map<Int, Bool> = new Map();
                var pressed:Map<Int, Bool> = new Map();
                var foreground:Bool = true;
                var unexpectedCalls:Int = 0;
                var zfeCalls:Int = 0;
                var callback:Dynamic = {};
                callback.call = function(verb:String, keyCode:Dynamic):Dynamic {
                    if (!Std.isOfType(keyCode, Int)) { unexpectedCalls++; return false; }
                    var key:Int = keyCode;
                    switch (verb) {
                        case "Input.RegisterKey": registered.set(key, true); return true;
                        case "Input.UnregisterKey": return registered.remove(key);
                        case "Input.IsKeyPressed":
                            return foreground && registered.exists(key) && pressed.exists(key) && pressed.get(key);
                        default: unexpectedCalls++; return false;
                    }
                };
                var host:Dynamic = {};
                if (placement == "combined") {
                    Reflect.setField(callback, "chatInterface", chat);
                    Reflect.setField(host, "__SFCodeObj", callback);
                } else {
                    Reflect.setField(host, "__SFECodeObj", { chatInterface: chat });
                    Reflect.setField(host, "__SFCodeObj", callback);
                }
                if (withZfe) Reflect.setField(host, "__ZFE", {
                    call: function(verb:String, payload:Dynamic):Dynamic {
                        zfeCalls++;
                        return '{"success":true}';
                    }
                });
                var scope:Dynamic = placement == "stage" ? { stage: host }
                    : (placement == "parent" ? { parent: host } : host);
                var api = FcmNativeApi.discover(scope);
                check(label + " discovers input", api != null
                    && api.provider == FcmNativeApi.XSCAL && api.supportsPhysicalInput());
                if (api == null) continue;
                for (key in [0x21, 0x22, 0x26, 0x28, 0x24, 0x23]) {
                    check(label + " accepts Boolean registration " + key, api.registerPhysicalKey(key));
                    check(label + " starts released " + key, !api.isPhysicalKeyPressed(key));
                    foreground = false;
                    pressed.set(key, true);
                    check(label + " native foreground false is respected " + key, !api.isPhysicalKeyPressed(key));
                    foreground = true;
                    pressed.set(key, false);
                    for (cycle in 0...2) {
                        pressed.set(key, true);
                        check(label + " detects press " + key, api.isPhysicalKeyPressed(key));
                        check(label + " other Page key stays released " + key,
                            !api.isPhysicalKeyPressed(key == 0x21 ? 0x22 : 0x21));
                        pressed.set(key, false);
                        check(label + " detects release " + key, !api.isPhysicalKeyPressed(key));
                    }
                }
                for (key in [0x21, 0x22, 0x26, 0x28, 0x24, 0x23]) {
                    check(label + " unregisters on unload " + key, api.unregisterPhysicalKey(key));
                    check(label + " absent registration returns false " + key, !api.unregisterPhysicalKey(key));
                    pressed.set(key, true);
                    check(label + " released registration no longer polls " + key,
                        !api.isPhysicalKeyPressed(key));
                }
                check(label + " keeps the native generic dispatcher",
                    api.inputDispatcherName == "generic-callback" && unexpectedCalls == 0
                    && zfeCalls == 0 && !registered.iterator().hasNext());
            }
        }
    }
}
