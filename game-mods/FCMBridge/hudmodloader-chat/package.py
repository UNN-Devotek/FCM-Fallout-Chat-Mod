#!/usr/bin/env python3
"""Package the optional HUDModLoader widget for a specific FCM environment."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
VERSION_SOURCE = ROOT / "FCMChatWidget.hx"
HUDMODLOADER_DEFAULTS_SOURCE = ROOT / "HUDMODLOADER-UPSTREAM-DEFAULTS.txt"
ZFE_FOLDER = "ZFE (Install for ZFE only)"
XSCAL_FOLDER = "xScal (Install for xScal only)"
DATA_FOLDER_LABEL = "Data (drag the contents into data folder)"
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
    "activateLinkKey=F8\n"
    "hideKey=DELETE\n"
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
    target: str, provider: str = "unified", distribution: str = "website",
    data_folder: str = "Data",
) -> str:
    """Short instructions for one selected provider."""
    if provider == "unified":
        return unified_install_instructions(target)
    if provider not in ("zfe", "xscal"):
        raise ValueError("provider must be zfe or xscal")
    config = TARGETS[target]
    provider_name = "ZFE" if provider == "zfe" else "xScal"
    provider_extra = (
        f"ZFE: the active fragment is {data_folder}/ZFE/TextChat/fragments/FCMChatWidget.ini.\n"
        "   Copy it only if missing; keep edits on updates. No separate zfe.ini is\n"
        "   included or required. If you already use a global [TextChat] override\n"
        "   in Data/configuration/zfe.ini, ensure its Endpoint matches the fragment.\n"
        if provider == "zfe" else
        "xScal: merge this folder's xscal.ini [Chat] keys into xscal.ini beside\n"
        "   Fallout76.exe. Set enabled=true and the packaged relayEndpoint. Keep\n"
        "   other sections and never add a second [Chat] section.\n"
    )
    helper = (
        "Optional Windows helper: Enable-xScal-Chat.cmd merges xscal.ini after a backup.\n"
        if provider == "xscal" and distribution == "website" else ""
    )
    return f"""Fallout Chat Mod HUD {widget_version()} — {provider_name} ({config['label']})

1. Close Fallout 76. Install HUDModLoader and {provider_name}.
2. Extract the ZIP outside the game. Use only this provider's folder.
3. Open {data_folder}/ and drag its contents into the game's Data folder.
   Do not copy the labeled folder itself. Skip existing INIs; keep edits.
4. If the game's Data/hudmodloader.ini is missing, copy this folder's
   {data_folder}/hudmodloader.ini (HUDModLoader defaults plus FCMChatWidget). Otherwise,
   add FCMChatWidget once to the existing file and preserve all other lines.
5. Manual BA2 install: append FCMChatWidget.ba2 once to the [Archive]
   sResourceArchive2List in your user profile's Documents/My Games/Fallout 76/
   Fallout76Custom.ini. This provider folder's root Fallout76Custom.ini is a
   merge template, never a replacement. Quick Configuration 2 or NukaMods:
   import only {data_folder}/FCMChatWidget.ba2 and let the manager maintain this entry.
   Do not import the combined ZIP or copy the BA2 yourself as well.
6. {provider_extra}{helper}7. Restart the game. Press F11 for the FCM menu, then link the displayed code
   at {config['web_link_url']}. Verify one deployed BA2 and one archive entry.

On updates replace only the BA2; keep edited INIs. The ZIP root README.txt has
keybind, customization, menu, and release details.
"""


def unified_install_instructions(target: str) -> str:
    config = TARGETS[target]
    return f"""Fallout Chat Mod HUD {widget_version()} ({config['label']})

Install HUDModLoader and exactly one extender with Fallout 76 closed. Extract
this ZIP outside the game. Open {ZFE_FOLDER}/INSTALL.txt or
{XSCAL_FOLDER}/INSTALL.txt and follow only that provider's steps.
Open its {DATA_FOLDER_LABEL}/ folder and drag its contents into the game's
Data folder. Skip existing INIs; do not copy the labeled folder itself.
Merge, never replace, existing hudmodloader.ini, Fallout76Custom.ini, or
xscal.ini. There is no separate zfe.ini in this package.

Quick Configuration 2/NukaMods: import only the chosen folder's
{DATA_FOLDER_LABEL}/FCMChatWidget.ba2, not this combined ZIP. The manager owns the BA2 and
archive list. On updates replace only the BA2 and preserve edited INIs.
"""


def xscal_config_example(target: str) -> str:
    """Return target-specific xScal chat settings without overwriting user config."""
    return (
        "[Chat]\n"
        "enabled=true\n"
        f"relayEndpoint={TARGETS[target]['endpoint']}\n"
    )


def hudmodloader_config() -> str:
    """Keep the upstream default list and add only the visible FCM widget."""
    defaults = [
        line.strip()
        for line in HUDMODLOADER_DEFAULTS_SOURCE.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if len(defaults) != len(set(defaults)) or "FCMServerBridge" in defaults:
        raise ValueError("Review the HUDModLoader default registry before packaging")
    return "\n".join([entry for entry in defaults if entry != "FCMChatWidget"] + ["FCMChatWidget"]) + "\n"


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
    if provider == "unified":
        layout_intro = (
            f"This ZIP has separate {ZFE_FOLDER}/ and {XSCAL_FOLDER}/ folders. Choose only\n"
            "the folder for the extender you already installed, then follow its INSTALL.txt.\n"
        )
    else:
        layout_intro = (
            f"This ZIP contains only the {provider.upper()} provider. Follow the INSTALLATION\n"
            "section below and use the files at the shown destination paths.\n"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        menu_text = (
            "FCMChatWidget HUDModLoader menu\n"
            "================================\n\n"
            "1. Start Fallout 76 with ZFE or xScal and HUDModLoader enabled.\n"
            "2. Press F11 to open or close the HUDModLoader menu.\n"
            "3. Open FCM -> Customize... for separate panel width/height, input height/text size,\n"
            "   feed text size, position, opacity, and Colors... controls. Input width/alignment\n"
            "   stay fixed to the widget input area, including the ZFE editor.\n"
            "   See the customization section in README.txt for exact INI keys and saved settings.\n"
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
            "activateLinkKey=F8 opens the selected link only while OpenChat owns input; Enter submits.\n"
            "Browser opening needs ZFE browser-v1; unsupported providers keep readable URLs.\n"
            "hideKey=DELETE hides while idle and edits text while input is open.\n"
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
            "See README.txt or the selected provider's INSTALL.txt for configuration. Input.* key polling\n"
            "alone does not suppress gameplay keys. xScal 0.2.18 native text\n"
            "sessions own text and editing keys while the session is active.\n\n"
            "Unicode and bundled custom Discord emojis render inline. Animated\n"
            "emojis use static artwork. Public feed\n"
            "image/GIF attachments are intentionally not relayed.\n\n"
            "If FCM is missing, confirm that FCMChatWidget appears exactly once in\n"
            "Data/hudmodloader.ini, then restart Fallout 76.\n"
        )
        readme_sections = (
            f"Fallout Chat Mod HUD {version} ({TARGETS[target]['label']})\n\n"
            + layout_intro
            + (f"Open the chosen {DATA_FOLDER_LABEL if provider == 'unified' else 'Data'}/ folder; "
               "drag its contents into the game Data folder, not the folder itself.\n"
               "Skip existing INIs and merge shared settings. The packaged hudmodloader.ini\n"
               "contains HUDModLoader defaults plus FCMChatWidget. Quick Configuration 2 and\n"
               f"NukaMods users import only {DATA_FOLDER_LABEL if provider == 'unified' else 'Data'}/FCMChatWidget.ba2.\n\n")
            + f"Version: {version}\nPackage provider: {provider}\n\n"
            "INSTALLATION\n============\n\n"
            + install_instructions(target, provider, distribution,
                                   DATA_FOLDER_LABEL if provider == "unified" else "Data")
            + "\n\nRELEASE NOTES\n=============\n\n"
            + (ROOT / "HUD-RELEASE-NOTES.txt").read_text(encoding="utf-8")
            + "\n\nHUDMODLOADER MENU\n=================\n\n"
            + menu_text
            + "\n\nKEYBINDS\n========\n\n"
            + (ROOT / "KEYBINDS.txt").read_text(encoding="utf-8").replace("KEYBINDS.txt", "README.txt")
            + "\n\nCUSTOMIZATION\n=============\n\n"
            + (ROOT / "CUSTOMIZATION.txt").read_text(encoding="utf-8")
                .replace("CUSTOMIZATION.txt", "README.txt").replace("KEYBINDS.txt", "README.txt")
        )
        archive.writestr("README.txt", readme_sections)
        for notice in ("NOTICE.txt", "LICENSE-TWEMOJI.txt", "LICENSE-UNICODE.txt"):
            archive.write(ROOT / "emoji" / notice, "licenses/emoji/" + notice)
        folders = ((ZFE_FOLDER + "/", "zfe"), (XSCAL_FOLDER + "/", "xscal")) if provider == "unified" else (("", provider),)
        for prefix, selected_provider in folders:
            if prefix:
                # The main ZIP is script-free for both distributions. Shared INI
                # files remain merge sources even when shown at destination paths.
                archive.writestr(prefix + "INSTALL.txt", install_instructions(target, selected_provider, "nexus", DATA_FOLDER_LABEL))
            data_prefix = prefix + (DATA_FOLDER_LABEL if prefix else "Data") + "/"
            archive.writestr(
                prefix + "Fallout76Custom.ini",
                "[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2\n",
            )
            archive.write(widget_artifact, data_prefix + "FCMChatWidget.ba2")
            archive.writestr(data_prefix + "FCMChat.ini", chat_ini)
            archive.writestr(data_prefix + "hudmodloader.ini", hudmodloader_config())
            if selected_provider == "zfe":
                archive.writestr(data_prefix + "ZFE/TextChat/fragments/FCMChatWidget.ini", widget_ini)
            else:
                archive.writestr(prefix + "xscal.ini", xscal_config_example(target))
                if distribution == "website" and provider != "unified":
                    setup = (ROOT / "Enable-xScal-Chat.ps1").read_text(encoding="ascii")
                    archive.writestr("Enable-xScal-Chat.ps1", setup.replace("@@FCM_RELAY_ENDPOINT@@", TARGETS[target]["endpoint"]))
                    archive.writestr("Enable-xScal-Chat.cmd",
                        '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-xScal-Chat.ps1"\r\n'
                        'set "fcmExitCode=%errorlevel%"\r\npause\r\nexit /b %fcmExitCode%\r\n')
    if distribution == "nexus":
        assert_nexus_archive_safe(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["unified", "zfe", "xscal"], default="unified",
                        help=f"main ZIP has complete {ZFE_FOLDER}/ and {XSCAL_FOLDER}/ folders; provider-only packages optional")
    parser.add_argument("--distribution", choices=["website", "nexus"], default="website",
                        help="xScal-only website ZIPs may include helpers; Nexus rejects executable/script files")
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
