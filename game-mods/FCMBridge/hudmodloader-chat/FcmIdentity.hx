/**
 * Pure character-identity policy shared by the HUD widget and interpreter tests.
 *
 * Only names sourced from character-owned HUD data may enter this policy. The
 * widget supplies the local PlayerListData name first, then CharacterInfoData.
 */
class FcmIdentity {
    public static inline var PLACEHOLDER:String = "Wanderer";
    public static inline var MAX_NAME_LENGTH:Int = 64;

    /** Normalize a candidate without allowing the widget placeholder through. */
    public static function normalizeCharacterName(value:String):String {
        if (value == null) return "";
        var name:String = StringTools.trim(value);
        if (name.length == 0 || name == PLACEHOLDER) return "";
        return name.length > MAX_NAME_LENGTH ? name.substr(0, MAX_NAME_LENGTH) : name;
    }

    /** Prefer the local roster entry, then use CharacterInfoData as compatibility fallback. */
    public static function selectCharacterName(localPlayerName:String, characterInfoName:String):String {
        var local:String = normalizeCharacterName(localPlayerName);
        if (local.length > 0) return local;
        return normalizeCharacterName(characterInfoName);
    }

    /** True only for a normalized, non-placeholder character name. */
    public static function isUsableCharacterName(value:String):Bool {
        return normalizeCharacterName(value).length > 0;
    }
}
