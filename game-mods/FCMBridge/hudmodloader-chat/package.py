#!/usr/bin/env python3
"""Package the optional HUDModLoader widget for a specific FCM environment."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
VERSION_SOURCE = ROOT / "FCMChatWidget.hx"
NEXUS_BLOCKED_SUFFIXES = {
    ".bat", ".cmd", ".com", ".dll", ".exe", ".js", ".jse", ".msi",
    ".msp", ".ps1", ".psd1", ".psm1", ".scr", ".sh", ".vbe", ".vbs",
    ".wsf", ".wsh",
}
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


def install_instructions(
    target: str, provider: str = "unified", distribution: str = "website"
) -> str:
    config = TARGETS[target]
    version = widget_version()
    provider_label = "xScal" if provider == "xscal" else "ZFE"
    config_file = "xscal.ini.example" if provider == "xscal" else "Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
    provider_setup = (
        "Optional Windows helper: double-click Enable-xScal-Chat.cmd in the game folder.\n"
        "   It backs up xscal.ini, sets [Chat] enabled=true and this package's relayEndpoint,\n"
        "   and preserves all other settings. xScal ships with chat disabled by default.\n"
        "   Extracting the BA2 or xscal.ini.example alone does NOT enable chat.\n"
        "   Linux/Proton or manual setup: edit the EXISTING [Chat] section in xscal.ini\n"
        "   beside Fallout76.exe using xscal.ini.example: change enabled=false to enabled=true\n"
        "   and set relayEndpoint to the value below. Do not add a second [Chat] section.\n"
        "   Preserve xScalPriority and all other sections, then restart Fallout 76."
        if provider == "xscal" else
        "The ZFE TextChat fragment supplies the relay endpoint and OpenChatKey. Keep\n"
        "   FCMChat.ini openKey aligned with that key and any Data/configuration/zfe.ini override."
    )
    if provider == "unified":
        provider_label = "ZFE or xScal"
        config_file = "examples/ZFE/FCMChatWidget.ini.example\n   xscal.ini.example"
        provider_setup = (
            "Choose ONE installed extender; the widget detects it automatically.\n"
            "   ZFE: copy examples/ZFE/FCMChatWidget.ini.example to\n"
            "   Data/ZFE/TextChat/fragments/FCMChatWidget.ini. Create that folder if needed.\n"
            "   Keep OpenChatKey aligned with Data/FCMChat.ini openKey. See KEYBINDS.txt.\n"
            "   xScal: do NOT install the ZFE example or create ZFE folders. On Windows,\n"
            "   run Enable-xScal-Chat.cmd beside Fallout76.exe. It backs up xscal.ini,\n"
            "   sets [Chat] enabled=true and relayEndpoint, and preserves other settings.\n"
            "   On Linux/Proton, merge xscal.ini.example into the EXISTING [Chat] section\n"
            "   of xscal.ini. Do not replace the entire file or add a duplicate section.\n"
            "   The example alone does not enable xScal chat; apply these settings."
        )
    if distribution == "nexus" and provider in ("xscal", "unified"):
        provider_setup = provider_setup.replace(
            "run Enable-xScal-Chat.cmd beside Fallout76.exe.",
            "download the optional setup helpers using DOWNLOAD-XSCAL-SETUP-HELPERS.txt.",
        ).replace(
            "double-click Enable-xScal-Chat.cmd in the game folder.",
            "download the optional setup helpers using DOWNLOAD-XSCAL-SETUP-HELPERS.txt.",
        )
    if provider in ("xscal", "unified"):
        provider_setup += (
            "\n\n   MANUAL xScal SETUP - NO INSTALLER REQUIRED (Windows or Linux/Proton):\n"
            "   Back up xscal.ini beside Fallout76.exe. Edit its existing [Chat] section:\n\n"
            f"   [Chat]\n   enabled=true\n   relayEndpoint={config['endpoint']}\n\n"
            "   Change enabled=false to enabled=true and replace the relayEndpoint value.\n"
            "   If [Chat] is missing, add it once. If xscal.ini is missing, create a plain-text\n"
            "   xscal.ini beside Fallout76.exe, not xscal.ini.txt, with the settings above.\n"
            "   Preserve unrelated settings; do not duplicate sections or keys.\n"
            "   New users must apply these settings too: xScal ships with chat disabled.\n"
            "   The example file alone does not enable chat. The setup helper is optional.\n"
            "   xScal has no OpenChatKey setting. Data/FCMChat.ini openKey is mapped to\n"
            "   xScal's documented Input.* physical polling, with the named-action fallback.\n"
            "   Registration does not suppress keyboard input; test gameplay conflicts. See KEYBINDS.txt.\n"
            "   Restart Fallout 76 after changing the configuration."
        )
    if provider == "unified":
        provider_setup += (
            "\n\n   MANUAL ZFE SETUP - NO INSTALLER REQUIRED:\n"
            "   Copy the COMPLETE examples/ZFE/FCMChatWidget.ini.example file to\n"
            "   Data/ZFE/TextChat/fragments/FCMChatWidget.ini, removing the .example suffix.\n"
            "   Create the folders if missing. Back up an existing fragment before replacing it.\n"
            f"   The example includes Endpoint={config['endpoint']}; copy all its settings,\n"
            "   not just the Endpoint line. Keep OpenChatKey aligned with Data/FCMChat.ini\n"
            "   openKey. IMPORTANT: Data/configuration/zfe.ini is a higher-priority global override.\n"
            "   Merge examples/ZFE/zfe.ini.example into that existing file if an override is needed.\n"
            "   If it exists, check its [TextChat] section and set:\n\n"
            f"   [TextChat]\n   Endpoint={config['endpoint']}\n   OpenChatKey=INSERT\n\n"
            "   Replace stale Endpoint values, preserve unrelated settings, and do not duplicate\n"
            "   the section or key. If no override is needed, leave the endpoint out of zfe.ini\n"
            "   so the packaged fragment supplies it. ZFE does not need xscal.ini.\n"
            "   To change the open-chat key, set the same value in Data/FCMChat.ini openKey\n"
            "   and zfe.ini OpenChatKey. DELETE is the recommended alternative to INSERT.\n"
            "   Supported values and precedence are documented in KEYBINDS.txt.\n"
            "   Restart Fallout 76 after changing the configuration."
        )
    setup_files = ""
    if provider in ("xscal", "unified"):
        setup_files = (
            "   DOWNLOAD-XSCAL-SETUP-HELPERS.txt\n"
            if distribution == "nexus"
            else "   Enable-xScal-Chat.cmd\n   Enable-xScal-Chat.ps1\n"
        )
    return f"""Fallout Chat Mod - optional in-game HUD chat ({config['label']})

FCMChatWidget version: {version}

This archive is the explicit opt-in in-game HUD-mod track. It is separate from
the desktop overlay. It connects to {config['label'].lower()} through ZFE chat.v1
or xScal chatInterface, selected automatically. The BA2 is identical for both providers.
This package contains configuration examples for {provider_label}. Install ONE extender and HUDModLoader.
On first subscribe, both providers receive the same complete bounded history: up to
15 recent messages for each static channel and up to 50 messages from the current
server room (125 events total). The native poll limit is 64. xScal's asynchronous
subscriber is drained across multiple short warm-up polls; ZFE gets a short second
drain when its first queue batch is full. Both providers use delayed authenticated
RESYNC recovery if static history is missing or the native queue reports loss.

Send an emoji with /emoji <name>, e.g. /emoji heart or /emoji thumbs_up.
Use an exact custom Discord emoji name to send a bundled custom emoji.

Unicode and bundled custom Discord emojis render as inline artwork. Styling and
emoji rendering have been tested in-game with xScal and ZFE. Animated custom emojis
use static artwork. New or unbundled custom emojis use readable names.
New Discord emoji require refreshed HUD assets. Artwork attribution: licenses/emoji/NOTICE.txt.

For ZFE, also check Data/configuration/zfe.ini. ZFE applies this global file after
the TextChat fragment, so its [TextChat] values override the packaged fragment. If
you use a global endpoint override, it must be:

   [TextChat]
   Endpoint={config['endpoint']}

Replace any stale Endpoint value, preserve unrelated settings, and do not duplicate
the section or key. If no override is needed, leave the endpoint out of zfe.ini and
use the packaged fragment. A stale global endpoint can connect you to the wrong
account environment.

1. Exit Fallout 76 completely. Install HUDModLoader and ONE compatible extender
   (ZFE with chat.v1 support or xScal with chatInterface support) using their authors'
   instructions. The desktop overlay is not required for HUD chat.
2. Extract this archive into the Fallout 76 installation folder, preserving all
   existing files. The archive contains these files:

   Data/FCMChatWidget.ba2
   Data/FCMChat.ini
   {config_file}
{setup_files}   FCMChatWidget.hudmodloader.ini
   FCMChatWidget.version.txt
   FCMChatWidget.provider.txt
   HUDMODLOADER-MENU.txt
   KEYBINDS.txt
   Fallout76Custom.ini.example

   The file `FCMChatWidget.hudmodloader.ini` is an append-only snippet; it is
   intentionally not extracted into `Data/`.

3. Back up and open the existing `Data/hudmodloader.ini` and append the single line from
   `FCMChatWidget.hudmodloader.ini` exactly once. Preserve every existing widget
   entry; do not replace the file.

4. Back up and open `Fallout76Custom.ini` and append `FCMChatWidget.ba2` to the existing
   `[Archive]` `sResourceArchive2List` value. Preserve every existing archive;
   do not replace the full list. If the section or key is missing, create:

   [Archive]
   sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2

   Native Windows normally stores `Fallout76Custom.ini` in
   `Documents/My Games/Fallout 76/`. Proton/Wine normally stores it in the
   Fallout 76 Steam prefix under `compatdata/1151340/pfx/drive_c/users/steamuser/`.
   Inside that prefix, use `Documents/My Games/Fallout 76/Fallout76Custom.ini`.
   Do not duplicate [Archive] sections or sResourceArchive2List keys.
   The `Data/` files always belong in the Fallout 76 game installation folder.

   {provider_setup}

5. Start Fallout 76 and open the HUDModLoader menu:
   a. Press F11 to open the menu.
   b. Confirm the `FCM` menu is present and choose `Customize...` for widget
      settings. The menu also provides `Scroll to newest`, `Hide chat`, and
      the auto-hide toggle. Read CUSTOMIZATION.txt for all appearance controls,
      exact INI values, and fixed features.
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
sign in with Steam or Discord, enter the code, and return to the game. Codes expire after
10 minutes; reconnect the widget to request a new code if needed.
Steam sign-in does not require Discord. If your name is blank, your Steam display
name is used. You can link Discord later from your profile.

Saved geometry:
  ZFE uses its vendor-scoped local settings store. On xScal, position and size are
  saved per linked relay device by the v2.10.61+ backend and restored after reconnect.
  Saving requires a working linked connection; other xScal appearance settings remain
  session-only. Desktop and laptop devices keep separate positions and sizes.

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
  Unicode and bundled custom Discord emojis render inline; animated emojis use static artwork. Public feed image/GIF attachments are not relayed into the HUD.
"""


def xscal_config_example(target: str) -> str:
    """Return target-specific xScal chat settings without overwriting user config."""
    return (
        "[Chat]\n"
        "enabled=true\n"
        f"relayEndpoint={TARGETS[target]['endpoint']}\n"
    )


def nexus_helper_download(target: str) -> str:
    """Point Nexus users to the website ZIP that may contain setup scripts."""
    version = widget_version()
    host = "dev.falloutchatmod.com" if target == "dev" else "falloutchatmod.com"
    label = "DEV" if target == "dev" else "PROD"
    filename = f"FCM HUD Mod-{version} ({label}).zip".replace(" ", "%20")
    return (
        "Fallout Chat Mod - optional xScal setup helpers\n"
        "=================================================\n\n"
        "Executable and script files are never bundled in the Nexus HUD archive.\n"
        "Download the website HUD ZIP if you want the optional Windows helpers:\n\n"
        f"https://{host}/downloads/electron/{filename}\n\n"
        "Manual xScal setup is documented in INSTALL.txt and needs no helper.\n"
    )


def assert_nexus_archive_safe(output: Path) -> None:
    """Fail closed when a Nexus HUD ZIP contains executable/script entries."""
    with ZipFile(output) as archive:
        blocked_names = [
            name for name in archive.namelist()
            if Path(name).suffix.lower() in NEXUS_BLOCKED_SUFFIXES
        ]
        executable_magic = []
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            prefix = archive.read(name)[:4]
            if (
                prefix.startswith((b"MZ", b"\x7fELF", b"#!"))
                or prefix in {b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"}
            ):
                executable_magic.append(name)
    blocked = sorted(set(blocked_names + executable_magic))
    if blocked:
        output.unlink(missing_ok=True)
        raise ValueError(f"Nexus HUD archive contains executable/script files: {blocked}")


def build_package(
    target: str,
    output: Path,
    provider: str = "unified",
    distribution: str = "website",
) -> None:
    if provider not in ("zfe", "xscal", "unified"):
        raise ValueError("provider must be unified, zfe or xscal")
    if distribution not in ("website", "nexus"):
        raise ValueError("distribution must be website or nexus")
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
        archive.write(ROOT / "CUSTOMIZATION.txt", "CUSTOMIZATION.txt")
        archive.writestr("INSTALL.txt", install_instructions(target, provider, distribution))
        for notice in ("NOTICE.txt", "LICENSE-TWEMOJI.txt", "LICENSE-UNICODE.txt"):
            archive.write(ROOT / "emoji" / notice, "licenses/emoji/" + notice)
        archive.writestr(
            "HUDMODLOADER-MENU.txt",
            "FCMChatWidget HUDModLoader menu\n"
            "================================\n\n"
            "1. Start Fallout 76 with ZFE or xScal and HUDModLoader enabled.\n"
            "2. Press F11 to open or close the HUDModLoader menu.\n"
            "3. Open FCM -> Customize... for separate panel width/height, input height/text size,\n"
            "   feed text size, position, opacity, and Colors... controls. Input width/alignment\n"
            "   stay fixed to the widget input area, including the ZFE editor.\n"
            "   See CUSTOMIZATION.txt for exact INI keys, fixed features, and saved settings.\n"
            "4. FCM -> Customize... -> Reset all settings restores packaged defaults.\n"
            "5. FCM -> Scroll to newest jumps to the end of the feed.\n"
            "6. FCM -> Hide chat hides the feed; press the configured open key to restore it.\n"
            "7. FCM -> Auto-hide toggles automatic hiding independently of the saved delay.\n"
            "   Customize -> Hide delay +/- changes seconds without enabling a disabled timer.\n"
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
            "Unicode and bundled custom Discord emojis render inline. Animated\n"
            "emojis use static artwork. Public feed\n"
            "image/GIF attachments are intentionally not relayed.\n\n"
            "If FCM is missing, confirm that FCMChatWidget appears exactly once in\n"
            "Data/hudmodloader.ini, then restart Fallout 76.\n"
        )
        archive.writestr(
            "Fallout76Custom.ini.example",
            "[Archive]\n"
            "sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n",
        )
        archive.writestr("FCMChatWidget.provider.txt", provider + "\n")
        if provider in ("xscal", "unified"):
            archive.writestr("xscal.ini.example", xscal_config_example(target))
            if distribution == "website":
                setup = (ROOT / "Enable-xScal-Chat.ps1").read_text(encoding="ascii")
                archive.writestr("Enable-xScal-Chat.ps1", setup.replace("@@FCM_RELAY_ENDPOINT@@", TARGETS[target]["endpoint"]))
                archive.writestr("Enable-xScal-Chat.cmd",
                    '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-xScal-Chat.ps1"\r\n'
                    'set "fcmExitCode=%errorlevel%"\r\npause\r\nexit /b %fcmExitCode%\r\n')
            else:
                archive.writestr(
                    "DOWNLOAD-XSCAL-SETUP-HELPERS.txt",
                    nexus_helper_download(target),
                )
        archive.write(widget_artifact, "Data/FCMChatWidget.ba2")
        archive.writestr("Data/FCMChat.ini", chat_ini)
        archive.write(ROOT / "KEYBINDS.txt", "KEYBINDS.txt")
        if provider == "zfe":
            archive.writestr("Data/ZFE/TextChat/fragments/FCMChatWidget.ini", widget_ini)
        if provider == "unified":
            archive.writestr("examples/ZFE/FCMChatWidget.ini.example", widget_ini)
            archive.writestr(
                "examples/ZFE/zfe.ini.example",
                "; Optional endpoint override for Data/configuration/zfe.ini.\n"
                "; Merge these keys into the existing [TextChat] section; preserve other settings.\n"
                "; Do not replace the whole file. xScal users do not install this example.\n"
                "; Keep OpenChatKey identical to Data/FCMChat.ini openKey. See KEYBINDS.txt.\n"
                "[TextChat]\n"
                f"Endpoint={TARGETS[target]['endpoint']}\n"
                "OpenChatKey=INSERT\n",
            )
        # This is a user-applied append snippet, not a file to extract over the
        # user's existing HUDModLoader registry. Keeping it at the archive root
        # makes accidental overwrite impossible.
        archive.writestr(
            "FCMChatWidget.hudmodloader.ini",
            "FCMChatWidget\n",
        )
        archive.writestr("FCMChatWidget.version.txt", f"{version}\n")
    if distribution == "nexus":
        assert_nexus_archive_safe(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["unified", "zfe", "xscal"], default="unified",
                        help="one shared BA2 and both extender examples by default; legacy provider-only packages optional")
    parser.add_argument("--distribution", choices=["website", "nexus"], default="website",
                        help="website includes optional helpers; Nexus fails closed on executable/script files")
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
    build_package(args.target, args.output, args.provider, args.distribution)
    print(f"wrote {args.output} ({args.target})")


if __name__ == "__main__":
    main()
