class TestFcmDiagnostics {
    static function row(id:String, sender:String, body:String, pending:Bool = false) {
        return {messageId: id, senderUserId: sender, channel: "global", body: body, pending: pending};
    }
    static function main():Void {
        var summary = FcmDiagnostics.rows([
            row("secret-id", "secret-user", "private text"),
            row("secret-id", "secret-user", "private text"),
            row("other-id", "secret-user", "private text"),
            row("", "other-user", "private text", true),
            row("", "other-user", "different text", true)
        ]);
        if (summary != "repeatedIds=1 repeatedContent=2 pendingRows=2") throw summary;
        if (FcmDiagnostics.rows([]) != "repeatedIds=0 repeatedContent=0 pendingRows=0") throw "empty";
        if (FcmDiagnostics.rows([row(null, null, null), row("", "", "")])
                != "repeatedIds=0 repeatedContent=0 pendingRows=0") throw "null/empty collision";
        Sys.println("HUD duplicate diagnostics tests passed");
    }
}
