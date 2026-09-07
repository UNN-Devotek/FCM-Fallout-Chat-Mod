class TestFcmRoster {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    public static function main():Void {
        var map:Dynamic = {MarkerData: [
            {markerType:"PlayerLocal", text:"Local", playerLevel:10},
            {markerType:"PlayerRemote", text:"Alice<title>", playerLevel:20},
            {markerType:"Location", text:"Not a player", playerLevel:0},
            {markerType:"PlayerRemote", text:"Bob", playerLevel:30}]};
        check("map roster excludes local and non-player markers",
            FcmRoster.readNames("MapMenuData", map, "Local").join("|") == "Alice|Bob");
        check("public team roster uses nested members",
            FcmRoster.readNames("PublicTeamsData", {publicTeams:[{members:[
                {playerName:"Alice"}, {playerName:"Local"}, {playerName:"Carol"}]}]}, "Local").join("|") == "Alice|Carol");
        check("main menu is an explicit world boundary", FcmRoster.isMainMenu({menuStackA:[{menuName:"MainMenu"}]}));
        check("map menu is not a world boundary", !FcmRoster.isMainMenu({menuStackA:[{menuName:"MapMenu"}]}));
        var roster = new FcmRoster();
        check("new provider has no prior snapshot", roster.replace("players", ["B", "A"], 0) == null);
        roster.replace("team", ["A", "C"], 10);
        check("providers merge without duplicates", roster.fresh(20, 100).join("|") == "A|B|C");
        check("replacement returns provider's own snapshot", roster.replace("players", [], 30).join("|") == "B|A");
        check("empty replacement removes that provider's old names", roster.fresh(40, 100).join("|") == "A|C");
        roster.replace("players", ["D"], 90);
        check("expired auxiliary provider cannot contaminate next world", roster.fresh(120, 100).join("|") == "D");
        check("expired provider is forgotten", roster.replace("team", ["E"], 121) == null);
        var names = [for (i in 0...30) "Player" + i];
        roster.replace("players", names, 130);
        names.push("MUTATED");
        check("union covers a public world and is bounded", roster.fresh(131, 100).length == 24);
        check("provider cannot mutate retained snapshot", roster.fresh(131, 100).indexOf("MUTATED") < 0);
        trace("FcmRoster tests passed");
    }
}
