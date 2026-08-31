#!/usr/bin/env python3
"""Regression checks for the repeatable HUD/Nexus release contract."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    nexus = (ROOT / "Packaging/publish-nexus-release.ps1").read_text(encoding="utf-8")
    install_page = (ROOT / "admin-dashboard/src/features/auth/LandingPage.tsx").read_text(
        encoding="utf-8"
    )
    linux_install = (ROOT / "cross-platform-overlay/assets/install/INSTALL-LINUX.txt").read_text(
        encoding="utf-8"
    )
    linux_cli = (ROOT / "Packaging/linux/install.sh").read_text(encoding="utf-8")
    linux_helper = (ROOT / "cross-platform-overlay/main.js").read_text(encoding="utf-8")

    required_nexus_markers = (
        "$hudGroup   = $env:NEXUS_FILE_GROUP_ID_HUD",
        "$linuxDebGroup = $env:NEXUS_FILE_GROUP_ID_LINUX_DEB",
        "NEXUS_FILE_GROUP_ID_LINUX_DEB",
        "NEXUS_FILE_GROUP_ID_HUD",
        "$hudVersion = (& $pythonCommand.Source $hudPackage --print-version).Trim()",
        '$hudZip   = Join-Path $DistDir "ZFE FCM HUD Mod-$hudVersion (PROD).zip"',
        '@{ Name = "HUD";',
        "NexusVersion = $hudVersion",
        'Category = "optional"',
        "FileCategory  = $p.Category",
        '$linuxDeb = Join-Path $DistDir "Fallout Chat Mod-$Version.deb"',
        '@{ Name = "Linux .deb";',
    )
    for marker in required_nexus_markers:
        assert marker in nexus, f"Nexus release path is missing: {marker}"

    # The HUD download must remain in the first install section, before the
    # platform-specific Windows section, so it is visible without scrolling.
    hud_marker = "Optional in-game HUD mod — keep the download visible at the top"
    assert hud_marker in install_page
    assert install_page.index(hud_marker) < install_page.index(
        "{/* ── Windows ─────────────────────────────────────────────────── */}"
    )
    assert "↓ ZFE FCM HUD Mod ZIP {hudModVersion}" in install_page
    for marker in (
        "electronLinuxAppImageUrl",
        "electronLinuxDebUrl",
        "electronLinuxZipUrl",
        "↓ LINUX APPIMAGE {verTag}",
        "↓ LINUX .DEB {verTag}",
        "↓ LINUX ZIP + DOCS {verTag}",
        "window.location.hostname === 'dev.falloutchatmod.com'",
    ):
        assert marker in install_page, f"website Linux download control is missing: {marker}"
    for marker in (
        "STEP 1 — PREPARE",
        "Data/FCMChatWidget.ba2",
        "Data/ZFE/TextChat/fragments/FCMChatWidget.ini",
        "Data/hudmodloader.ini",
        "FCMChatWidget.hudmodloader.ini",
        "Fallout76Custom.ini",
        "8-character code",
    ):
        assert marker in install_page, f"HUD install instructions are missing: {marker}"

    for source, label in (
        (install_page, "website Linux instructions"),
        (linux_install, "packaged Linux instructions"),
        (linux_cli, "CLI installer notes"),
        (linux_helper, "runtime Linux helper notes"),
    ):
        for marker in ("Hyprland", "hyprctl", "plain X11", "game-running fallback"):
            assert marker.lower() in source.lower(), f"{label} is missing Linux detection marker: {marker}"

    # The merged Linux PR made cursor locking explicit/on-demand. Keep the
    # public page from regressing to the old silent Proton/Wine mutation claim.
    assert "The installer enables it for" not in install_page
    assert "never changes the FO76 Proton/Wine" in install_page

    print("release script contract tests passed")


if __name__ == "__main__":
    main()
