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
        check("xScal subscriber owns initial history backfill",
            !FcmNativeApi.widgetMustRequestHistoryResync(FcmNativeApi.XSCAL));
        check("unsupported xScal command fails closed",
            Std.string(xApi.call("chat.v1.notACommand", "{}")).indexOf("unsupported_command") >= 0);
        check("xScal capability probe uses chatInterface", xApi.probeChatCapability()
            && xCalls[xCalls.length - 1] == "getRuntimeInfo|<none>");
        check("xScal without a logger fails log calls closed", Std.string(xApi.call("log", "{}")) == "");

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

        if (failures > 0) Sys.exit(1);
    }
}
