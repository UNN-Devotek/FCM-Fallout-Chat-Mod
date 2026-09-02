/**
 * Pure Fallout 76 relay-identity policy shared by the HUD widget and tests.
 *
 * AccountInfoData.name is the player's public Bethesda/Fallout handle. The
 * local PlayerListData and CharacterInfoData values are character labels; they
 * are accepted as inputs only so this policy can explicitly refuse to use them
 * when the public account handle is not ready.
 */
class FcmIdentity {
    public static inline var PLACEHOLDER:String = "Wanderer";
    public static inline var MAX_NAME_LENGTH:Int = 64;

    /** Normalize a candidate without allowing the widget placeholder through. */
    public static function normalizeDisplayName(value:String):String {
        if (value == null) return "";
        var name:String = StringTools.trim(value);
        if (name.length == 0 || name == PLACEHOLDER) return "";
        return name.length > MAX_NAME_LENGTH ? name.substr(0, MAX_NAME_LENGTH) : name;
    }

    /**
     * Select the public Fallout identity used by the relay handshake.
     *
     * Do not fall back to either character candidate. A one-shot native relay
     * connection made with a character label would keep the wrong sender name
     * for the session even when AccountInfoData arrives a moment later.
     */
    public static function selectFalloutDisplayName(
        accountName:String,
        _localPlayerName:String,
        _characterInfoName:String
    ):String {
        return normalizeDisplayName(accountName);
    }

    /** True only for a normalized, non-placeholder Fallout account handle. */
    public static function isUsableFalloutDisplayName(value:String):Bool {
        return normalizeDisplayName(value).length > 0;
    }
}
