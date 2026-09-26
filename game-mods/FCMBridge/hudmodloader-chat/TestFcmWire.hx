/** Unit tests for the Flash-free native wire helpers. Run: haxe test-wire.hxml */
class TestFcmWire {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function main():Void {
        check("queue diagnostic keeps only numeric allowlisted metadata",
            FcmWire.queueLossSummary('{"kind":"events.dropped","id":129,"count":1,"cursor":128,"body":"PRIVATE","token":"SECRET","userId":42}')
                == "id=129 cursor=128 count=1");
        check("queue diagnostic never coerces private strings or malformed numbers",
            FcmWire.queueLossSummary('{"id":"PRIVATE","count":true,"dropped":-1,"nextCursor":1.5,"capacity":2147483648}') == "none");
        check("queue diagnostic accepts zero and nested count metadata",
            FcmWire.queueLossSummary('{"dropped":0,"data":{"count":3,"oldestId":17,"token":"SECRET"}}')
                == "dropped=0 data.count=3 data.oldestId=17");
        check("malformed queue metadata is not exposed", FcmWire.queueLossSummary("PRIVATE invalid") == "unparsed");
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
        check("contiguous retention marker does not report an unread gap",
            !FcmWire.droppedMarkerHasUnreadGap('{"kind":"events.dropped","id":130,"dropped":1}', 129));
        check("stale retention marker does not report an unread gap",
            !FcmWire.droppedMarkerHasUnreadGap('{"kind":"events.dropped","id":129,"dropped":8}', 129));
        check("forward marker gap requires recovery",
            FcmWire.droppedMarkerHasUnreadGap('{"kind":"events.dropped","id":133,"dropped":3}', 129));
        check("unidentified dropped marker fails closed into recovery",
            FcmWire.droppedMarkerHasUnreadGap('{"kind":"events.dropped","dropped":3}', 129));
        check("compact quoted events", FcmWire.findEventsArrayStart('{"events":[{"id":1}]}') == 10);
        check("pretty quoted events", FcmWire.findEventsArrayStart('{\n  "events" : [\n  ]\n}') == 15);
        check("native unquoted events", FcmWire.findEventsArrayStart('{events: [ ]}') == 9);
        check("embedded body word ignored", FcmWire.findEventsArrayStart('{"body":"events: [x]"}') == -1);
        check("missing events rejected", FcmWire.findEventsArrayStart('{"success":true}') == -1);
        check("ZFE queued send exposes request id",
            FcmWire.queuedRequestId('{"success":true,"status":"queued","requestId":42}') == 42);
        check("exact in-game one-digit ZFE queue receipt exposes request id",
            FcmWire.queuedRequestId('{"success":true,"status":"queued","requestId":1}') == 1);
        check("whitespace ZFE queue receipt exposes request id",
            FcmWire.queuedRequestId(' \n { "success" : true, "status" : "queued", "requestId" : 7 } \t') == 7);
        check("synchronous success is not a queued send",
            FcmWire.queuedRequestId('{"success":true,"messageId":"m-1"}') == 0);
        check("failed queue response is not accepted",
            FcmWire.queuedRequestId('{"success":false,"status":"queued","requestId":42}') == 0);
        check("string request id is rejected",
            FcmWire.queuedRequestId('{"success":true,"status":"queued","requestId":"42"}') == 0);
        check("fractional request id is rejected",
            FcmWire.queuedRequestId('{"success":true,"status":"queued","requestId":1.5}') == 0);
        check("nested queue receipt cannot impersonate outer result",
            FcmWire.queuedRequestId('{"result":{"success":true,"status":"queued","requestId":42}}') == 0);
        check("ZFE async accepted completion classified",
            FcmWire.asyncSendCompletion('{"kind":"chat.send.accepted","requestId":42}') == 1);
        check("ZFE async failed completion classified",
            FcmWire.asyncSendCompletion('{"kind":"chat.send.failed","requestId":42,"error":{"code":"permission_denied"}}') == -1);
        check("ordinary chat is not an async completion",
            FcmWire.asyncSendCompletion('{"kind":"chat.message","id":42}') == 0);
        check("ZFE async completion request id extracted",
            FcmWire.asyncRequestId('{"kind":"chat.send.failed","requestId":42}') == 42);
        check("ZFE accepted command feedback carrier extracted",
            FcmWire.asyncResultTargetUserId('{"kind":"chat.send.accepted","requestId":42,"result":{"success":true,"targetUserId":"FCMHUD/1;g=Giveaway%20started"}}')
                == "FCMHUD/1;g=Giveaway%20started");
        check("failed command cannot impersonate accepted feedback",
            FcmWire.asyncResultTargetUserId('{"kind":"chat.send.failed","requestId":42,"result":{"success":true,"targetUserId":"FCMHUD/1;g=wrong"}}') == "");
        check("nested ZFE failure code extracted",
            FcmWire.asyncErrorCode('{"kind":"chat.send.failed","requestId":42,"error":{"code":"permission_denied"}}') == "permission_denied");
        check("non-object async envelope is rejected",
            FcmWire.asyncSendCompletion('[{"kind":"chat.send.accepted","requestId":42}]') == 0);
        if (failures > 0) Sys.exit(1);
    }
}
