/** Unit tests for the Flash-free native wire helpers. Run: haxe test-wire.hxml */
class TestFcmWire {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        check("compact control accepted", FcmWire.controlAccepted('{"success":true}'));
        check("pretty control accepted", FcmWire.controlAccepted('{\n "success" : true, "messageId":"ack"}'));
        check("legacy control accepted", FcmWire.controlAccepted('{success: true}'));
        check("rejected control stays rejected", !FcmWire.controlAccepted('{"success":false}'));
        check("nested success cannot acknowledge membership", !FcmWire.controlAccepted('{"error":{"success":true}}'));
        check("body success cannot acknowledge membership", !FcmWire.controlAccepted('{"message":"success:true"}'));
        check("string true is not a control acknowledgement", !FcmWire.controlAccepted('{"success":"true"}'));
        check("missing control is rejected", !FcmWire.controlAccepted(null));
        check("xScal dropped marker detected", FcmWire.isDroppedEvent('{"kind":"events.dropped","id":9}'));
        check("ordinary event is not a dropped marker", !FcmWire.isDroppedEvent('{"kind":"chat.message","id":9}'));
        check("dropped marker text in a chat body is not a dropped event",
            !FcmWire.isDroppedEvent('{"kind":"chat.message","body":"events.dropped"}'));
        check("compact quoted events", FcmWire.findEventsArrayStart('{"events":[{"id":1}]}') == 10);
        check("pretty quoted events", FcmWire.findEventsArrayStart('{\n  "events" : [\n  ]\n}') == 15);
        check("native unquoted events", FcmWire.findEventsArrayStart('{events: [ ]}') == 9);
        check("embedded body word ignored", FcmWire.findEventsArrayStart('{"body":"events: [x]"}') == -1);
        check("missing events rejected", FcmWire.findEventsArrayStart('{"success":true}') == -1);
        if (failures > 0) Sys.exit(1);
    }
}
