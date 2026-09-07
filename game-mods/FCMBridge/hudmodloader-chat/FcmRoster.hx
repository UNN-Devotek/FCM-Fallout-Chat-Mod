/** Bounded provider snapshots using GFx-native arrays, with no Map key iterator classes. */
class FcmRoster {
    /** Shape-only UI interoperability; no game IDs or non-player map markers are sent. */
    public static function field(value:Dynamic, key:String):Dynamic {
        if (value == null) return null;
        try { var result = Reflect.field(value, key); if (result != null) return result; } catch (e:Dynamic) {}
        try { return untyped value[key]; } catch (e:Dynamic) { return null; }
    }

    /** Read only the menu names already exposed to the HUD. */
    public static function hasPipboy(data:Dynamic):Bool {
        var menus:Dynamic = field(data, "menuStackA");
        var length:Dynamic = field(menus, "length");
        if (length == null) return false;
        for (i in 0...Std.int(Math.min(128, Std.int(length)))) {
            var name = field(menus[i], "menuName");
            if (name != null && Std.string(name).toLowerCase().indexOf("pipboy") >= 0) return true;
        }
        return false;
    }

    public static function isMainMenu(data:Dynamic):Bool {
        var menus:Dynamic = field(data, "menuStackA");
        var length:Dynamic = field(menus, "length");
        if (length == null) return false;
        for (i in 0...Std.int(length)) {
            try { if (field(menus[i], "menuName") == "MainMenu") return true; } catch (e:Dynamic) {}
        }
        return false;
    }

    public static function readNames(key:String, data:Dynamic, localName:String):Array<String> {
        var result:Array<String> = [];
        var add = function(value:Dynamic):Void {
            if (value == null) return;
            var name = Std.string(value);
            var title = name.indexOf("<");
            if (title >= 0) name = name.substr(0, title);
            name = StringTools.trim(StringTools.replace(name, "|", ""));
            if (name.length > 0 && name.toLowerCase() != localName.toLowerCase()
                    && result.indexOf(name) < 0 && result.length < 24) result.push(name);
        };
        var rows:Dynamic = key == "MapMenuData" ? field(data, "MarkerData") : field(data, "publicTeams");
        var length:Dynamic = field(rows, "length");
        if (length == null) return result;
        // Bound native collection reads even if a provider supplies a malformed length.
        var n:Int = Std.int(Math.min(2048, Std.int(length)));
        for (i in 0...n) try {
            var row:Dynamic = rows[i];
            if (key == "MapMenuData") {
                if (field(row, "markerType") == "PlayerRemote") add(field(row, "text"));
            } else {
                var members:Dynamic = field(row, "members");
                var count:Dynamic = field(members, "length");
                if (count != null) for (j in 0...Std.int(Math.min(24, Std.int(count))))
                    add(field(members[j], "playerName"));
            }
        } catch (e:Dynamic) {}
        result.sort(function(a,b) return a < b ? -1 : a > b ? 1 : 0);
        return result;
    }

    var entries:Array<{key:String, names:Array<String>, at:Float}> = [];
    public function new() {}

    public function replace(key:String, names:Array<String>, now:Float):Array<String> {
        for (entry in entries) if (entry.key == key) {
            var previous = entry.names;
            entry.names = names.copy();
            entry.at = now;
            return previous;
        }
        entries.push({key:key, names:names.copy(), at:now});
        return null;
    }

    public function fresh(now:Float, ttl:Float):Array<String> {
        var kept:Array<{key:String, names:Array<String>, at:Float}> = [];
        var names:Array<String> = [];
        for (entry in entries) if (now - entry.at <= ttl) {
            kept.push(entry);
            for (name in entry.names) if (names.indexOf(name) < 0) names.push(name);
        }
        entries = kept;
        names.sort(function(a, b) return a < b ? -1 : (a > b ? 1 : 0));
        return names.slice(0, 24);
    }
}
