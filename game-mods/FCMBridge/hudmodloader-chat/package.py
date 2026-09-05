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


def install_instructions(target: str, provider: str = "zfe") -> str:
    config = TARGETS[target]
    version = widget_version()
    provider_label = "xScal" if provider == "xscal" else "ZFE"
    config_file = "xscal.ini.example" if provider == "xscal" else "Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
    provider_setup = (
        "Merge the [Chat] section from xscal.ini.example into the existing xscal.ini beside\n"
        "   the game executable. Preserve xScalPriority and all other sections."
        if provider == "xscal" else
        "The ZFE TextChat fragment supplies the relay endpoint and OpenChatKey. Keep\n"
        "   FCMChat.ini openKey aligned with that key and any Data/configuration/zfe.ini override."
    )
    return f"""Fallout Chat Mod - optional in-game HUD chat ({config['label']})

FCMChatWidget version: {version}

This archive is the explicit opt-in in-game HUD-mod track. It is separate from
the desktop overlay. It connects to {config['label'].lower()} through ZFE chat.v1
or xScal chatInterface, selected automatically. The BA2 is identical for both providers.
This package contains setup files for {provider_label} only. Install {provider_label} and HUDModLoader.
On first subscribe, both providers receive the same complete bounded history: up to
15 recent messages for each static channel and up to 50 messages from the current
server room (125 events total). The native poll limit is 64. xScal's asynchronous
subscriber is drained across multiple short warm-up polls; ZFE gets a short second
drain when its first queue batch is full. Both providers use delayed authenticated
RESYNC recovery if static history is missing or the native queue reports loss.

1. Exit Fallout 76 completely.
2. Extract this archive into the Fallout 76 installation folder, preserving all
   existing files. The archive contains these files:

   Data/FCMChatWidget.ba2
   Data/FCMChat.ini
   {config_file}
   FCMChatWidget.hudmodloader.ini
   FCMChatWidget.version.txt
   FCMChatWidget.provider.txt
   HUDMODLOADER-MENU.txt
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

   {provider_setup}

5. Start Fallout 76 and open the HUDModLoader menu:
   a. Press F11 to open the menu.
   b. Confirm the `FCM` menu is present and choose `Customize...` for widget
      settings. The menu also provides `Scroll to newest`, `Hide chat`, and
      the auto-hide toggle.
   c. Choose `FCM` -> `Customize...` -> `Reset all settings` only when you
      want the packaged defaults restored. The environment-specific link URL
      is kept.
   d. Use the HUDModLoader reload control for live widget changes. If you replace
      the BA2 or provider configuration, exit Fallout 76 before copying the files
      and restart the game so native configuration is reloaded.

   If the widget is not listed under FCM, exit the game and verify that the
   `FCMChatWidget` line was appended exactly once to `Data/hudmodloader.ini`.

Account linking for this {config['label']} package:
  {config['web_link_url']}

The relay endpoint is:
  {config['endpoint']}

When the in-game widget shows a fresh 8-character code, open the link above,
sign in with Discord, enter the code, and return to the game. Codes expire after
10 minutes; reconnect the widget to request a new code if needed.

HUD input and commands:
  Press Insert while Fallout 76 is focused to start typing. Press Enter to send
  or Escape to cancel. Page Down / Page Up switch channels. After Insert opens
  the typing session, Arrow Up / Down scroll the feed, and Home / End return to
  the newest message; before Insert they remain game controls. Type /g, /t, /e,
  /i, or /r before a message to route it to General, Trading, Events, Infests,
  or Raids. /s (or /server) is available after the current server/world session
  is confirmed. Type /hide by itself to hide the feed; press Insert to restore it.
  Type /relink by itself to request that the active extender clear its local chat auth and issue
  a new link code. This requires clearChatAuth support; older builds will show a manual recovery
  instruction. Follow the provider configuration instructions above.
  While a draft is active, Control-Tab opens the game's social menu after the widget
  cancels its native or SharedHUDTools editor; Escape can then close the social menu normally.
  Input.* key polling does not itself suppress gameplay keys. Keyboard suppression
  is not claimed for xScal builds without a documented suppression API.
  Customize actions can be repeated without backing out to the parent menu.
  Auto-hide is shown with its current ON/OFF state the next time F11 opens.
  Discord custom emojis appear on the HUD as readable :name: labels; public
  feed image/GIF attachments are intentionally not relayed into the HUD.
"""


def xscal_config_example(target: str) -> str:
    """Return target-specific xScal chat settings without overwriting user config."""
    return (
        "[Chat]\n"
        "enabled=true\n"
        f"relayEndpoint={TARGETS[target]['endpoint']}\n"
    )


def build_package(target: str, output: Path, provider: str = "zfe") -> None:
    if provider not in ("zfe", "xscal"):
        raise ValueError("provider must be zfe or xscal")
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
        archive.writestr("INSTALL.txt", install_instructions(target, provider))
        archive.writestr(
            "HUDMODLOADER-MENU.txt",
            "FCMChatWidget HUDModLoader menu\n"
            "================================\n\n"
            "1. Start Fallout 76 with ZFE or xScal and HUDModLoader enabled.\n"
            "2. Press F11 to open or close the HUDModLoader menu.\n"
            "3. Open FCM -> Customize... to adjust size, position, opacity, or color theme.\n"
            "4. FCM -> Customize... -> Reset all settings restores packaged defaults.\n"
            "5. FCM -> Scroll to newest jumps to the end of the feed.\n"
            "6. FCM -> Hide chat hides the feed; press the configured open key to restore it.\n"
            "7. FCM -> Auto-hide toggles automatic hiding after inactivity.\n"
            "   The menu closes after the toggle so the next F11 open shows the\n"
            "   current ON/OFF state. Customize actions have a short repeat\n"
            "   cooldown and do not require backing out to the parent menu.\n"
            "8. FCM -> General / Trading / Events / Infests / Raids selects a channel;\n"
            "   SERVER appears after a current world binding is confirmed.\n"
            "9. Use the loader reload control for live widget changes. Replacing\n"
            "   the BA2 or a script-extender configuration fragment requires exiting and restarting\n"
            "   Fallout 76 so native configuration is reloaded.\n\n"
            "Initial history\n"
            "---------------\n"
            "Both ZFE and xScal receive the initial feed from the long-lived\n"
            "subscription: up to 15 recent messages for each static channel\n"
            "and up to 50 from the current SERVER room (125 events total).\n"
            "The native poll limit is 64. The xScal widget drains its\n"
            "asynchronous subscriber across multiple short warm-up polls; ZFE\n"
            "performs a short second drain only when its first queue batch is\n"
            "full. Both providers use delayed authenticated RESYNC recovery\n"
            "when static history is missing or the queue reports loss.\n\n"
            "HUD input and commands\n"
            "-----------------------\n"
            "Press Insert while Fallout 76 is focused to start typing. Press\n"
            "Enter to send or Escape to cancel. Page Down / Page Up switch\n"
            "channels. After Insert opens the typing session, Arrow Up / Down scroll\n"
            "the feed and Home / End return to the newest message; before Insert they\n"
            "remain game controls. Type /g, /t, /e, /i, or /r before a message to route it\n"
            "to General, Trading, Events, Infests, or Raids. /s (or /server)\n"
            "is available after the current server/world session is confirmed.\n"
            "Type /hide by itself to hide the feed; press Insert to restore it.\n"
            "Type /relink by itself to clear local chat auth and request a new\n"
            "link code. This requires clearChatAuth support; older builds must\n"
            "be reset using that extender's documented local-auth recovery.\n"
            "While a draft is active, Control-Tab opens the game's social menu\n"
            "after the widget cancels its editor; Escape can close the menu normally.\n"
            "See INSTALL.txt for this provider's configuration. Input.* polling alone\n"
            "does not suppress gameplay keys; xScal keyboard suppression is not claimed.\n\n"
            "Discord custom emojis render in the HUD as readable :name: labels;\n"
            "public feed image/GIF attachments are intentionally not relayed.\n\n"
            "If FCM is missing, confirm that FCMChatWidget appears exactly once in\n"
            "Data/hudmodloader.ini, then restart Fallout 76.\n"
        )
        archive.writestr(
            "Fallout76Custom.ini.example",
            "[Archive]\n"
            "sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n",
        )
        archive.writestr("FCMChatWidget.provider.txt", provider + "\n")
        if provider == "xscal":
            archive.writestr("xscal.ini.example", xscal_config_example(target))
        archive.write(widget_artifact, "Data/FCMChatWidget.ba2")
        archive.writestr("Data/FCMChat.ini", chat_ini)
        if provider == "zfe":
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
    parser.add_argument("--provider", choices=["zfe", "xscal"], default="zfe",
                        help="provider-specific setup files; the auto-detecting BA2 is shared")
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
    build_package(args.target, args.output, args.provider)
    print(f"wrote {args.output} ({args.target})")


if __name__ == "__main__":
    main()
