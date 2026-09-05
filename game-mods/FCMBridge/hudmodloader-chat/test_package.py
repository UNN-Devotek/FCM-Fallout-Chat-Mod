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


def main() -> None:
    source_chat = (ROOT / "FCMChat.ini").read_text(encoding="utf-8")
    source_widget = (ROOT / "FCMChatWidget.ini").read_text(encoding="utf-8")
    source_hx = (ROOT / "FCMChatWidget.hx").read_text(encoding="utf-8")
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
    assert "startXscalWarmup" in source_hx and "becameAuthenticated" in source_hx and "startZfeInitialHistoryDrain" in source_hx and "provider=xscal; subscriber owns initial history" in source_hx, (
        "both providers' initial subscriber history must be drained promptly without a duplicate RESYNC"
    )
    assert "SERVER_HISTORY_DRAIN_IDLE_MAX" in source_hx and "server backfill drain complete" in source_hx, (
        "server-room history must drain through an idle window, not stop after its first row"
    )
    assert "unsubscribeRoster();" in source_hx and "_rosterManager = null;" in source_hx, (
        "widget teardown must release BSUI roster callbacks on reload"
    )
    assert "scheduleHistoryResyncFallback" in source_hx and "HISTORY_RESYNC_FALLBACK_MS" in source_hx, (
        "ZFE RESYNC must be delayed until an empty or dropped initial poll"
    )
    legacy_bridge = (ROOT.parent / "FCMBridge.hx").read_text(encoding="utf-8")
    assert "startInitialHistoryDrain" in legacy_bridge and "MAX_MSGS:Int     = 125" in legacy_bridge, (
        "legacy initial subscriber history must be drained promptly"
    )
    assert "navigationAction" in source_hx and "feedNavigationEnabled" in source_hx, (
        "navigation must be classified as stateless commands with Insert-gated feed access"
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
    assert b"setimagesubstitutions" not in swf_artifact.lower(), (
        "FCMChatWidget.swf must not use the HUD supporter-star substitution path"
    )
    assert b"getcharboundaries" not in swf_artifact.lower(), (
        "FCMChatWidget.swf must not use the drifting text-boundary star renderer"
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
        assert package.widget_version() == version_match.group(1)
        for target, expected in package.TARGETS.items():
            output = Path(temp_dir) / f"widget-{target}.zip"
            package.build_package(target, output)
            with ZipFile(output) as archive:
                names = set(archive.namelist())
                assert "Data/FCMChatWidget.ba2" in names
                assert "Data/FCMChat.ini" in names
                assert "Data/ZFE/TextChat/fragments/FCMChatWidget.ini" in names
                assert "FCMChatWidget.hudmodloader.ini" in names
                assert "FCMChatWidget.version.txt" in names
                assert "xscal.ini.example" in names
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
                )
                install = archive.read("INSTALL.txt")
                menu = archive.read("HUDMODLOADER-MENU.txt")
                xscal_config = archive.read("xscal.ini.example")
                assert f"linkUrl={expected['link_url']}\n".encode() in chat_config
                assert f"Endpoint={expected['endpoint']}\n".encode() in widget_config
                assert f"  {expected['web_link_url']}\n".encode() in install
                assert f"  {expected['endpoint']}\n".encode() in install
                assert f"relayEndpoint={expected['endpoint']}\n".encode() in xscal_config
                assert b"Press F11" in install
                assert b"Press Insert" in install
                assert b"Arrow Up / Down" in install
                assert b"15 recent messages" in install
                assert b"50 messages" in install
                assert b"125 events total" in install
                assert b"Home / End" in install
                assert b"/g, /t, /e" in install
                assert b"/relink" in install
                assert b"Reset all settings" in install
                assert b"F11" in menu
                assert b"FCM -> Customize..." in menu
                assert b"Press Insert" in menu
                assert b"Arrow Up / Down" in menu
                assert b"15 recent messages" in menu
                assert b"50 from the current SERVER room" in menu
                assert b"125 events total" in menu
                assert b"Home / End" in menu
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
                assert f"  {other['web_link_url']}\n".encode() not in install
                assert f"  {other['endpoint']}\n".encode() not in install

                if target == "prod":
                    for name in names - {"Data/FCMChatWidget.ba2"}:
                        assert b"dev" not in archive.read(name).lower(), (
                            f"production archive mentions DEV in {name}"
                        )

    print("package target tests passed")


if __name__ == "__main__":
    main()
