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

# Keep the shipped INI key map visible in every generated user-facing guide. Empty values are
# deliberate defaults: they leave Home/End available to the game and keep hide on /hide or F11.
HUD_KEY_DEFAULTS = (
    "openKey=INSERT\n"
    "channelNextKey=NextPage\n"
    "channelPrevKey=PrevPage\n"
    "scrollUpKey=Up\n"
    "scrollDownKey=Down\n"
    "scrollBottomKey=\n"
    "hideKey=\n"
)


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
    """Generate short, provider-specific installation instructions."""
    config = TARGETS[target]
    version = widget_version()
    endpoint = config["endpoint"]
    label = config["label"]

    if distribution == "website":
        xscal_files = (
            "   Enable-xScal-Chat.cmd\n"
            "   Enable-xScal-Chat.ps1\n"
        )
        xscal_helper = (
            "  Windows: optionally run Enable-xScal-Chat.cmd from the game folder.\n"
            "  It backs up xscal.ini, enables the section, and preserves other settings.\n"
            "  Linux/Proton: use the manual edit above; the helper is Windows-only.\n"
        )
    else:
        xscal_files = "   DOWNLOAD-XSCAL-SETUP-HELPERS.txt\n"
        xscal_helper = (
            "  This Nexus archive omits executable and script files. Use the manual edit above.\n"
            "  DOWNLOAD-XSCAL-SETUP-HELPERS.txt explains where the optional website helper is found.\n"
        )

    zfe_fragment = (
        "Data/ZFE/TextChat/fragments/FCMChatWidget.ini"
        if provider == "zfe"
        else "examples/ZFE/FCMChatWidget.ini.example"
    )
    zfe_copy = (
        "  The ZFE fragment is already at Data/ZFE/TextChat/fragments/FCMChatWidget.ini."
        if provider == "zfe"
        else "  Copy examples/ZFE/FCMChatWidget.ini.example to\n"
             "  Data/ZFE/TextChat/fragments/FCMChatWidget.ini."
    )
    zfe_destination_note = "" if provider == "zfe" else " Create the destination folders if needed."
    zfe_example_note = (
        "  The archive includes examples/ZFE/zfe.ini.example as a global-override template.\n"
        if provider == "unified"
        else ""
    )
    zfe_setup = (
        "ZFE setup\n"
        "---------\n"
        f"{zfe_copy}{zfe_destination_note}\n"
        "  The fragment supplies the relay endpoint and OpenChatKey. Keep\n"
        "  Data/FCMChat.ini openKey equal to OpenChatKey (INSERT by default).\n"
        "  If Data/configuration/zfe.ini contains [TextChat], it overrides the fragment.\n"
        "  Merge settings into that existing section; do not replace the file or duplicate keys.\n"
        "  If you use an override, set:\n\n"
        "  [TextChat]\n"
        f"  Endpoint={endpoint}\n"
        "  OpenChatKey=INSERT\n\n"
        f"{zfe_example_note}"
        "  Do not install xscal.ini. Restart Fallout 76 after changing ZFE configuration.\n"
    )
    xscal_setup = (
        "xScal setup\n"
        "------------\n"
        "  xScal ships with chat disabled. Merge xscal.ini.example into the existing\n"
        "  [Chat] section in xscal.ini beside Fallout76.exe:\n\n"
        "  [Chat]\n"
        "  enabled=true\n"
        f"  relayEndpoint={endpoint}\n\n"
        "  If the section or file is missing, add it once. Preserve unrelated settings\n"
        "  and do not duplicate the [Chat] section.\n"
        f"{xscal_helper}"
        "  xScal has no OpenChatKey setting. Data/FCMChat.ini openKey is mapped through\n"
        "  xScal Input.*; see KEYBINDS.txt for key behavior.\n"
        "  Do not install the ZFE fragment or create Data/ZFE folders. Restart Fallout 76\n"
        "  after changing xScal configuration.\n"
    )

    if provider == "zfe":
        extender_instruction = (
            "1. Exit Fallout 76. Install HUDModLoader and the ZFE script extender with\n"
            "   chat.v1 support, using the authors' instructions."
        )
        provider_intro = (
            "This archive is for ZFE with HUDModLoader. Do not install xScal configuration.\n"
        )
        provider_files = f"   {zfe_fragment}\n"
        provider_setup = zfe_setup
    elif provider == "xscal":
        extender_instruction = (
            "1. Exit Fallout 76. Install HUDModLoader and the xScal script extender with\n"
            "   chatInterface support, using the authors' instructions."
        )
        provider_intro = (
            "This archive is for xScal with HUDModLoader. Do not install ZFE configuration.\n"
        )
        provider_files = "   xscal.ini.example\n" + xscal_files
        provider_setup = xscal_setup
    else:
        extender_instruction = (
            "1. Exit Fallout 76. Install HUDModLoader and exactly one script extender:\n"
            "   ZFE with chat.v1 support or xScal with chatInterface support."
        )
        provider_intro = (
            "Choose exactly one script extender: ZFE or xScal. Install only that provider's "
            "configuration section below.\n"
        )
        provider_files = (
            "   examples/ZFE/FCMChatWidget.ini.example\n"
            "   examples/ZFE/zfe.ini.example\n"
            "   xscal.ini.example\n"
            f"{xscal_files}"
        )
        provider_setup = (
            "Choose one provider\n"
            "-------------------\n"
            f"{zfe_setup}\n"
            f"{xscal_setup}"
        )

    return f"""Fallout Chat Mod - optional in-game HUD chat ({label})

FCMChatWidget version: {version}

This archive installs the optional in-game HUD-mod track through HUDModLoader. It is
separate from the desktop overlay; the desktop overlay is not required for HUD chat.
{provider_intro}The BA2 works with the selected provider and connects to {label.lower()}.

Installation
------------
{extender_instruction}
2. Extract this archive into the Fallout 76 game folder. Keep the existing files in
   place; do not replace unrelated configuration. The important files are:

   Data/FCMChatWidget.ba2
   Data/FCMChat.ini
{provider_files}   FCMChatWidget.hudmodloader.ini
   FCMChatWidget.version.txt
   HUDMODLOADER-MENU.txt
   KEYBINDS.txt
   CUSTOMIZATION.txt
   Fallout76Custom.ini.example

3. Open the existing Data/hudmodloader.ini and append the one line in
   FCMChatWidget.hudmodloader.ini exactly once. Do not replace the file.
4. Open Fallout76Custom.ini and append FCMChatWidget.ba2 to the existing
   [Archive] sResourceArchive2List value. Preserve every existing archive. If the
   section or key is missing, use:

   [Archive]
   sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2

   Windows normally stores this file in Documents/My Games/Fallout 76/.
   Proton/Wine uses the Fallout 76 prefix's Documents/My Games/Fallout 76/ folder.

5. Configure the chosen extender:

{provider_setup}
6. Start Fallout 76. Press F11 and confirm the FCM menu appears. Use FCM -> Customize...
   for appearance settings. The menu also provides Hide chat, Auto-hide, and Scroll to
   newest. If FCM is missing, verify the HUDModLoader line and BA2 archive entry, then restart.
7. When the widget shows an 8-character link code, open {config['web_link_url']}, sign in,
   enter the code, and return to the game. Codes expire after 10 minutes.

Key defaults
------------
The shipped Data/FCMChat.ini [FCMChat] key map is:
{HUD_KEY_DEFAULTS}
Insert opens the input; Enter sends; Escape cancels; Page Up/Page Down switch channels.
scrollUpKey=Up and scrollDownKey=Down (Arrow Up / Down) scroll after Insert opens the input.
scrollBottomKey is blank by default; set it in Data/FCMChat.ini (for example Home, End, or F12)
if you want a keyboard shortcut for newest. hideKey is also blank by default; use /hide or the
F11 menu to hide the feed. See KEYBINDS.txt
for ZFE and xScal key paths, supported physical tokens, and conflict guidance.

General shows General, current-room Server, Trading, Events, Infests, and Raids together.
Each message keeps its source label; other tabs filter the same history. Sending from General
still goes to General. Replayed messages keep their existing duplicate guard.
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
            "   General combines all six feeds, keeping each message's source label.\n"
            "   Other tabs show only their own channel. Sending from General targets General.\n"
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
            "Shipped Data/FCMChat.ini key map:\n"
            + HUD_KEY_DEFAULTS
            + "\nPress Insert while Fallout 76 is focused to start typing. Press\n"
            "Enter to send or Escape to cancel. Page Down / Page Up switch\n"
            "channels. After Insert opens the typing session, the configured\n"
            "scrollUpKey / scrollDownKey values scroll the feed (Arrow Up / Down\n"
            "are the defaults). scrollBottomKey is blank by default; set it in\n"
            "Data/FCMChat.ini to Home, End, F12, or a forwarded action if desired.\n"
            "hideKey is blank by default; /hide and FCM -> Hide chat remain available.\n"
            "Before Insert, configured feed keys remain game controls. FCM -> Scroll\n"
            "to newest is always available from the F11 menu. Type /g, /t, /e, /i,\n"
            "or /r before a message to route it to General, Trading, Events, Infests,\n"
            "or Raids. /s (or /server) is available after the current server/world\n"
            "session is confirmed.\n"
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
