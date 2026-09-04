/**
 * Pure policy for interpreting the provider auth response.
 *
 * ZFE's legacy contract treated any non-authenticated response as a dead
 * session. xScal's connect/auth lifecycle is asynchronous, so connecting and
 * pending are expected intermediate states and must not tear down the active
 * native transport. Only explicit terminal xScal states request a reconnect.
 */
class FcmAuthFlow {
    public static inline var ZFE:String = "zfe";
    public static inline var XSCAL:String = "xscal";

    public static inline var AUTHENTICATED:String = "authenticated";
    public static inline var PENDING:String = "pending";
    public static inline var LIMITED:String = "limited";
    public static inline var RECONNECT:String = "reconnect";

    /** Return one of authenticated, pending, limited, or reconnect. */
    public static function classify(provider:String, state:String, status:String, code:String = ""):String {
        var s:String = normalize(state);
        var st:String = normalize(status);
        var c:String = normalize(code);
        if (s == AUTHENTICATED || st == AUTHENTICATED) return AUTHENTICATED;

        if (provider == XSCAL) {
            if (isPending(s) || isPending(st)) return PENDING;
            if (isTerminal(s) || isTerminal(st) || isTerminal(c)) return RECONNECT;
            // unauthenticated/unknown is a usable transport with a limited
            // auth gate, not proof that xScal's transport must be restarted.
            return LIMITED;
        }

        // Preserve the ZFE contract until a provider explicitly documents an
        // asynchronous auth state of its own.
        return RECONNECT;
    }

    /** xScal can report this while its asynchronous subscriber is settling. */
    public static function isPendingTransportResponse(raw:String):Bool {
        if (raw == null) return false;
        var compact:String = raw.split(" ").join("")
            .split("\t").join("")
            .split("\r").join("")
            .split("\n").join("");
        return compact.indexOf("not_connected") >= 0
            || compact.indexOf("not_started") >= 0
            || compact.indexOf("auth.connecting") >= 0
            || compact.indexOf('"status":"connecting"') >= 0;
    }

    static function normalize(value:String):String {
        return value == null ? "" : StringTools.trim(value).toLowerCase();
    }

    static function isPending(value:String):Bool {
        return value == "connecting"
            || value == "pending"
            || value == "starting"
            || value == "authenticating"
            || value == "auth.connecting";
    }

    static function isTerminal(value:String):Bool {
        return value == "rejected"
            || value == "disconnected"
            || value == "error"
            || value == "failed"
            || value == "stopped"
            || value == "auth.rejected"
            || value == "auth.disconnected"
            || value == "auth_token_invalid"
            || value == "auth_token_revoked"
            || value == "user_banned";
    }
}
