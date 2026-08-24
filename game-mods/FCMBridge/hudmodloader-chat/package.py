#!/usr/bin/env python3
"""Package the optional HUDModLoader widget for a specific FCM environment."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
TARGETS = {
    "dev": {
        "endpoint": "wss://dev.falloutchatmod.com/relay",
        "link_url": "dev.falloutchatmod.com/link",
        "label": "DEV",
    },
    "prod": {
        "endpoint": "wss://falloutchatmod.com/relay",
        "link_url": "falloutchatmod.com/link",
        "label": "PRODUCTION",
    },
}


def replace_active_line(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^{re.escape(key)}=.*$")
    updated, count = pattern.subn(f"{key}={value}", text, count=1)
    if count != 1:
        raise ValueError(f"Expected exactly one active {key}= line")
    return updated


def stamp_configs(target: str, chat_ini: str, widget_ini: str) -> tuple[str, str]:
    config = TARGETS[target]
    return (
        replace_active_line(chat_ini, "linkUrl", config["link_url"]),
        replace_active_line(widget_ini, "Endpoint", config["endpoint"]),
    )


def install_instructions(target: str) -> str:
    config = TARGETS[target]
    return f"""Fallout Chat Mod — optional in-game HUD chat ({config['label']})

This archive is the explicit opt-in in-game HUD-mod track. It is separate from
the desktop overlay and requires ZFE 0.9.9+ and HUDModLoader.

1. Exit Fallout 76 completely.
2. Extract this archive into the Fallout 76 installation folder, preserving Data/.
3. Merge this into Fallout76Custom.ini (usually in Documents/My Games/Fallout 76):

   [Archive]
   sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2

4. Start Fallout 76 and open the HUDModLoader F11 menu. If the widget is not
   already listed, append `FCMChatWidget` to Data/hudmodloader.ini.

Account linking for this {config['label']} package:
  {config['link_url']}

The relay endpoint is:
  {config['endpoint']}

When the in-game widget shows a fresh 8-character code, open the link above,
sign in with Discord, enter the code, and return to the game. Codes expire after
10 minutes; reconnect the widget to request a new code if needed.
"""


def build_package(target: str, output: Path) -> None:
    chat_ini, widget_ini = stamp_configs(
        target,
        (ROOT / "FCMChat.ini").read_text(encoding="utf-8"),
        (ROOT / "FCMChatWidget.ini").read_text(encoding="utf-8"),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("INSTALL.txt", install_instructions(target))
        archive.writestr(
            "Fallout76Custom.ini.example",
            "[Archive]\n"
            "sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n",
        )
        archive.write(ROOT / "FCMChatWidget.ba2", "Data/FCMChatWidget.ba2")
        archive.writestr("Data/FCMChat.ini", chat_ini)
        archive.writestr("Data/ZFE/TextChat/fragments/FCMChatWidget.ini", widget_ini)
        archive.write(ROOT / "hudmodloader.ini", "Data/hudmodloader.ini")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build_package(args.target, args.output)
    print(f"wrote {args.output} ({args.target})")


if __name__ == "__main__":
    main()
