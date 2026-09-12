/** Pure, bounded UI observation and room-confirmation policy for the background mod. */
class FcmBridgeState {
    public var session(default, null):FcmServerSession = new FcmServerSession();
    public var inWorld(default, null):Bool = false;
    public var observedAt(default, null):Float = -60000;
    var roster:FcmRoster = new FcmRoster();
    var snapshots:Array<{key:String, data:Dynamic, names:Array<String>, blocked:Bool}> = [];
    var makeId:Void->String;
    public function new(makeId:Void->String) { this.makeId = makeId; reset(); }
    public function reset():Void {
        session.begin(makeId());
        observedAt = -60000;
        roster = new FcmRoster();
        for (entry in snapshots) entry.blocked = true;
    }
    /** A transport reconnect within the same observed world need not wait for a
     * roster mutation. World/menu boundaries still block cached providers. */
    public function reconnect():Void { session.begin(makeId()); }
    public static function field(value:Dynamic, key:String):Dynamic { return FcmRoster.field(value, key); }
    public static function ready(provider:Dynamic):Bool {
        return provider != null && field(provider, "isTest") != true && field(provider, "dataReady") == true;
    }
    /** A placeholder provider or an absent menu list is never world evidence. */
    public function menu(provider:Dynamic):Void {
        if (!ready(provider)) { if (inWorld) reset(); inWorld = false; return; }
        var menus = field(field(provider, "data"), "menuStackA");
        var count = field(menus, "length");
        var active = count != null && count >= 0 && count <= 128;
        if (active) for (i in 0...Std.int(count)) {
            var name = field(menus[i], "menuName");
            if (name == "MainMenu" || name == "LoadingMenu") active = false;
        }
        if (!active && inWorld) reset();
        inWorld = active;
    }
    public function observe(key:String, provider:Dynamic, localName:String, now:Float, pushed:Bool = false):Void {
        if (!inWorld || !ready(provider)) return;
        var data = field(provider, "data");
        var rows:Dynamic = switch key {
            case "MapMenuData": field(data, "MarkerData");
            case "PublicTeamsData": field(data, "publicTeams");
            case "TeamMarkers": field(data, "Markers");
            case "VoiceChatAreaData": field(data, "participants");
            default: data;
        };
        var length = field(rows, "length");
        if (length == null || length < 0 || length > 2048) return;
        var previous = null;
        for (entry in snapshots) if (entry.key == key) previous = entry;
        if (previous != null && previous.blocked && previous.data == data && !pushed) return;
        var names:Array<String> = [];
        if (key == "MapMenuData" || key == "PublicTeamsData") names = FcmRoster.readNames(key, data, localName);
        else for (i in 0...Std.int(length)) {
            var row = rows[i];
            if (field(row, "isLocal") == true || field(row, "isLocalPlayer") == true || field(row, "isSelf") == true) continue;
            for (nameKey in ["displayName", "playerName", "name", "characterName"]) {
                var value = field(row, nameKey);
                if (value == null) continue;
                var name = cleanName(Std.string(value));
                if (name.length == 0) continue;
                if (name.toLowerCase() != localName.toLowerCase() && names.indexOf(name) < 0 && names.length < 24) names.push(name);
                break;
            }
        }
        names = [for (name in names) if (cleanName(name).length > 0) cleanName(name)];
        names.sort(function(a,b) return a < b ? -1 : a > b ? 1 : 0);
        if (previous != null && !previous.blocked && previous.names.length > 0 && names.length > 0) {
            var overlap = false;
            for (name in names) if (previous.names.indexOf(name) >= 0) overlap = true;
            if (!overlap) reset(); // do not union old-provider names into a new candidate world
        }
        if (previous == null) { previous = {key:key, data:data, names:names, blocked:false}; snapshots.push(previous); }
        else { previous.data = data; previous.names = names; previous.blocked = false; }
        roster.replace(key, names, now);
        observedAt = now;
    }
    public static function cleanName(name:String):String {
        var title = name.indexOf("<");
        if (title >= 0) name = name.substr(0, title);
        name = StringTools.trim(StringTools.replace(StringTools.replace(name, "|", ""), "\x00", ""));
        return name.length > 64 ? name.substr(0, 64) : name;
    }
    public function fresh(now:Float):Bool { return inWorld && now - observedAt < 30000; }
    public function names(now:Float):Array<String> { return roster.fresh(now, 30000); }
    public function target():String { return "FCMBRIDGE/1;" + session.requestId; }
    public static function linkCode(body:String):String {
        if (body == null || !StringTools.startsWith(body, "LINK REQUIRED - ")) return "";
        var re = ~/code: ([A-Z0-9]{4}-[A-Z0-9]{4}) \(expires 10m\)/;
        return re.match(body) ? re.matched(1) : "";
    }
    public static function terminal(state:String, code:String):Bool {
        state = StringTools.trim(state).toLowerCase();
        code = StringTools.trim(code).toLowerCase();
        return ["banned", "denied", "revoked"].indexOf(state) >= 0
            || ["auth_token_invalid", "auth_token_revoked", "user_banned", "user_kicked"].indexOf(code) >= 0;
    }
    public static function authenticated(auth:Dynamic):Bool {
        if (auth == null || field(auth, "success") == false) return false;
        for (key in ["state", "status"]) {
            var value = field(auth, key);
            if (value != null && StringTools.trim(Std.string(value)).toLowerCase() == "authenticated") return true;
        }
        return false;
    }
}
