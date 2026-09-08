class TestFcmJson {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        var auth = FcmJson.parse('{"success":true,"state":"authenticated","permissions":{"canRetryHudSend":true}}');
        check(auth.success && auth.permissions.canRetryHudSend, "nested auth");
        var poll = FcmJson.parse('{"success":true,"events":[{"body":"escaped \\\"name\\\" \\u263a","id":42}]}');
        check(poll.events[0].id == 42, "event array");
        check(FcmJson.parse('{"n":-12.5e2}').n == -1250, "number grammar");
        check(FcmJson.parse('{"text":"\\n\\r\\t\\b\\f\\/\\\\\\\""}').text.length == 8, "escapes");
        check(FcmJson.parse('{"a":null,"b":false}').b == false, "null and false members");
        for (raw in ['{', '{"a":}', '{"a":1,}', '[1,]', '{"a":"\\q"}', '{"a":"\\u00zz"}', '{"a":01}', '{"a":1.}', '{"a":1e}', '{"a":true}garbage', '{"a":"line\nbreak"}']) {
            check(FcmJson.parse(raw) == null, "reject malformed " + raw);
        }
        var deep = "0"; for (_ in 0...40) deep = "[" + deep + "]";
        check(FcmJson.parse(deep) == null, "bounded nesting");
        check(FcmReconnect.validPoll('{"success":true,"events":[]}'), "quiet poll");
        trace("FcmJson tests passed");
    }
}
