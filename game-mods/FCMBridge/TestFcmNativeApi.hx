/** Unit tests for automatic ZFE/xScal bridge selection and verb mapping. */
class TestFcmNativeApi {
    static var failures:Int = 0;

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
        check("ZFE capability probe uses the ZFE chat verb", zCalls.length == 2
            && zCalls[0] == "chat.v1.getRuntimeInfo|{}");
        check("ZFE verb and payload preserved", zCalls[1] == "chat.v1.sendMessage|{}");
        check("rejects an unrecognized host object", FcmNativeApi.fromExposed({}) == null);

        var xCalls:Array<String> = [];
        var chat:Dynamic = {};
        chat.connect = function(payload:String):String { xCalls.push("connect|" + payload); return '{"success":true}'; };
        chat.pollEvents = function(payload:String):String { xCalls.push("pollEvents|" + payload); return '{"success":true}'; };
        chat.sendMessage = function(payload:String):String { xCalls.push("sendMessage|" + payload); return '{"success":true}'; };
        chat.getRuntimeInfo = function(payload:String):String {
            xCalls.push("getRuntimeInfo|" + payload);
            return '{"success":true,"runtime":"xScal Chat","capabilities":["xscal-chat-interface"]}';
        };
        chat.getAuthState = function(payload:String):String { xCalls.push("getAuthState|" + payload); return '{"state":"authenticated"}'; };
        chat.reportMessage = function(payload:String):String { xCalls.push("reportMessage|" + payload); return '{"success":true}'; };
        var xScope:Dynamic = {};
        Reflect.setField(xScope, "__SFECodeObj", { chatInterface: chat });
        var xApi:FcmNativeApi = FcmNativeApi.discover(xScope);
        check("discovers xScal bridge", xApi != null && xApi.provider == FcmNativeApi.XSCAL);
        check("maps xScal connect", Std.string(xApi.call("chat.v1.connect", "{}"))
            .indexOf('"success":true') >= 0);
        xApi.call("chat.v1.getAuthState", "{}");
        xApi.call("chat.v1.pollEvents", "{\"cursor\":0}");
        check("maps xScal methods without chat.v1 prefix", xCalls.length == 3
            && xCalls[0] == "connect|{}"
            && xCalls[1] == "getAuthState|{}"
            && xCalls[2] == "pollEvents|{\"cursor\":0}");
        xApi.call("chat.v1.report", "{\"messageId\":\"m1\"}");
        check("maps xScal report to reportMessage", xCalls.length == 4
            && xCalls[3] == "reportMessage|{\"messageId\":\"m1\"}");
        check("xScal does not claim ZFE native input", !xApi.supportsNativeInput());
        check("unsupported xScal command fails closed",
            Std.string(xApi.call("chat.v1.notACommand", "{}")).indexOf("unsupported_command") >= 0);
        check("xScal capability probe uses chatInterface", xApi.probeChatCapability()
            && xCalls[xCalls.length - 1] == "getRuntimeInfo|{}");

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
