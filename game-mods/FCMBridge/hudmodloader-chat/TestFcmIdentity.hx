/**
 * Executable tests for the pure Fallout relay-identity policy.
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
        // Fallout 76 exposes the public Bethesda/Fallout handle via AccountInfoData.
        // CharacterInfoData is the local character name and must not replace it.
        eqs("Fallout account handle wins over character name",
            FcmIdentity.selectFalloutDisplayName("  Devotek-  ", "Devotek", "Devotek"),
            "Devotek-");
        eqs("missing Fallout account handle stays unresolved",
            FcmIdentity.selectFalloutDisplayName("", "RosterCharacter", "CharacterInfo"),
            "");

        // Character labels never satisfy the public-name handshake by themselves.
        eqs("placeholder account handle stays unresolved",
            FcmIdentity.selectFalloutDisplayName("Wanderer", "RosterCharacter", "CharacterInfo"),
            "");
        check("empty is not usable", !FcmIdentity.isUsableFalloutDisplayName(""));
        check("placeholder is not usable", !FcmIdentity.isUsableFalloutDisplayName("Wanderer"));
        check("null is not usable", !FcmIdentity.isUsableFalloutDisplayName(null));
        check("Fallout account handle is usable", FcmIdentity.isUsableFalloutDisplayName("VaultDweller-"));

        // Normalization matches the widget's UI-name policy.
        eqs("normalizes surrounding whitespace",
            FcmIdentity.normalizeDisplayName("  Vault Dweller-  "), "Vault Dweller-");
        var longName:String = "12345678901234567890123456789012345678901234567890123456789012345";
        eqs("truncates at the widget limit",
            FcmIdentity.normalizeDisplayName(longName), longName.substr(0, FcmIdentity.MAX_NAME_LENGTH));

        if (failures > 0) { Sys.println(failures + " FAILURE(S)"); Sys.exit(1); }
        Sys.println("ALL PASS");
    }
}
