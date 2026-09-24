class TestFcmInputRoute {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        check("current ZFE prefers owner-scoped input",
            FcmInputRoute.preferred(FcmNativeApi.ZFE, true) == FcmInputRoute.OWNED);
        check("ZFE keeps the shared editor when native input is unavailable",
            FcmInputRoute.preferred(FcmNativeApi.ZFE, false) == FcmInputRoute.SHARED);
        check("xScal uses SharedHUDTools",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, true) == FcmInputRoute.SHARED);
        check("xScal session route is explicit",
            FcmInputRoute.preferred(FcmNativeApi.XSCAL, false, true) == FcmInputRoute.XSCAL_SESSION);
        check("unknown providers fail closed to the shared host editor",
            FcmInputRoute.preferred("unknown", true) == FcmInputRoute.SHARED);
        check("ZFE may use native fallback",
            FcmInputRoute.mayUseNativeFallback(FcmNativeApi.ZFE, true));
        check("xScal cannot use ZFE native fallback",
            !FcmInputRoute.mayUseNativeFallback(FcmNativeApi.XSCAL, true));
        Sys.println("FCM provider input-route tests passed");
    }
}
