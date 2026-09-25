#!/usr/bin/env python3
"""Regression tests for target-specific HUD widget packaging."""

from __future__ import annotations

import configparser
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
    "activateLinkKey": "F8",
    "hideKey": "DELETE",
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
    hidden_modes = active_ini_value(source_chat, "hideInHUDModes").split(",")
    assert "ExamineConfirmMode" in hidden_modes, (
        "FCMChat.ini must hide the HUD examine/scrap confirmation mode"
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
    assert "_pendingFeedContentLayer" in source_hx and "commitFeedSnapshot" in source_hx \
        and "mayCommit(renderToken, _renderPending)" in source_hx, (
        "delayed feed rebuilds must commit one complete generation atomically"
    )
    assert "startSharedInputDiagnostics" in source_hx and '"inputdiag"' in source_hx \
        and "tf.length" in source_hx and "tf.selectionBeginIndex" in source_hx, (
        "shared editor diagnostics must capture metadata without the draft text"
    )
    assert "FcmInputRoute.preferred(provider" in source_hx \
        and "text editor unavailable; no ControlMap lock, input refused" in source_hx \
        and "tf.selectable = true" in source_hx, (
        "the shared widget must route provider input without an unlocked fallback"
    )
    assert '"input.v1.begin"' in source_hx and '"input.v1.poll"' in source_hx \
        and '"input.v1.end"' in source_hx and "OWNED_RELEASE_STABLE_POLLS" in source_hx, (
        "retained ZFE diagnostic input must keep its release barrier"
    )
    assert "FcmSharedInputRecovery.decide" in source_hx \
        and "onSharedInputKeyDown" in source_hx \
        and "recovered missing SharedHUDTools submit callback" in source_hx, (
        "lost SharedHUDTools callbacks must submit an Enter draft or release stale input ownership"
    )
    assert "RENDER_SLICE_ROWS:Int = 6" in source_hx \
        and "start + _renderSliceSize" in source_hx, (
        "feed rebuild slices must stay within the measured Windows Scaleform frame budget"
    )
    assert "FcmCommand.configuredHideAction(action, _cfg.hideKey, _inputOpen)" in source_hx \
        and '"hide ignored while editor owns input"' in source_hx \
        and "_cfg.scrollBottomKey" in source_hx \
        and "_cfg.activateLinkKey" in source_hx \
        and "_cfg.hideKey" in source_hx, (
        "configured hide keys must remain text-edit keys while either provider owns input"
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
    assert "flash.Lib.getURL" not in source_hx and "OPEN_URL_PREFIX" not in source_hx
    assert "new FcmBrowser" in source_hx and "stopBrowser();" in source_hx
    browser_config = configparser.ConfigParser(interpolation=None, delimiters=("=",))
    browser_config.read_string(source_widget)
    assert dict(browser_config["BrowserLinks.Sites"]) == {
        origin: "allow" for origin in (
            "https://discord.com", "https://discord.gg", "https://www.falloutbuilds.com",
            "https://falloutbuilds.com", "https://fallout.wiki", "https://nukacrypt.com",
            "https://steamcommunity.com", "https://store.steampowered.com",
        )
    }
    assert len(source_widget.encode("utf-8")) <= 16 * 1024
    assert "BrowserLinks" not in browser_config  # mode is player-owned
    for target in ("dev", "prod"):
        _, stamped = package.stamp_configs(target, source_chat, source_widget)
        assert stamped.split("[BrowserLinks.Sites]", 1)[1] == source_widget.split("[BrowserLinks.Sites]", 1)[1]
    assert "_history.authenticationChanged()" in source_hx, (
        "A completed account link must re-arm history recovery after a pre-auth permission denial"
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
    assert b"VisibilityScenario" not in swf_artifact and b"VISIBILITY PASS" not in swf_artifact, (
        "Ruffle-only visibility driver must never ship in the production widget"
    )
    assert b"RosterScenario" not in swf_artifact and b"ROSTER-SCENARIO" not in swf_artifact, (
        "Ruffle-only roster drivers and state probes must never ship in the production widget"
    )
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
    upstream_loader_defaults = (ROOT / "HUDMODLOADER-UPSTREAM-DEFAULTS.txt").read_text(encoding="utf-8").splitlines()
    assert len(upstream_loader_defaults) == 22
    expected_loader = ("\n".join(upstream_loader_defaults + ["FCMChatWidget"]) + "\n").encode()
    assert b"FCMServerBridge" not in expected_loader
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
                names = set(archive.namelist())
                readme = archive.read("README.txt")
                assert readme.startswith(f"Fallout Chat Mod HUD {package.widget_version()}".encode())
                assert b"Package provider: unified" in readme
                assert f"{package.ZFE_FOLDER}/ and {package.XSCAL_FOLDER}/".encode() in readme
                assert b"Choose only" in readme[:400]
                assert b"RELEASE NOTES" in readme
                assert b"HUDMODLOADER MENU" in readme
                assert b"PROVIDER KEYBIND CONTRACT" in readme
                assert b"CUSTOMIZATION" in readme
                assert b"Reset all settings" in readme
                assert b"inputBgColor=#080705" in readme
                assert b"Twemoji v17.0.3" in archive.read("licenses/emoji/NOTICE.txt")
                assert not {
                    "INSTALL.txt", "FCMChatWidget.provider.txt", "FCMChatWidget.version.txt",
                    "HUD-RELEASE-NOTES.txt", "HUDMODLOADER-MENU.txt",
                    "KEYBINDS.txt", "CUSTOMIZATION.txt",
                }.intersection(names)
                assert not any(name.endswith(".example") for name in names)
                assert not any(Path(name).suffix.lower() in package.NEXUS_BLOCKED_SUFFIXES for name in names)
                assert sorted(name for name in names if name.endswith(".ba2")) == [
                    f"{package.ZFE_FOLDER}/{package.DATA_FOLDER_LABEL}/FCMChatWidget.ba2",
                    f"{package.XSCAL_FOLDER}/{package.DATA_FOLDER_LABEL}/FCMChatWidget.ba2",
                ]
                assert "Data/FCMChatWidget.ba2" not in names
                assert "Data/configuration/zfe.ini" not in names
                for folder, provider in ((package.ZFE_FOLDER, "zfe"), (package.XSCAL_FOLDER, "xscal")):
                    prefix = folder + "/"
                    data_prefix = prefix + package.DATA_FOLDER_LABEL + "/"
                    assert archive.read(data_prefix + "FCMChatWidget.ba2") == widget_artifact
                    assert archive.read(data_prefix + "hudmodloader.ini") == expected_loader
                    assert prefix + "Fallout76Custom.ini" in names
                    assert not any(name.startswith(prefix + "Documents/") for name in names)
                    assert archive.read(prefix + "Fallout76Custom.ini") == (
                        b"[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n"
                    )
                    chat = archive.read(data_prefix + "FCMChat.ini").decode()
                    assert active_ini_value(chat, "linkUrl") == expected["link_url"]
                    for key, value in HUD_KEY_DEFAULTS.items():
                        assert active_ini_value(chat, key) == value
                    guide = archive.read(prefix + "INSTALL.txt")
                    assert b"HUDModLoader defaults plus FCMChatWidget" in guide
                    assert b"preserve all other lines" in guide
                    assert f"import only {package.DATA_FOLDER_LABEL}/FCMChatWidget.ba2".encode() in guide
                    assert f"Open {package.DATA_FOLDER_LABEL}/ and drag its contents".encode() in guide
                    assert b"On updates replace only the BA2; keep edited INIs" in guide
                    assert expected["endpoint"].encode() in (archive.read(data_prefix + "ZFE/TextChat/fragments/FCMChatWidget.ini") if provider == "zfe" else archive.read(prefix + "xscal.ini"))
                    assert (prefix + "xscal.ini" in names) == (provider == "xscal")
                    assert (data_prefix + "ZFE/TextChat/fragments/FCMChatWidget.ini" in names) == (provider == "zfe")
                    assert data_prefix + "configuration/zfe.ini" not in names
                other = package.TARGETS["prod" if target == "dev" else "dev"]
                assert other["endpoint"].encode() not in readme
                assert f"Endpoint={other['endpoint']}".encode() not in archive.read(
                    package.ZFE_FOLDER + "/" + package.DATA_FOLDER_LABEL + "/ZFE/TextChat/fragments/FCMChatWidget.ini"
                )

            nexus = Path(temp_dir) / f"widget-{target}-nexus.zip"
            package.build_package(target, nexus, distribution="nexus")
            with ZipFile(nexus) as archive:
                assert not any(Path(name).suffix.lower() in package.NEXUS_BLOCKED_SUFFIXES for name in archive.namelist())
                assert "README.txt" in archive.namelist()

            unsafe = Path(temp_dir) / f"widget-{target}-unsafe.zip"
            package.build_package(target, unsafe)
            with ZipFile(unsafe, "a") as archive:
                archive.writestr("unexpected.exe", b"MZ")
            try:
                package.assert_nexus_archive_safe(unsafe)
                raise AssertionError("Nexus validation must reject executable entries")
            except ValueError:
                assert not unsafe.exists()

            disguised = Path(temp_dir) / f"widget-{target}-disguised.zip"
            package.build_package(target, disguised)
            with ZipFile(disguised, "a") as archive:
                archive.writestr("extensionless-runner", b"\x7fELF")
            try:
                package.assert_nexus_archive_safe(disguised)
                raise AssertionError("Nexus validation must reject executable magic bytes")
            except ValueError:
                assert not disguised.exists()

            for provider in ("zfe", "xscal"):
                output = Path(temp_dir) / f"widget-{target}-{provider}.zip"
                package.build_package(target, output, provider)
                with ZipFile(output) as archive:
                    names = set(archive.namelist())
                    assert "README.txt" in names
                    assert "Data/FCMChatWidget.ba2" in names
                    assert "Data/FCMChat.ini" in names
                    assert archive.read("Data/hudmodloader.ini") == expected_loader
                    assert "Fallout76Custom.ini" in names
                    assert not any(name.startswith("Documents/") for name in names)
                    assert archive.read("Fallout76Custom.ini") == (
                        b"[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n"
                    )
                    assert ("xscal.ini" in names) == (provider == "xscal")
                    assert ("Data/ZFE/TextChat/fragments/FCMChatWidget.ini" in names) == (provider == "zfe")
                    assert "INSTALL.txt" not in names
                    assert b"Package provider: " + provider.encode() in archive.read("README.txt")
                    assert ("Enable-xScal-Chat.ps1" in names) == (provider == "xscal")
                    assert ("Enable-xScal-Chat.cmd" in names) == (provider == "xscal")
                    assert not any(name.endswith(".example") for name in names)

    print("package target tests passed")


if __name__ == "__main__":
    main()
