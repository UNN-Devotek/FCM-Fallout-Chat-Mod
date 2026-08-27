/**
 * Executable tests for the pure character-identity policy.
 * Run: haxe test-identity.hxml
 */
class TestFcmIdentity {
    static var failures:Int = 0;

    static function check(name:String, condition:Bool):Void {
        if (condition) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function eqs(name:String, got:String, want:String):Void {
        check(name + " (got=" + got + " want=" + want + ")", got == want);
    }

    static function main():Void {
        // Character-only precedence: the local PlayerListData entry wins over CharacterInfoData.
        eqs("local character has priority",
            FcmIdentity.selectCharacterName("  LocalVaultDweller  ", "CharacterInfo"),
            "LocalVaultDweller");
        eqs("CharacterInfoData fallback",
            FcmIdentity.selectCharacterName("", "  CharacterInfo  "),
            "CharacterInfo");
        eqs("placeholder local falls back to character",
            FcmIdentity.selectCharacterName("Wanderer", "CharacterInfo"),
            "CharacterInfo");

        // No character source means no handshake identity; an account-only value is not an input.
        eqs("no character source stays unresolved",
            FcmIdentity.selectCharacterName("", ""), "");
        check("empty is not usable", !FcmIdentity.isUsableCharacterName(""));
        check("placeholder is not usable", !FcmIdentity.isUsableCharacterName("Wanderer"));
        check("null is not usable", !FcmIdentity.isUsableCharacterName(null));
        check("character name is usable", FcmIdentity.isUsableCharacterName("VaultDweller"));

        // Normalization matches the widget's UI-name policy.
        eqs("normalizes surrounding whitespace",
            FcmIdentity.normalizeCharacterName("  Vault Dweller  "), "Vault Dweller");
        var longName:String = "12345678901234567890123456789012345678901234567890123456789012345";
        eqs("truncates at the widget limit",
            FcmIdentity.normalizeCharacterName(longName), longName.substr(0, FcmIdentity.MAX_NAME_LENGTH));

        if (failures > 0) { Sys.println(failures + " FAILURE(S)"); Sys.exit(1); }
        Sys.println("ALL PASS");
    }
}
