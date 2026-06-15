import flash.display.MovieClip;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.HTTPStatusEvent;
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.net.URLRequestMethod;
import flash.net.SharedObject;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;

// Loose-file override for DiagnosticProbe.swf
// Runs ALL tests automatically on addedToStage - no hotkey needed.
// Results written to SharedObject fcm_probe AND displayed on screen.
class DiagAutoRun extends MovieClip {

    var _tf: TextField;
    var _lines: Array<String> = [];
    var _so: Dynamic;
    var _results: Dynamic = {};

    static function main() {
        flash.Lib.current.addChild(new DiagAutoRun());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    function onStage(e:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onStage);
        buildOverlay();
        log("DiagAutoRun started");

        // Test 1: can we instantiate URLLoader?
        try {
            var ul = new URLLoader();
            log("URLLoader: instantiated OK");
            untyped _results.urlLoaderNew = "OK";
            // Test 2: try an actual HTTP request
            testHttp(ul);
        } catch(e:Dynamic) {
            log("URLLoader: new() FAILED: " + Std.string(e));
            untyped _results.urlLoaderNew = "FAIL:" + Std.string(e);
        }

        // Test 3: SharedObject
        testSharedObject();

        // Auto-flush to SO after 5s to capture async results
        var t = new Timer(5000, 1);
        t.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            flushSO();
            log("--- flush done ---");
        });
        t.start();
    }

    function testHttp(ul:URLLoader):Void {
        try {
            ul.addEventListener(Event.COMPLETE, function(_) {
                log("URLLoader.load: COMPLETE (HTTP worked!)");
                untyped _results.urlLoaderLoad = "COMPLETE";
                flushSO();
            });
            ul.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent) {
                log("URLLoader.load: IO_ERROR: " + e.text);
                untyped _results.urlLoaderLoad = "IO_ERROR:" + e.text;
                flushSO();
            });
            ul.addEventListener(HTTPStatusEvent.HTTP_STATUS, function(e:HTTPStatusEvent) {
                log("URLLoader.load: HTTP_STATUS=" + e.status);
                untyped _results.urlLoaderHttp = e.status;
            });
            var req = new URLRequest("http://127.0.0.1:7177/api/game/player-bridge");
            req.method = URLRequestMethod.POST;
            req.contentType = "application/json";
            req.data = '{"worldId":"diag","worldType":"test","src":"lc","players":[]}';
            ul.load(req);
            log("URLLoader.load: called (waiting for event)");
            untyped _results.urlLoaderLoad = "PENDING";
        } catch(e:Dynamic) {
            log("URLLoader.load: THREW: " + Std.string(e));
            untyped _results.urlLoaderLoad = "THROW:" + Std.string(e);
        }
    }

    function testSharedObject():Void {
        try {
            _so = SharedObject.getLocal("fcm_diag_auto");
            untyped _so.data.version = "DiagAutoRun_v1";
            untyped _so.data.ts = Date.now().getTime();
            var r = _so.flush();
            log("SharedObject: flush=" + r);
            untyped _results.so = "OK:" + r;
        } catch(e:Dynamic) {
            log("SharedObject: FAILED: " + Std.string(e));
            untyped _results.so = "FAIL:" + Std.string(e);
        }
    }

    function flushSO():Void {
        try {
            if (_so == null) _so = SharedObject.getLocal("fcm_diag_auto");
            untyped _so.data.results = _results;
            untyped _so.data.log = _lines.join("\n");
            _so.flush();
        } catch(e:Dynamic) {}
    }

    function log(msg:String):Void {
        _lines.push(msg);
        if (_tf != null) {
            _tf.text = _lines.slice(-20).join("\n");
        }
    }

    function buildOverlay():Void {
        _tf = new TextField();
        var fmt = new TextFormat();
        fmt.font = "_sans";
        fmt.size = 11;
        fmt.color = 0xFFFF00;
        _tf.defaultTextFormat = fmt;
        _tf.multiline = true;
        _tf.wordWrap = false;
        _tf.background = true;
        _tf.backgroundColor = 0x000000;
        _tf.width = 500;
        _tf.height = 300;
        _tf.x = 10;
        _tf.y = 10;
        _tf.selectable = false;
        _tf.mouseEnabled = false;
        addChild(_tf);
        // Hide after 15s
        var t = new Timer(15000, 1);
        t.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { _tf.visible = false; });
        t.start();
    }
}
