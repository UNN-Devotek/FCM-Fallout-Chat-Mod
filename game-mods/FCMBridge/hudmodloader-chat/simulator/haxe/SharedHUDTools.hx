import flash.Lib;
import flash.events.KeyboardEvent;
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.text.TextFormat;
import MockXscal.SimLog;

class SharedHUDTools {
    static var active:SharedHUDTools;
    public static var oskX:Float = -1;
    public static var oskY:Float = -1;
    public static var controllerMode:Bool = false;
    public var isActive:Bool = false;
    var submit:Dynamic;
    var menuSelect:Dynamic;
    var menuPrepare:Dynamic;
    var menuItems:Array<{id:String, label:String, enabled:Bool, isMenu:Bool}> = [];
    var editor:TextField;
    var controllerField:TextField;
    var x:Float = 0;
    var y:Float = 0;
    var width:Float = 380;
    var height:Float = 28;
    var size:Int = 14;
    var color:Int = 0xF5CB5B;

    public function new(_:String, __:String) { active = this; }
    public function Register(_:Dynamic):Bool return true;
    public function RegisterMenu(prepare:Dynamic, select:Dynamic):Bool { menuPrepare = prepare; menuSelect = select; return true; }
    public static function inspectMenu(parent:String = ""):Array<{id:String, label:String, enabled:Bool, isMenu:Bool}> {
        if (active == null || active.menuPrepare == null) return [];
        active.menuItems = [];
        active.menuPrepare(parent);
        return active.menuItems.copy();
    }
    public static function selectMenu(item:String):Void {
        if (active != null && active.menuSelect != null) active.menuSelect(item);
    }
    public function FormatMenu(_:Dynamic, __:Dynamic, ___:Dynamic):Void {}
    public function AddMenuItem(id:Dynamic, label:Dynamic, enabled:Dynamic = true, isMenu:Dynamic = false, __:Dynamic = 250):Void {
        menuItems.push({id:Std.string(id), label:Std.string(label), enabled:enabled == true, isMenu:isMenu == true});
    }
    public function ShowMenu():Void { isActive = true; }
    public function CloseMenu():Void { isActive = false; }
    public function FormatOnScreenKeyboard(px:Float, py:Float):Void {
        oskX = px;
        oskY = py;
    }
    public function FormatTextEdit(px:Float, py:Float, w:Float, h:Float, _:String, fontSize:Int,
            textColor:String, __:String, ___:Float):Void {
        x = px; y = py; width = w; height = h; size = fontSize;
        color = Std.parseInt("0x" + textColor);
    }
    public function TextEdit(callback:Dynamic, initial:String):Bool {
        EndTextEdit();
        submit = callback;
        editor = new TextField();
        editor.type = TextFieldType.INPUT;
        editor.x = x; editor.y = y; editor.width = width; editor.height = height;
        editor.defaultTextFormat = new TextFormat("_sans", size, color);
        editor.text = initial == null ? "" : initial;
        editor.border = true; editor.borderColor = color; editor.background = true; editor.backgroundColor = 0x080705;
        editor.addEventListener(KeyboardEvent.KEY_DOWN, onKeyDown);
        Lib.current.addChild(editor);
        if (controllerMode) {
            controllerField = new TextField();
            controllerField.type = TextFieldType.INPUT;
            controllerField.y = -32;
            controllerField.width = 0;
            Lib.current.addChild(controllerField);
            Lib.current.stage.focus = controllerField;
        } else Lib.current.stage.focus = editor;
        isActive = true;
        SimLog.emit("HUDTOOLS editor opened");
        return true;
    }
    function onKeyDown(event:KeyboardEvent):Void {
        if (event.keyCode == 13) submitAndClose(editor.text);
        else if (event.keyCode == 27) submitAndClose(null);
    }
    function submitAndClose(value:Dynamic):Void {
        var callback = submit;
        submit = null;
        removeEditor();
        if (callback != null) callback(value);
    }
    public function EndTextEdit():Void { submit = null; removeEditor(); }
    function removeEditor():Void {
        if (controllerField != null) {
            if (controllerField.parent != null) controllerField.parent.removeChild(controllerField);
            controllerField = null;
        }
        if (editor != null) {
            editor.removeEventListener(KeyboardEvent.KEY_DOWN, onKeyDown);
            if (editor.parent != null) editor.parent.removeChild(editor);
            editor = null;
        }
        isActive = false;
    }
    public function Shutdown():Void { EndTextEdit(); if (active == this) active = null; }
    public static function submitActive(text:String):Bool {
        if (active == null || !active.isActive) return false;
        active.submitAndClose(text);
        return true;
    }
    public static function hasActiveEditor():Bool return active != null && active.isActive;
    public static function physicalKeyboardFocused():Bool return active != null && active.editor != null
        && Lib.current.stage.focus == active.editor;
    public static function restoreControllerFocus():Void {
        if (active != null && active.controllerField != null)
            Lib.current.stage.focus = active.controllerField;
    }
}
