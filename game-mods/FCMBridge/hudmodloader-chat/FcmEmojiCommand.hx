/** Resolves locally, then uses the ordinary authenticated channel-send path. */
class FcmEmojiCommand {
    static var unicode:Map<String,String> = null;
    static var discord:Map<String,String> = null;
    static function key(value:String):String {
        value = StringTools.trim(value).toLowerCase();
        if (value.length > 1 && value.charAt(0) == ":" && StringTools.endsWith(value, ":"))
            value = value.substring(1, value.length - 1);
        return StringTools.replace(value, " ", "_");
    }
    static function init():Void {
        if (unicode != null) return;
        unicode = new Map(); discord = new Map();
        for (line in FcmEmojiCatalog.commands().split("\n")) {
            var parts = line.split("\t");
            if (parts.length != 2) continue;
            var custom = StringTools.startsWith(parts[0], "discord:");
            var name = key(custom ? parts[0].substr(8) : parts[0]);
            var target = custom ? discord : unicode;
            // Never silently select a different emoji when normalized names collide.
            if (target.exists(name) && target.get(name) != parts[1]) target.set(name, "");
            else target.set(name, parts[1]);
        }
        unicode.set("smile", "😄"); unicode.set("grin", "😀");
        unicode.set("heart", "❤️"); unicode.set("thumbsup", "👍");
        unicode.set("thumbsdown", "👎"); unicode.set("laughing", "😆");
        unicode.set("joy", "😂"); unicode.set("wave", "👋");
    }
    public static function resolve(raw:String):{handled:Bool, body:String, error:String} {
        var text = StringTools.trim(raw == null ? "" : raw);
        var i = 0;
        while (i < text.length && text.charAt(i) != " " && text.charAt(i) != "\t") i++;
        var command = text.substr(0, i).toLowerCase();
        // Fallout's native editor may consume the leading slash.
        if (command != "/emoji" && command != "emoji") return {handled:false,body:raw,error:""};
        var name = key(text.substr(i));
        if (name.length == 0) return {handled:true,body:"",error:"Use /emoji <name>, e.g. /emoji smile, /emoji heart, /emoji thumbs_up, or a Discord emoji name."};
        init();
        var value:String = null;
        if (StringTools.startsWith(name, "unicode:")) value = unicode.get(name.substr(8));
        else if (StringTools.startsWith(name, "discord:")) value = discord.get(name.substr(8));
        else value = discord.exists(name) ? discord.get(name) : unicode.get(name);
        if (value == null || value.length == 0)
            return {handled:true,body:"",error:"Emoji name not found or ambiguous. Use its exact name; Unicode names may use spaces or underscores."};
        return {handled:true,body:value,error:""};
    }
}
