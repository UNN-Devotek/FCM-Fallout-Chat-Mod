/** Unit tests for the provider-specific asynchronous auth policy. */
class TestFcmAuthFlow {
    static var failures:Int = 0;

    static function check(name:String, condition:Bool):Void {
        if (condition) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        check("xScal connecting is pending", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "connecting", "") == FcmAuthFlow.PENDING);
        check("xScal status connecting is pending", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "", "connecting") == FcmAuthFlow.PENDING);
        check("xScal pending does not request reconnect", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "pending", "") != FcmAuthFlow.RECONNECT);
        check("xScal unauthenticated stays limited", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "unauthenticated", "") == FcmAuthFlow.LIMITED);
        check("xScal authenticated is ready", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "authenticated", "accepted") == FcmAuthFlow.AUTHENTICATED);
        check("xScal disconnected requests reconnect", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "disconnected", "") == FcmAuthFlow.RECONNECT);
        check("xScal rejected requests reconnect", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "", "auth.rejected") == FcmAuthFlow.RECONNECT);
        check("xScal auth token failure requests reconnect", FcmAuthFlow.classify(
            FcmAuthFlow.XSCAL, "", "", "auth_token_invalid") == FcmAuthFlow.RECONNECT);
        check("xScal pending transport response is not a poll failure",
            FcmAuthFlow.isPendingTransportResponse("{\"success\":false,\"code\":\"not_connected\"}"));
        check("pretty xScal connecting response is also pending",
            FcmAuthFlow.isPendingTransportResponse("{\n  \"success\": true,\n  \"status\": \"connecting\"\n}"));
        check("ordinary xScal poll failure is not classified as pending",
            !FcmAuthFlow.isPendingTransportResponse("{\"success\":false,\"code\":\"protocol_error\"}"));
        check("ZFE preserves non-auth reconnect behavior", FcmAuthFlow.classify(
            FcmAuthFlow.ZFE, "limited", "") == FcmAuthFlow.RECONNECT);

        if (failures > 0) Sys.exit(1);
    }
}
