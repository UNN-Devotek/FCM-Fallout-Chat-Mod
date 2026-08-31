#!/usr/bin/env python3
"""Package the optional HUDModLoader widget for a specific FCM environment."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
VERSION_SOURCE = ROOT / "FCMChatWidget.hx"
TARGETS = {
    "dev": {
        "endpoint": "wss://dev.falloutchatmod.com/relay",
        "link_url": "dev.falloutchatmod.com/link",
        "web_link_url": "https://dev.falloutchatmod.com/link",
        "label": "DEV",
    },
    "prod": {
        "endpoint": "wss://falloutchatmod.com/relay",
        "link_url": "falloutchatmod.com/link",
        "web_link_url": "https://falloutchatmod.com/link",
        "label": "PRODUCTION",
    },
}


def widget_version() -> str:
    """Read the packaged widget version from the Haxe runtime source."""
    source = VERSION_SOURCE.read_text(encoding="utf-8")
    match = re.search(r'(?m)^\s*static inline var VERSION:String\s*=\s*"([^"]+)";', source)
    if not match:
        raise ValueError(f"Could not find VERSION in {VERSION_SOURCE}")
    return match.group(1)


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
    version = widget_version()
    return f"""Fallout Chat Mod - optional in-game HUD chat ({config['label']})

FCMChatWidget version: {version}

This archive is the explicit opt-in in-game HUD-mod track. It is separate from
the desktop overlay. It connects to {config['label'].lower()} through ZFE chat.v1.
Install ZFE with chat.v1 support and HUDModLoader before installing this archive.

1. Exit Fallout 76 completely.
2. Extract this archive into the Fallout 76 installation folder, preserving all
   existing files. The archive contains these files:

   Data/FCMChatWidget.ba2
   Data/FCMChat.ini
   Data/ZFE/TextChat/fragments/FCMChatWidget.ini
   FCMChatWidget.hudmodloader.ini
   FCMChatWidget.version.txt
   Fallout76Custom.ini.example

   The file `FCMChatWidget.hudmodloader.ini` is an append-only snippet; it is
   intentionally not extracted into `Data/`.

3. Open the existing `Data/hudmodloader.ini` and append the single line from
   `FCMChatWidget.hudmodloader.ini` exactly once. Preserve every existing widget
   entry; do not replace the file.

4. Open `Fallout76Custom.ini` and append `FCMChatWidget.ba2` to the existing
   `[Archive]` `sResourceArchive2List` value. Preserve every existing archive;
   do not replace the full list. If the section or key is missing, create:

   [Archive]
   sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2

   Native Windows normally stores `Fallout76Custom.ini` in
   `Documents/My Games/Fallout 76/`. Proton/Wine normally stores it in the
   Fallout 76 Steam prefix under `compatdata/1151340/pfx/drive_c/users/steamuser/`.
   The `Data/` files always belong in the Fallout 76 game installation folder.

5. Start Fallout 76 and open the HUDModLoader F11 menu. Confirm that
   `FCMChatWidget` is listed.

Account linking for this {config['label']} package:
  {config['web_link_url']}

The relay endpoint is:
  {config['endpoint']}

When the in-game widget shows a fresh 8-character code, open the link above,
sign in with Discord, enter the code, and return to the game. Codes expire after
10 minutes; reconnect the widget to request a new code if needed.
"""


def build_package(target: str, output: Path) -> None:
    version = widget_version()
    widget_artifact = ROOT / "FCMChatWidget.ba2"
    if version.encode("ascii") not in widget_artifact.read_bytes():
        raise ValueError(
            f"{widget_artifact} does not contain the current widget version {version}; rebuild the BA2"
        )
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
        archive.write(widget_artifact, "Data/FCMChatWidget.ba2")
        archive.writestr("Data/FCMChat.ini", chat_ini)
        archive.writestr("Data/ZFE/TextChat/fragments/FCMChatWidget.ini", widget_ini)
        # This is a user-applied append snippet, not a file to extract over the
        # user's existing HUDModLoader registry. Keeping it at the archive root
        # makes accidental overwrite impossible.
        archive.writestr(
            "FCMChatWidget.hudmodloader.ini",
            "FCMChatWidget\n",
        )
        archive.writestr("FCMChatWidget.version.txt", f"{version}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--print-version",
        action="store_true",
        help="print the version embedded in FCMChatWidget.hx and exit",
    )
    args = parser.parse_args()
    if args.print_version:
        print(widget_version())
        return
    if not args.target or not args.output:
        parser.error("--target and --output are required unless --print-version is used")
    build_package(args.target, args.output)
    print(f"wrote {args.output} ({args.target})")


if __name__ == "__main__":
    main()
