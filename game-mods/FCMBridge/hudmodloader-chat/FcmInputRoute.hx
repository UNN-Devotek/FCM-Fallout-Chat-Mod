/** Provider-aware input routing for the one shared widget build. */
class FcmInputRoute {
    public static inline var NATIVE:String = "native";
    public static inline var OWNED:String = "owned";
    public static inline var XSCAL_SESSION:String = "xscal-session";
    public static inline var SHARED:String = "shared";

    /** ZFE needs the host ControlMap editor; xScal owns its native text session. */
    public static function preferred(provider:String, ownedUsable:Bool, xscalSessionUsable:Bool = false):String {
        if (provider == FcmNativeApi.XSCAL && xscalSessionUsable) return XSCAL_SESSION;
        return SHARED;
    }

    public static function mayUseNativeFallback(provider:String, nativeUsable:Bool):Bool {
        // Neither ZFE input.v1 nor the legacy buffer owns Fallout's ControlMap lock.
        // A failed SharedHUDTools editor must not silently allow gameplay while typing.
        return false;
    }
}
