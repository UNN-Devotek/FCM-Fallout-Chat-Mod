/** Harness-only class definition for the host movie's real ApplicationDomain.
 * No Bethesda class implementation is copied or included in the production SWF. */
@:native("Shared.AS3.Data.BSUIDataManager")
@:keep class HarnessBSUIDataManager {
    static var active:Dynamic = null;
    public static function use(manager:Dynamic):Void { active = manager; }
    @:getter(GetDataFromClient) public static function readGet():Dynamic return active == null ? null : active.GetDataFromClient;
    @:getter(Subscribe) public static function readSubscribe():Dynamic return active == null ? null : active.Subscribe;
    @:getter(Unsubscribe) public static function readUnsubscribe():Dynamic return active == null ? null : active.Unsubscribe;
}
