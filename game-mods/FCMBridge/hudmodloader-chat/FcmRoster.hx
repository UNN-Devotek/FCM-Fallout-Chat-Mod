/** Bounded provider snapshots using GFx-native arrays, with no Map key iterator classes. */
class FcmRoster {
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
        return names.slice(0, 16);
    }
}
