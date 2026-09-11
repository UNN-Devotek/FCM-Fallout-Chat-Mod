/** Count suspicious rows without exporting identifiers, names, or message content.
 * Maps live only for this snapshot and are bounded by the widget's record cap.
 */
class FcmDiagnostics {
    public static function rows(records:Array<{messageId:String, senderUserId:String,
            channel:String, body:String, pending:Bool}>):String {
        var ids:Map<String, Bool> = new Map();
        var content:Map<String, Bool> = new Map();
        var repeatedIds = 0;
        var repeatedContent = 0;
        var pending = 0;
        for (rec in records) {
            if (rec.pending) pending++;
            if (rec.messageId != null && rec.messageId.length > 0) {
                if (ids.exists(rec.messageId)) repeatedIds++;
                ids.set(rec.messageId, true);
            }
            // Length prefixes prevent ambiguous concatenations; never log the key.
            var key = part(rec.channel) + part(rec.senderUserId) + part(rec.body);
            if (content.exists(key)) repeatedContent++;
            content.set(key, true);
        }
        return "repeatedIds=" + repeatedIds + " repeatedContent=" + repeatedContent
            + " pendingRows=" + pending;
    }

    static function part(value:String):String {
        return value == null ? "-1:" : value.length + ":" + value;
    }
}
