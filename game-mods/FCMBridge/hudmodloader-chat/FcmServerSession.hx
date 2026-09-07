/** Correlate streamed relay membership with this HUD world's current request. */
class FcmServerSession {
    public static inline var REQUEST_PREFIX = "FCMSESSION/1;";
    public static inline var READY_PREFIX = "FCMCTL/1/SERVER-READY:";
    public var requestId(default, null):String = "";
    public var room(default, null):String = "";
    public var confirmedAt(default, null):Float = -60000;
    var pending:Array<String> = [];
    public function new() {}
    public function begin(id:String):Void { requestId = id; room = ""; confirmedAt = -60000; pending = []; }
    public function defer(raw:String):Void {
        if (pending.length >= 64) pending.splice(0, 1);
        pending.push(raw);
    }
    public function takePending():Array<String> { var result = pending; pending = []; return result; }
    public function target():String { return REQUEST_PREFIX + requestId; }
    public function accept(body:String, now:Float = 0):Bool {
        if (requestId.length == 0 || body == null) return false;
        var prefix = READY_PREFIX + requestId + "|";
        if (!StringTools.startsWith(body, prefix)) return false;
        var next = body.substr(prefix.length);
        if (next.length == 0 || next.length > 128) return false;
        room = next;
        confirmedAt = now;
        return true;
    }
    public function fresh(now:Float):Bool { return room.length > 0 && now - confirmedAt < 60000; }
    public function acceptsMessage(messageId:String):Bool {
        return room.length > 0 && messageId != null && StringTools.startsWith(messageId, "server:" + room + ":");
    }
}
