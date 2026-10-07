import flash.display.DisplayObject;
import flash.display.Stage;
import flash.events.Event;
import flash.text.TextField;

/** Uses only the installed HUD's public TeammateMarkerBase/TeamNameplates/Name_tf surface.
 * No copied Bethesda/Text Chat classes, gameplay mutation, fonts or extra labels. */
class FcmNameplatePainter {
    var owner:DisplayObject;
    var frameStage:Stage = null;
    var presence:FcmNameplates;
    var host:Dynamic = null;
    var manager:Dynamic = null;
    var callback:Dynamic = null;
    var markers:Array<{id:Dynamic, name:String, eligible:Bool}> = [];
    var painted:Array<{field:TextField, plate:Dynamic, name:String, color:Int}> = [];
    var disposed:Bool = false;
    public var enabled:Bool = true;
    public var diagnostic(default, null):String = "waiting";
    public var automaticFrames(default, null):Int = 0;
    public function new(owner:DisplayObject, presence:FcmNameplates) {
        this.owner = owner; this.presence = presence;
        owner.addEventListener(Event.ADDED_TO_STAGE, attached);
        if (owner.stage != null) attached(null);
    }
    public function startFrames():Void { attached(null); }
    function attached(_:Event):Void {
        if (disposed || owner.stage == null || frameStage == owner.stage) return;
        if (frameStage != null) frameStage.removeEventListener(Event.ENTER_FRAME, frame);
        frameStage = owner.stage; frameStage.addEventListener(Event.ENTER_FRAME, frame);
        diagnostic = "frame attached";
    }
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    public function bind(next:Dynamic):Void {
        if (manager == next || disposed) return;
        clear(); detach(); manager = next;
        if (manager == null) return;
        var source = manager;
        callback = function(event:Dynamic):Void {
            if (disposed || manager != source) return;
            var provider = field(event, "fromClient");
            if (provider != null) observe(provider);
        };
        var subscribed = callback;
        try {
            source.Subscribe("TeamMarkers", subscribed);
            if (disposed || manager != source) {
                source.Unsubscribe("TeamMarkers", subscribed); return;
            }
            var data = source.GetDataFromClient("TeamMarkers");
            if (!disposed && manager == source) observe(data);
        }
        catch (_:Dynamic) { markers = []; }
    }
    public function observe(provider:Dynamic):Void {
        if (disposed) return;
        var result:Array<{id:Dynamic, name:String, eligible:Bool}> = [];
        if (field(provider, "dataReady") == true && field(provider, "isTest") == false) {
            var rows = field(field(provider, "data"), "Markers");
            var n:Dynamic = field(rows, "length");
            if ((Std.isOfType(n, Int) || Std.isOfType(n, Float)) && n >= 0 && n <= 128 && n == Math.floor(n)) {
                for (i in 0...Std.int(n)) {
                    var row:Dynamic = field(rows, Std.string(i));
                    var name:Dynamic = field(row, "displayName");
                    var state = field(row, "playerState");
                    var wanted = field(row, "wantedState");
                    var id = field(row, "entityID");
                    if (id == null || !Std.isOfType(name, String)) continue;
                    var eligible = field(row, "isLocalPlayer") == false && field(row, "isHostile") == false
                        && ["teammate", "eventgroupmate", "nonhostile", "friend", "potentialHostile"].indexOf(state) >= 0
                        && wanted == "notWanted";
                    result.push({id:id, name:FcmNameplates.clean(name), eligible:eligible});
                }
            }
        }
        markers = result;
    }
    function findHost():Dynamic {
        var current:Dynamic = owner;
        for (_ in 0...24) {
            if (current == null) break;
            if (field(current, "TeammateMarkerBase") != null) return current;
            current = field(current, "parent");
        }
        return null;
    }
    public function hasSurface():Bool return findHost() != null;
    function frame(_:Event):Void {
        automaticFrames++;
        try { paint(flash.Lib.getTimer()); }
        catch (error:Dynamic) { diagnostic = "frame error " + Std.string(field(error, "errorID")); clear(); }
    }
    public function paint(now:Float):Void {
        if (disposed) return;
        diagnostic = "host";
        var next = findHost();
        if (host != next) { clear(); host = next; }
        diagnostic = "lease";
        var names = enabled ? presence.current(now) : [];
        var active:Array<TextField> = [];
        diagnostic = "plates";
        var plates = field(field(host, "TeammateMarkerBase"), "TeamNameplates");
        diagnostic = "length";
        var n:Dynamic = field(plates, "length");
        diagnostic = "names=" + names.length + " markers=" + markers.length + " plates=" + (n == null ? -1 : Std.int(n));
        if (names.length > 0 && (Std.isOfType(n, Int) || Std.isOfType(n, Float)) && n >= 0 && n <= 128 && n == Math.floor(n)) {
            for (i in 0...Std.int(n)) {
                var plate:Dynamic = field(plates, Std.string(i));
                var label:Dynamic = field(plate, "Name_tf");
                if (!Std.isOfType(label, TextField) || field(plate, "visible") != true) continue;
                var match = null;
                for (marker in markers) if (marker.id == field(plate, "entityID")) { match = marker; break; }
                if (match == null || !match.eligible || names.indexOf(match.name) < 0) continue;
                var text:TextField = cast label;
                if (FcmNameplates.clean(text.text) != match.name) continue; // recycled or not yet redrawn
                var entry = null;
                for (old in painted) if (old.field == text) { entry = old; break; }
                if (entry != null && entry.name != match.name) { restore(entry); painted.remove(entry); entry = null; }
                if (entry == null) { entry = {field:text, plate:plate, name:match.name, color:Std.int(text.textColor)}; painted.push(entry); }
                else if (text.textColor != FcmNameplates.BLUE) entry.color = Std.int(text.textColor);
                text.textColor = FcmNameplates.BLUE;
                active.push(text);
            }
        }
        for (entry in painted.copy()) if (active.indexOf(entry.field) < 0) { restore(entry); painted.remove(entry); }
        diagnostic += " painted=" + painted.length;
    }
    function restore(entry:{field:TextField, plate:Dynamic, name:String, color:Int}):Void {
        try {
            if (entry.field.textColor == FcmNameplates.BLUE) entry.field.textColor = entry.color;
            var dirty = field(entry.plate, "SetIsDirty");
            if (Reflect.isFunction(dirty)) Reflect.callMethod(entry.plate, dirty, []);
        } catch (_:Dynamic) {}
    }
    public function clear():Void { for (entry in painted) restore(entry); painted = []; }
    function detach():Void {
        var source = manager; var subscribed = callback;
        manager = null; callback = null; markers = [];
        if (source != null && subscribed != null) try { source.Unsubscribe("TeamMarkers", subscribed); } catch (_:Dynamic) {}
    }
    public function shutdown():Void {
        if (disposed) return;
        disposed = true; clear(); detach(); owner.removeEventListener(Event.ADDED_TO_STAGE, attached);
        if (frameStage != null) frameStage.removeEventListener(Event.ENTER_FRAME, frame);
        frameStage = null; host = null;
    }
}
