#!/usr/bin/env python3
"""Regression tests for target-specific HUD widget packaging."""

from __future__ import annotations

import importlib.util
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

    for target, expected in package.TARGETS.items():
        chat, widget = package.stamp_configs(target, source_chat, source_widget)
        assert [line for line in chat.splitlines() if line.startswith("linkUrl=")] == [
            f"linkUrl={expected['link_url']}"
        ]
        assert [line for line in widget.splitlines() if line.startswith("Endpoint=")] == [
            f"Endpoint={expected['endpoint']}"
        ]

    with tempfile.TemporaryDirectory() as temp_dir:
        output = Path(temp_dir) / "widget.zip"
        package.build_package("dev", output)
        with ZipFile(output) as archive:
            names = set(archive.namelist())
            assert "Data/FCMChatWidget.ba2" in names
            assert "Data/FCMChat.ini" in names
            assert "Data/ZFE/TextChat/fragments/FCMChatWidget.ini" in names
            assert "INSTALL.txt" in names
            assert b"dev.falloutchatmod.com/link" in archive.read("Data/FCMChat.ini")
            assert b"wss://dev.falloutchatmod.com/relay" in archive.read(
                "Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
            )
            assert b"dev.falloutchatmod.com/link" in archive.read("INSTALL.txt")

    print("package target tests passed")


if __name__ == "__main__":
    main()
