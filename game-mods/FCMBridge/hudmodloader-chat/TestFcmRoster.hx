class TestFcmRoster {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    public static function main():Void {
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
        check("union is bounded", roster.fresh(131, 100).length == 16);
        check("provider cannot mutate retained snapshot", roster.fresh(131, 100).indexOf("MUTATED") < 0);
        trace("FcmRoster tests passed");
    }
}
