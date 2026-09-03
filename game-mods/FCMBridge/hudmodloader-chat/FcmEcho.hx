/** Pure matching rules for reconciling an optimistic chat row with its relay echo. */
class FcmEcho {
    /** Match channel/body first, then use the strongest available local identity. */
    public static function matches(messageId:String, senderUserId:String, channel:String, body:String,
            pendingMessageId:String, pendingSenderUserId:String, pendingChannel:String,
            pendingBody:String, relayUserId:String, localUserId:String):Bool {
        if (channel != pendingChannel || body != pendingBody) return false;

        if (messageId != null && messageId.length > 0
                && pendingMessageId != null && pendingMessageId.length > 0) {
            return messageId == pendingMessageId;
        }
        if (senderUserId != null && senderUserId.length > 0
                && pendingSenderUserId != null && pendingSenderUserId.length > 0
                && senderUserId == pendingSenderUserId) return true;

        var incomingIsLocal:Bool = isKnownLocal(senderUserId, relayUserId, localUserId);
        if (incomingIsLocal) {
            return isKnownLocal(pendingSenderUserId, relayUserId, localUserId)
                || pendingSenderUserId == null || pendingSenderUserId.length == 0;
        }

        // Some extender builds omit senderUserId from the event. This is safe
        // because the widget selects only one pending candidate.
        return senderUserId == null || senderUserId.length == 0
            ? isKnownLocal(pendingSenderUserId, relayUserId, localUserId)
            : false;
    }

    static function isKnownLocal(value:String, relayUserId:String, localUserId:String):Bool {
        if (value == null || value.length == 0) return false;
        return (relayUserId != null && relayUserId.length > 0 && value == relayUserId)
            || (localUserId != null && localUserId.length > 0 && value == localUserId);
    }
}
