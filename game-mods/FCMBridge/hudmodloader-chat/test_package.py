#!/usr/bin/env python3
"""Regression tests for target-specific HUD widget packaging."""

from __future__ import annotations

import importlib.util
import re
import tempfile
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fcm_package", ROOT / "package.py")
assert spec and spec.loader
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


HUD_KEY_DEFAULTS = {
    "openKey": "INSERT",
    "channelNextKey": "NextPage",
    "channelPrevKey": "PrevPage",
    "scrollUpKey": "Up",
    "scrollDownKey": "Down",
    "scrollBottomKey": "",
    "hideKey": "",
}


def active_ini_value(text: str, key: str) -> str:
    """Return one active key assignment and reject missing/duplicate shipped defaults."""
    lines = [line for line in text.splitlines() if line.startswith(f"{key}=")]
    assert len(lines) == 1, f"expected one active {key}= line, found {len(lines)}"
    return lines[0].split("=", 1)[1]


def main() -> None:
    source_chat = (ROOT / "FCMChat.ini").read_text(encoding="utf-8")
    source_widget = (ROOT / "FCMChatWidget.ini").read_text(encoding="utf-8")
    source_hx = (ROOT / "FCMChatWidget.hx").read_text(encoding="utf-8")
    for key, expected in HUD_KEY_DEFAULTS.items():
        assert active_ini_value(source_chat, key) == expected, (
            f"FCMChat.ini shipped default {key} must be {expected!r}"
        )
    assert active_ini_value(source_widget, "OpenChatKey") == "INSERT"
    assert '2) Sign in with Steam or Discord<br/>' in source_hx
    version_match = re.search(
        r'static inline var VERSION:String\s*=\s*"([^"]+)"', source_hx
    )
    assert version_match, "FCMChatWidget.hx must define VERSION"
    assert "created canonical local row; transport deferred" in source_hx, (
        "send path must create one canonical row before transport"
    )
    assert "ownCosmeticsForSend()" in source_hx and "var ackCosmeticsKnown:Bool" in source_hx, (
        "send path must paint known own cosmetics immediately and recognize legacy ACKs"
    )
    assert "FcmEcho.choose" in source_hx and "_userId, _linkedUserId, true" in source_hx, (
        "event path must handle a stable live event that arrives before its ACK"
    )
    assert "externalInputClosePath" in source_hx, (
        "input handoff must classify named external modal actions before normal navigation"
    )
    assert "PlatformChangeEvent" not in source_hx and "forceKeyboardPlatform" not in source_hx, (
        "widget must not construct the target-variant platform event"
    )
    assert "runEventPollSafely" in source_hx and "runWorldPollSafely" in source_hx, (
        "five-second poll callbacks must be isolated at their timer boundaries"
    )
    assert "public function shutdown()" in source_hx and "onRemovedFromStage" in source_hx and "cleanup isolated" in source_hx, (
        "reloadable widgets must expose an idempotent, guarded removal teardown"
    )
    assert "startServerHistoryDrain" in source_hx and "SERVER_HISTORY_DRAIN_MAX" in source_hx, (
        "server-room backfill must be drained promptly after a fresh bind"
    )
    assert "mergeNativeInputTextWithMode" in source_hx and "detectNativeInputMode" in source_hx, (
        "native input must distinguish cumulative and delta provider buffers"
    )
    assert "startXscalWarmup" in source_hx and "becameAuthenticated" in source_hx and "startZfeInitialHistoryDrain" in source_hx and '_history.needsRecovery(_authState == "authenticated", flash.Lib.getTimer())' in source_hx, (
        "both providers' initial subscriber history must be drained promptly without a duplicate RESYNC"
    )
    assert "SERVER_HISTORY_DRAIN_IDLE_MAX" in source_hx and "server backfill drain complete" in source_hx, (
        "server-room history must drain through an idle window, not stop after its first row"
    )
    assert "unsubscribeRoster();" in source_hx and "_rosterManager = null;" in source_hx, (
        "widget teardown must release BSUI roster callbacks on reload"
    )
    assert "scheduleHistoryResyncFallback" in source_hx and "HISTORY_RESYNC_FALLBACK_MS" in source_hx, (
        "Shared RESYNC must be delayed until an empty or dropped initial poll"
    )
    legacy_bridge = (ROOT.parent / "FCMBridge.hx").read_text(encoding="utf-8")
    assert "startInitialHistoryDrain" in legacy_bridge and "MAX_MSGS:Int     = 125" in legacy_bridge, (
        "legacy initial subscriber history must be drained promptly"
    )
    assert "navigationAction" in source_hx and "feedNavigationEnabled" in source_hx, (
        "navigation must be classified as stateless commands with Insert-gated feed access"
    )
    assert "FcmUserEvent.action(e)" in source_hx and "FcmUserEvent.isDown(e)" in source_hx, (
        "HUDModUserEvent accessors must be read through the native-property adapter"
    )
    assert "function closeInputSharedHudTools" in source_hx and "EndTextEdit" in source_hx, (
        "external modal actions must cancel the SharedHUDTools editor"
    )
    assert "_inputOpen && _nativeInput && isExternalInputAction(action)" not in source_hx, (
        "external modal actions must also close the primary SharedHUDTools editor"
    )
    assert "new Timer(1, 1)" in source_hx, (
        "send path must defer the synchronous native RPC by one timer tick"
    )
    assert source_hx.index("created canonical local row; transport deferred") < source_hx.index(
        'var rs:String = Std.string(_api.call("chat.v1.sendMessage", payload));'
    ), "optimistic row must be queued before the native send call"
    swf_artifact = (ROOT / "FCMChatWidget.swf").read_bytes()
    assert swf_artifact[:3] == b"FWS" and swf_artifact[3] == 32, (
        "FCMChatWidget.swf must be an uncompressed Flash v32 artifact"
    )
    assert b"supporterstarbitmap" not in swf_artifact.lower(), (
        "FCMChatWidget.swf must not embed a bitmap supporter-star renderer"
    )
    assert b"FcmEmojiRenderer" in swf_artifact and b"setImageSubstitutions" not in swf_artifact and b"BitmapData" not in swf_artifact, (
        "Emoji images must use the guarded shared renderer; supporter stars remain vectors"
    )
    assert b"alignMarker" in swf_artifact and "contentTf.y + authorBounds.y" in source_hx, (
        "star alignment must translate the per-row author bounds, not global feed indices"
    )
    widget_artifact = (ROOT / "FCMChatWidget.ba2").read_bytes()
    widget_version = version_match.group(1).encode("ascii")
    assert widget_version in widget_artifact, "FCMChatWidget.ba2 embeds the current VERSION"
    assert b"awaiting authoritative live echo" in widget_artifact, (
        "FCMChatWidget.ba2 must wait for an authoritative self-echo"
    )
    assert b"sendAccepted" in widget_artifact, (
        "FCMChatWidget.ba2 must retain an ACK-accepted send transaction"
    )
    assert b"reconcileDisplayName" not in widget_artifact, (
        "FCMChatWidget.ba2 must not contain the unsafe late-identity reconnect symbol"
    )

    for target, expected in package.TARGETS.items():
        chat, widget = package.stamp_configs(target, source_chat, source_widget)
        assert [line for line in chat.splitlines() if line.startswith("linkUrl=")] == [
            f"linkUrl={expected['link_url']}"
        ]
        assert [line for line in widget.splitlines() if line.startswith("Endpoint=")] == [
            f"Endpoint={expected['endpoint']}"
        ]

    with tempfile.TemporaryDirectory() as temp_dir:
        invalid = Path(temp_dir) / "invalid.zip"
        try:
            package.build_package("dev", invalid, "unknown")
            raise AssertionError("unknown providers must be rejected")
        except ValueError:
            assert not invalid.exists()
        assert package.widget_version() == version_match.group(1)
        for target, expected in package.TARGETS.items():
            unified = Path(temp_dir) / f"widget-{target}-unified.zip"
            package.build_package(target, unified)
            with ZipFile(unified) as archive:
                names = archive.namelist()
                assert b"Twemoji v17.0.3" in archive.read("licenses/emoji/NOTICE.txt")
                assert "licenses/emoji/LICENSE-TWEMOJI.txt" in names
                assert "licenses/emoji/LICENSE-UNICODE.txt" in names
                assert [name for name in names if name.endswith(".ba2")] == ["Data/FCMChatWidget.ba2"]
                assert not any(name.startswith("Data/ZFE/") for name in names)
                assert archive.read("Data/FCMChatWidget.ba2") == (ROOT / "FCMChatWidget.ba2").read_bytes()
                zfe_example = archive.read("examples/ZFE/FCMChatWidget.ini.example").decode()
                assert f"Endpoint={expected['endpoint']}" in zfe_example
                assert active_ini_value(zfe_example, "OpenChatKey") == "INSERT"
                chat_config = archive.read("Data/FCMChat.ini").decode()
                for key, value in HUD_KEY_DEFAULTS.items():
                    assert active_ini_value(chat_config, key) == value
                override = archive.read("examples/ZFE/zfe.ini.example")
                assert f"[TextChat]\nEndpoint={expected['endpoint']}\n".encode() in override
                assert b"OpenChatKey=INSERT" in override
                assert b"Keep OpenChatKey identical to Data/FCMChat.ini openKey" in override
                assert b"Do not replace the whole file" in override
                assert b"examples/ZFE/zfe.ini.example" in archive.read("INSTALL.txt")
                assert "CUSTOMIZATION.txt" in names
                assert "KEYBINDS.txt" in names
                keybinds = archive.read("KEYBINDS.txt")
                assert b"openKey=DELETE" in keybinds
                assert b"OpenChatKey=DELETE" in keybinds
                assert b"DELETE is the recommended alternative" in keybinds
                assert b"ArrowUp/ArrowDown (and Cursor/Dpad aliases)" in keybinds
                assert b"scrollUpKey=Console" in keybinds
                assert b"scrollDownKey=F12" in keybinds
                assert b"scrollBottomKey=Home" in keybinds
                assert b"`scrollBottomKey` is deliberately empty" in keybinds
                assert b"XSCAL OPEN-CHAT KEY" in keybinds
                assert b"do not add OpenChatKey to" in keybinds
                assert b"Input.RegisterKey/Input.IsKeyPressed" in keybinds
                assert b"not keyboard suppression" in keybinds
                assert b"https://www.nexusmods.com/fallout76/articles/255" in keybinds
                assert b"https://www.nexusmods.com/fallout76/articles/268" in keybinds
                assert b"enabled=true" in archive.read("xscal.ini.example")
                assert expected["endpoint"].encode() in archive.read("xscal.ini.example")
                assert expected["endpoint"].encode() in archive.read("Enable-xScal-Chat.ps1")
                assert b"@@FCM_RELAY_ENDPOINT@@" not in archive.read("Enable-xScal-Chat.ps1")
                install = archive.read("INSTALL.txt")
                assert b"Choose exactly one script extender" in install
                assert b"Choose one provider" in install
                assert b"Do not install the ZFE fragment" in install
                assert archive.read("FCMChatWidget.provider.txt") == b"unified\n"
                install = install.decode()
                assert f"[Chat]\n  enabled=true\n  relayEndpoint={expected['endpoint']}" in install
                assert "If the section or file is missing, add it once" in install
                assert "Windows: optionally run Enable-xScal-Chat.cmd" in install
                assert "xScal has no OpenChatKey setting" in install
                assert "xScal Input.*" in install
                assert "Copy examples/ZFE/FCMChatWidget.ini.example" in install
                assert "If Data/configuration/zfe.ini contains [TextChat], it overrides" in install
                assert f"Endpoint={expected['endpoint']}" in install
                assert "OpenChatKey=INSERT" in install
                for key, value in HUD_KEY_DEFAULTS.items():
                    assert f"{key}={value}" in install
                assert "hideKey is also blank by default" in install
                assert "Initial history" not in install
                assert "Send an emoji" not in install
                assert "Steam sign-in" not in install
                other = "prod" if target == "dev" else "dev"
                assert package.TARGETS[other]["endpoint"] not in install

            nexus = Path(temp_dir) / f"widget-{target}-nexus.zip"
            package.build_package(target, nexus, distribution="nexus")
            with ZipFile(nexus) as archive:
                names = archive.namelist()
                assert "Enable-xScal-Chat.cmd" not in names
                assert "Enable-xScal-Chat.ps1" not in names
                assert "DOWNLOAD-XSCAL-SETUP-HELPERS.txt" in names
                assert not {
                    Path(name).suffix.lower() for name in names
                }.intersection(package.NEXUS_BLOCKED_SUFFIXES)
                helper = archive.read("DOWNLOAD-XSCAL-SETUP-HELPERS.txt")
                assert b"never bundled in the Nexus HUD archive" in helper
                assert f"FCM%20HUD%20Mod-{package.widget_version()}".encode() in helper
                assert b"DOWNLOAD-XSCAL-SETUP-HELPERS.txt" in archive.read("INSTALL.txt")

            unsafe = Path(temp_dir) / f"widget-{target}-unsafe-nexus.zip"
            package.build_package(target, unsafe)
            with ZipFile(unsafe, "a") as archive:
                archive.writestr("unexpected.exe", b"MZ")
            try:
                package.assert_nexus_archive_safe(unsafe)
                raise AssertionError("Nexus validation must reject executable entries")
            except ValueError:
                assert not unsafe.exists()

            disguised = Path(temp_dir) / f"widget-{target}-disguised-nexus.zip"
            package.build_package(target, disguised)
            with ZipFile(disguised, "a") as archive:
                archive.writestr("extensionless-runner", b"\x7fELF")
            try:
                package.assert_nexus_archive_safe(disguised)
                raise AssertionError("Nexus validation must reject executable magic bytes")
            except ValueError:
                assert not disguised.exists()


        for target, expected in package.TARGETS.items():
            for provider in ("zfe", "xscal"):
                output = Path(temp_dir) / f"widget-{target}-{provider}.zip"
                package.build_package(target, output, provider)
                with ZipFile(output) as archive:
                    names = set(archive.namelist())
                    assert "Data/FCMChatWidget.ba2" in names
                    assert "Data/FCMChat.ini" in names
                    assert ("Data/ZFE/TextChat/fragments/FCMChatWidget.ini" in names) == (provider == "zfe")
                    assert "FCMChatWidget.hudmodloader.ini" in names
                    assert "FCMChatWidget.version.txt" in names
                    assert ("xscal.ini.example" in names) == (provider == "xscal")
                    assert archive.read("FCMChatWidget.provider.txt") == (provider + "\n").encode()
                    assert ("Enable-xScal-Chat.ps1" in names) == (provider == "xscal")
                    assert ("Enable-xScal-Chat.cmd" in names) == (provider == "xscal")
                    if provider == "xscal":
                        assert b"[Chat]\nenabled=true\n" in archive.read("xscal.ini.example")
                        setup = archive.read("Enable-xScal-Chat.ps1")
                        assert b"@@FCM_RELAY_ENDPOINT@@" not in setup
                        assert expected["endpoint"].encode() in setup
                        assert b"Enable-xScal-Chat.cmd" in archive.read("INSTALL.txt")
                        assert b"xScal ships with chat disabled" in archive.read("INSTALL.txt")
                        assert not any(n.lower().startswith("data/zfe/") for n in names)
                    assert "Data/hudmodloader.ini" not in names
                    assert "INSTALL.txt" in names
                    assert "HUDMODLOADER-MENU.txt" in names
                    assert archive.read("Data/FCMChatWidget.ba2") == widget_artifact
                    assert b"chatInterface" in widget_artifact
                    assert b"__SFECodeObj" in widget_artifact
                    assert archive.read("FCMChatWidget.hudmodloader.ini") == b"FCMChatWidget\n"
                    assert archive.read("FCMChatWidget.version.txt") == f"{package.widget_version()}\n".encode()

                    chat_config = archive.read("Data/FCMChat.ini")
                    widget_config = archive.read(
                        "Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
                    ) if provider == "zfe" else b""
                    install = archive.read("INSTALL.txt")
                    menu = archive.read("HUDMODLOADER-MENU.txt")
                    assert b"General combines all six feeds" in menu
                    assert b"Sending from General targets General" in menu
                    customization = archive.read("CUSTOMIZATION.txt")
                    assert b"inputBgColor=#080705" in customization
                    assert b"autoHideEnabled=false" in customization
                    assert b"Input width and alignment always follow" in customization
                    assert b"Badges, channel tags" in customization
                    assert b"CUSTOMIZATION.txt" in menu
                    assert b"Colors..." in menu
                    assert b"showChannelTag=" not in chat_config
                    assert b"colorGeneral=" not in chat_config
                    xscal_config = archive.read("xscal.ini.example") if provider == "xscal" else b""
                    assert f"linkUrl={expected['link_url']}\n".encode() in chat_config
                    chat_config_text = chat_config.decode()
                    for key, value in HUD_KEY_DEFAULTS.items():
                        assert active_ini_value(chat_config_text, key) == value
                    assert provider != "zfe" or f"Endpoint={expected['endpoint']}\n".encode() in widget_config
                    assert provider != "zfe" or active_ini_value(
                        widget_config.decode(), "OpenChatKey"
                    ) == "INSERT"
                    assert expected["web_link_url"].encode() in install
                    assert expected["endpoint"].encode() in install
                    assert provider != "xscal" or f"relayEndpoint={expected['endpoint']}\n".encode() in xscal_config
                    if provider == "zfe":
                        assert b"ZFE setup" in install
                        assert b"Data/configuration/zfe.ini" in install
                        assert b"Do not install xscal.ini" in install
                        assert b"xScal setup" not in install
                    else:
                        assert b"xScal setup" in install
                        assert b"xScal Input.*" in install
                        assert b"Do not install the ZFE fragment" in install
                    assert b"Press F11" in install
                    assert b"Insert opens" in install
                    assert b"Arrow Up / Down" in install
                    assert b"scrollUpKey" in install
                    assert b"scrollDownKey" in install
                    assert b"scrollBottomKey" in install
                    assert b"scrollBottomKey is blank by default" in install
                    assert b"hideKey is also blank by default" in install
                    assert b"Shipped Data/FCMChat.ini key map:" in menu
                    for key, value in HUD_KEY_DEFAULTS.items():
                        assert f"{key}={value}".encode() in install
                        assert f"{key}={value}".encode() in menu
                    assert b"scrollUpKey" in menu
                    assert b"scrollDownKey" in menu
                    assert b"scrollBottomKey is blank by default" in menu
                    assert b"Home, End, or F12" in install
                    assert b"Initial history" not in install
                    assert b"Send an emoji" not in install
                    assert b"Steam sign-in" not in install
                    assert b"F11" in menu
                    assert b"FCM -> Customize..." in menu
                    assert b"Press Insert" in menu
                    assert b"Arrow Up / Down" in menu
                    assert b"15 recent messages" in menu
                    assert b"50 from the current SERVER room" in menu
                    assert b"125 events total" in menu
                    assert b"Home, End, F12" in menu
                    assert b"/g, /t, /e" in menu
                    assert b"/relink" in menu
                    assert b"Auto-hide" in menu
                    assert b"SERVER" in menu
                    assert b"Reset all settings" in menu
                    assert b"showTimestamps" not in chat_config
                    assert b"timestampColor" not in chat_config

                    other = package.TARGETS["prod" if target == "dev" else "dev"]
                    assert f"linkUrl={other['link_url']}\n".encode() not in chat_config
                    assert f"Endpoint={other['endpoint']}\n".encode() not in widget_config
                    assert other["web_link_url"].encode() not in install
                    assert other["endpoint"].encode() not in install

                    if target == "prod":
                        for name in names - {"Data/FCMChatWidget.ba2"}:
                            assert not re.search(rb"\bdev\b", archive.read(name).lower()), (
                                f"production archive mentions DEV in {name}"
                            )

    print("package target tests passed")


if __name__ == "__main__":
    main()
