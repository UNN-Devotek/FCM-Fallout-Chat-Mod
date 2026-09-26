class TestFcmInputRoute {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        check("ZFE uses host editor even when input.v1 is advertised",
            FcmInputRoute.preferred(FcmNativeApi.ZFE, true) == FcmInputRoute.SHARED);
        check("ZFE keeps the host editor when input.v1 is unavailable",
            FcmInputRoute.preferred(FcmNativeApi.ZFE, false) == FcmInputRoute.SHARED);
        check("xScal uses SharedHUDTools",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, true) == FcmInputRoute.SHARED);
        check("xScal session route is explicit",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, false, true) == FcmInputRoute.XSCAL_SESSION);
        check("xScal configured shared editor bypasses its native session",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, false, true, "shared") == FcmInputRoute.SHARED);
        check("xScal native remains the default",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, false, true, "native") == FcmInputRoute.XSCAL_SESSION);
        check("ZFE ignores the xScal editor setting",
            FcmInputRoute.preferred(FcmNativeApi.ZFE, true, true, "shared") == FcmInputRoute.SHARED);
        check("unknown providers fail closed to the shared host editor",
            FcmInputRoute.preferred("unknown", true) == FcmInputRoute.SHARED);
        check("ZFE does not fall back to no-lock native input",
            !FcmInputRoute.mayUseNativeFallback(FcmNativeApi.ZFE, true));
        check("xScal cannot use ZFE native fallback",
            !FcmInputRoute.mayUseNativeFallback(FcmNativeApi.XSCAL, true));
        Sys.println("FCM provider input-route tests passed");
    }
}
