/**
 * HUD shortcuts for the seeded event announcements. The backend remains the
 * authority for enabled commands, channel restrictions, cooldowns and text.
 */
class FcmEventCommands {
    public static var entries(default, null):Array<String> = [
        "acp|A Colossal Problem", "bob|Beasts of Burden", "ct|Campfire Tales",
        "dc|Dropped Connections", "dg|Distinguished Guests", "dpt|Dangerous Pastimes",
        "en|Eviction Notice", "enc|Encryptid", "fr|Free Range",
        "ftp|Feed the People", "gm|Guided Meditation", "hots|Heart of the Swamp",
        "jb|Jailbreak", "lb|Lode Baring", "lits|Line in the Sand",
        "mj|Moonshine Jamboree", "mw|Most Wanted", "nw|Neurological Warfare",
        "ovn|One Violent Night", "pp|Project Paradise", "pte|The Path to Enlightenment",
        "rr|Radiation Rumble", "rs|Riding Shotgun", "sa|Seismic Activity",
        "sas|Safe and Sound", "sbq|Scorched Earth", "sos|Surface to Air",
        "ss|Sinkhole Solutions", "tol|Tunnel of Love", "tt|Tea Time",
        "tym|Test Your Metal", "uf|Uranium Fever"
    ];

    public static function isHelp(raw:String):Bool {
        if (raw == null) return false;
        var text = StringTools.trim(raw).toLowerCase();
        return text == "/event help" || text == ".event help" || text == "event help";
    }

    public static function help():String {
        var lines = ["EVENT COMMANDS (use in General; posts to Events)", "/event help — show this list"];
        for (entry in entries) {
            var parts = entry.split("|");
            lines.push("/" + parts[0] + " — " + parts[1]);
        }
        return lines.join("\n");
    }

    /** Restore the slash lost by the native editor, including /event <code>. */
    public static function command(raw:String):String {
        if (raw == null) return "";
        var text = StringTools.trim(raw);
        var lower = text.toLowerCase();
        var start = lower.charAt(0) == "/" || lower.charAt(0) == "." ? 1 : 0;
        var token = lower.substr(start).split(" ")[0];
        if (token == "event") {
            var rest = StringTools.trim(text.substr(start + token.length));
            if (rest.length == 0 || rest.toLowerCase() == "help") return "";
            var nested = command(rest);
            return nested;
        }
        for (entry in entries) {
            var code = entry.split("|")[0];
            if (token == code) {
                var rest = text.substr(start + token.length);
                return "/" + code + rest;
            }
        }
        return "";
    }
}
