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
            return '{"success":true,"provider":"zfe"}';
        };
        var zScope:Dynamic = {};
        Reflect.setField(zScope, "__ZFE", zfe);
        var zApi:FcmNativeApi = FcmNativeApi.discover(zScope);
        check("discovers ZFE bridge", zApi != null && zApi.provider == FcmNativeApi.ZFE);
        check("routes canonical ZFE verb", Std.string(zApi.call("chat.v1.sendMessage", "{}"))
            .indexOf('"provider":"zfe"') >= 0);
        check("ZFE uses native input", zApi.supportsNativeInput());
        check("ZFE verb and payload preserved", zCalls.length == 1
            && zCalls[0] == "chat.v1.sendMessage|{}");
        check("rejects an unrecognized host object", FcmNativeApi.fromExposed({}) == null);

        var xCalls:Array<String> = [];
        var chat:Dynamic = {};
        chat.connect = function(payload:String):String { xCalls.push("connect|" + payload); return '{"success":true}'; };
        chat.pollEvents = function(payload:String):String { xCalls.push("pollEvents|" + payload); return '{"success":true}'; };
        chat.sendMessage = function(payload:String):String { xCalls.push("sendMessage|" + payload); return '{"success":true}'; };
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

        if (failures > 0) Sys.exit(1);
    }
}
