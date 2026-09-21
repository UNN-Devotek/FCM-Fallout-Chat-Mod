class TestFcmZfeInput {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    static function main():Void {
        var begin = FcmZfeInput.begin('{"success":true,"session":42,"rawSuppression":true,"releaseBarrier":true}');
        check("accepts fully owned begin", begin.success && begin.session == 42
            && begin.rawSuppression && begin.releaseBarrier);
        for (raw in ["not json", '{"success":false}', '{"success":true,"session":null}'])
            check("rejects malformed begin", !FcmZfeInput.begin(raw).success);
        var poll = FcmZfeInput.poll('{"success":true,"session":42,"active":true,"revision":5,'
            + '"text":"bloodied fixer","submitted":true,"cancelled":false,"releaseReady":false}');
        check("decodes live terminal snapshot", poll.success && poll.active && poll.revision == 5
            && poll.text == "bloodied fixer" && poll.submitted && !poll.releaseReady);
        var released = FcmZfeInput.poll('{"success":true,"session":42,"active":true,"revision":5,'
            + '"text":"bloodied fixer","submitted":true,"cancelled":false,"releaseReady":true}');
        check("decodes release barrier", released.releaseReady);
        check("begin payload is scoped", FcmZfeInput.beginPayload("FCMChatWidget", "", 512)
            == '{"initial":"","maxBytes":512,"vendor":"FCMChatWidget"}'
            || FcmZfeInput.beginPayload("FCMChatWidget", "", 512)
            == '{"vendor":"FCMChatWidget","initial":"","maxBytes":512}');
        check("session payload retains opaque token", FcmZfeInput.sessionPayload(42).indexOf("42") >= 0);
        Sys.println("FCM ZFE owner-scoped input tests passed");
    }
}
