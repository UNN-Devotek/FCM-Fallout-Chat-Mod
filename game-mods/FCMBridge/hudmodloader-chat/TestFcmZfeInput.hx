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
        check("matches only the retained opaque session", FcmZfeInput.sameSession(42, poll.session)
            && !FcmZfeInput.sameSession(41, poll.session));
        var bounded = FcmZfeInput.poll('{"success":true,"session":"opaque","active":true,"revision":1,"text":"abcdef"}', 4);
        check("bounds untrusted returned text", bounded.text == "abcd");
        check("begin payload is scoped", FcmZfeInput.beginPayload("FCMChatWidget", "", 512).indexOf('"vendor":"FCMChatWidget"') >= 0);
        check("session payload retains opaque token", FcmZfeInput.sessionPayload("opaque").indexOf("opaque") >= 0);
        Sys.println("FCM ZFE owner-scoped input tests passed");
    }
}
