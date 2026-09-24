class TestFcmXscalInput {
    static function check(label:String, ok:Bool):Void if (!ok) throw label;
    static function main():Void {
        var begin = FcmXscalInput.begin('{"success":true,"sessionId":1,"revision":0,"text":"","state":"active"}');
        check("begin", begin.success && FcmXscalInput.sameSession(begin.sessionId, 1));
        check("begin fails closed", !FcmXscalInput.begin('{"success":false,"sessionId":2}').success);
        check("older xScal is unsupported", FcmXscalInput.begin(false).unsupported);
        check("native busy is retryable", FcmXscalInput.begin('{"success":false,"error":"input_unavailable"}').busy);
        check("boolean id rejected", !FcmXscalInput.begin('{"success":true,"sessionId":true}').success);
        check("string id rejected", !FcmXscalInput.begin('{"success":true,"sessionId":"1"}').success);
        check("invalid id rejected", !FcmXscalInput.begin('{"success":true,"sessionId":0}').success);
        check("active", FcmXscalInput.poll('{"success":true,"sessionId":1,"revision":4,"text":"hello","state":"active"}', 1, 500).success);
        check("submitted", FcmXscalInput.poll('{"success":true,"sessionId":1,"revision":5,"text":"hello","state":"submitted"}', 1, 500).state == "submitted");
        check("cancelled", FcmXscalInput.poll('{"success":true,"sessionId":1,"revision":5,"text":"","state":"cancelled"}', 1, 500).state == "cancelled");
        check("stale id", !FcmXscalInput.poll('{"success":true,"sessionId":2,"revision":1,"text":"x","state":"active"}', 1, 500).success);
        check("unknown state", !FcmXscalInput.poll('{"success":true,"sessionId":1,"revision":1,"text":"x","state":"done"}', 1, 500).success);
        check("bound", !FcmXscalInput.poll('{"success":true,"sessionId":1,"revision":1,"text":"long","state":"active"}', 1, 3).success);
        check("512 limit", FcmXscalInput.poll(haxe.Json.stringify({success:true,sessionId:1,revision:1,text:StringTools.rpad("", "x", 512),state:"active"}),1,512).success);
        check("513 rejected", !FcmXscalInput.poll(haxe.Json.stringify({success:true,sessionId:1,revision:1,text:StringTools.rpad("", "x", 513),state:"active"}),1,512).success);
        check("closed session confirmed", FcmXscalInput.confirmsReleased('{"success":false,"error":"invalid_session"}'));
        check("active session is not released", !FcmXscalInput.confirmsReleased('{"success":true,"sessionId":1,"revision":4,"text":"","state":"submitted"}'));
        check("other failures cannot confirm release", !FcmXscalInput.confirmsReleased('{"success":false,"error":"input_unavailable"}'));
        check("malformed result cannot confirm release", !FcmXscalInput.confirmsReleased('true'));
        #if js
        var astral = "😀";
        var utf16 = new StringBuf();
        for (_ in 0...256) utf16.add(astral);
        check("512 UTF-16 units accepted", FcmXscalInput.poll(haxe.Json.stringify({success:true,sessionId:1,revision:1,text:utf16.toString(),state:"active"}),1,512).success);
        utf16.add(astral);
        check("514 UTF-16 units rejected", !FcmXscalInput.poll(haxe.Json.stringify({success:true,sessionId:1,revision:1,text:utf16.toString(),state:"active"}),1,512).success);
        #end
        #if js
        trace("FCM xScal session-input decoder tests passed");
        #else
        Sys.println("FCM xScal session-input decoder tests passed");
        #end
    }
}
