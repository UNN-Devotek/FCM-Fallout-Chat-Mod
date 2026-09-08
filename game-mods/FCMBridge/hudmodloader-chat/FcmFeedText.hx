/** Plain text offsets shared by native range formatting and the vector marker. */
class FcmFeedText {
    public static inline function compose(channel:String, moderation:String, tag:String, name:String, body:String, spaces:Int, status:String):{text:String,channelEnd:Int,moderationEnd:Int,tagEnd:Int,nameStart:Int,nameEnd:Int,statusStart:Int} {
        var prefix = (channel.length > 0 ? "[" + channel + "] " : "");
        var channelEnd = prefix.length;
        prefix += moderation;
        var moderationEnd = prefix.length;
        prefix += tag.length > 0 ? "[" + tag + "] " : "";
        var tagEnd = prefix.length;
        for (_ in 0...spaces) prefix += String.fromCharCode(160);
        var nameStart = prefix.length;
        prefix += name;
        var nameEnd = prefix.length;
        prefix += ": " + StringTools.replace(StringTools.replace(body, "\r\n", "\n"), "\r", "\n");
        var statusStart = prefix.length;
        return {text:prefix + status, channelEnd:channelEnd, moderationEnd:moderationEnd,
            tagEnd:tagEnd, nameStart:nameStart, nameEnd:nameEnd, statusStart:statusStart};
    }
}
