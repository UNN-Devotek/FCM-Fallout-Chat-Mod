/**
 * Adapter for HUDModLoader's native HUDModUserEvent.
 *
 * HUDModUserEvent exposes EventName and IsKeyDown as AS3 getter properties.
 * On the Flash target Reflect.field() only reads own fields and skips those
 * accessors, so native dynamic property access must be attempted first.
 */
class FcmUserEvent {
    public static function action(event:Dynamic):String {
        var value:Dynamic = read(event, "actionName");
        if (value != null && Std.string(value).length > 0) return Std.string(value);

        value = read(event, "EventName");
        return value == null ? "" : Std.string(value);
    }

    public static function isDown(event:Dynamic):Bool {
        var value:Dynamic = read(event, "isDown");
        if (value == null) value = read(event, "IsKeyDown");
        if (value == null) value = read(event, "isPressed");
        if (value == null) value = read(event, "pressed");
        if (value == null) value = read(event, "down");
        return FcmCommand.eventIsDown(value);
    }

    static function read(event:Dynamic, field:String):Dynamic {
        if (event == null) return null;

        // Native AS3 getters are invoked by bracket access. Keep Reflect.field
        // as a fallback for loader variants that expose ordinary dynamic fields.
        try {
            var value:Dynamic = untyped event[field];
            if (value != null) return value;
        } catch (_:Dynamic) {}
        try {
            var value:Dynamic = Reflect.getProperty(event, field);
            if (value != null) return value;
        } catch (_:Dynamic) {}
        try { return Reflect.field(event, field); } catch (_:Dynamic) {}
        return null;
    }
}
