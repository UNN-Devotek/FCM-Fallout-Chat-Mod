#!/usr/bin/env python3
"""Regression checks for the repeatable HUD/Nexus release contract."""

import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    nexus = (ROOT / "Packaging/publish-nexus-release.ps1").read_text(encoding="utf-8")
    release = (ROOT / "Packaging/release.ps1").read_text(encoding="utf-8")
    nexus_uploader = (ROOT / "Packaging/publish-nexus.ps1").read_text(encoding="utf-8")
    install_page = (ROOT / "admin-dashboard/src/features/auth/LandingPage.tsx").read_text(
        encoding="utf-8"
    )
    linux_install = (ROOT / "cross-platform-overlay/assets/install/INSTALL-LINUX.txt").read_text(
        encoding="utf-8"
    )
    nexus_guides = [
        (ROOT / "cross-platform-overlay/assets/install/INSTALL-WINDOWS-NEXUS.txt").read_text(encoding="utf-8"),
        (ROOT / "cross-platform-overlay/assets/install/INSTALL-LINUX-APPIMAGE-NEXUS.txt").read_text(encoding="utf-8"),
        (ROOT / "cross-platform-overlay/assets/install/INSTALL-LINUX-DEB-NEXUS.txt").read_text(encoding="utf-8"),
    ]
    linux_cli = (ROOT / "Packaging/linux/install.sh").read_text(encoding="utf-8")
    linux_helper = (ROOT / "cross-platform-overlay/main.js").read_text(encoding="utf-8")
    smoke = (ROOT / "Packaging/smoke-test.ps1").read_text(encoding="utf-8")
    package_downloads = (ROOT / "Packaging/package-downloads.ps1").read_text(encoding="utf-8")
    package_nexus = (ROOT / "Packaging/package-nexus-downloads.ps1").read_text(encoding="utf-8")
    package_portable = (ROOT / "Packaging/package-portable.ps1").read_text(encoding="utf-8")
    vt_gate = (ROOT / "Packaging/vt-gate.ps1").read_text(encoding="utf-8")

    required_nexus_markers = (
        "$hudGroup   = $env:NEXUS_MOD_FILE_ID_HUD",
        "$linuxDebGroup = $env:NEXUS_MOD_FILE_ID_LINUX_DEB",
        "NEXUS_MOD_FILE_ID_LINUX_DEB",
        "NEXUS_MOD_FILE_ID_HUD",
        "$hudVersion = (& $pythonCommand.Source $hudPackage --print-version).Trim()",
        '$hudZip   = Join-Path $DistDir "FCM HUD Mod-$hudVersion (PROD).zip"',
        '@{ Name = "HUD";',
        "NexusVersion = $hudVersion",
        'NexusVersion = $hudVersion; Category = "main"; ArchiveExisting = $true; Primary = $true',
        "FileCategory  = $p.Category",
        "ModFileId     = $p.Group",
        '$linuxDeb = Join-Path $DistDir "Fallout Chat Mod-$Version.deb"',
        '@{ Name = "Linux .deb";',
        "[switch]$PublishWindowsForReview",
        "$publishWindows = [bool]$PublishWindowsForReview",
        "if ($publishWindows)",
        '@{ Name = "Windows (support review)";',
        '@{ Name = "Windows portable (support review)";',
        'NEXUS_MOD_FILE_ID_WINDOWS_PORTABLE',
        'PrimaryDownload = $p.Primary',
        "ArchiveExisting = $false",
        "ArchiveExisting = $true",
        '[Parameter(Mandatory = $true)] [string]$BridgeZip',
        'package-nexus-downloads.ps1',
        'Fallout Chat Mod Portable $Version (Windows)-Nexus.zip',
        '"INSTALL-WINDOWS-NEXUS.txt"',
        '"INSTALL-LINUX-APPIMAGE-NEXUS.txt"',
        '"INSTALL-LINUX-DEB-NEXUS.txt"',
    )
    for marker in required_nexus_markers:
        assert marker in nexus, f"Nexus release path is missing: {marker}"
    assert 'Desc = ' not in nexus
    assert 'Description   = $p.Desc' not in nexus
    assert 'NexusVersion = $Version; Category = "main"; ArchiveExisting = $false; Primary = $false' in nexus

    # These scripts are documented for pwsh on Linux/macOS as well as Windows.
    # A backslash inside a Join-Path child path is a literal character on Unix,
    # so keep every multi-component path expressed as platform-neutral joins.
    for script_name, script in (("release.ps1", release), ("publish-nexus-release.ps1", nexus)):
        for line in script.splitlines():
            if "Join-Path" in line:
                assert not re.search(r'''Join-Path[^\r\n]*["'][^"']*\\[^"']*["']''', line), (
                    f"{script_name} contains a non-portable Join-Path child: {line.strip()}"
                )
    assert '$gameModsDir = Join-Path $repoRoot "game-mods"' in release
    assert '$fcmBridgeDir = Join-Path $gameModsDir "FCMBridge"' in release
    assert '$hudModDir  = Join-Path $fcmBridgeDir "hudmodloader-chat"' in release
    assert '$gameModsDir = Join-Path $repoRoot "game-mods"' in nexus
    assert '$fcmBridgeDir = Join-Path $gameModsDir "FCMBridge"' in nexus
    assert 'Join-Path $fcmBridgeDir "hudmodloader-chat"' in nexus
    assert '--distribution nexus --output $hudNexusZip' in nexus
    assert 'File = $hudNexusZip' in nexus

    for marker in (
        "[switch]$SkipWindowsNexus",
        "PublishWindowsForReview",
        "-PublishWindowsForReview",
        "-SkipWindowsNexus",
    ):
        assert marker in release, f"canonical release path is missing: {marker}"

    assert release.index("Nexus publish") < release.index("Register release")

    for marker in (
        "[bool]  $ArchiveExisting   = $false",
        "archive_existing_file        = $ArchiveExisting",
        "preserving previous file",
        'Normalize-ConfiguredValue',
        '$BaseUrl/mod-files/$ModFileId/versions',
        'Get-NexusExistingDescription',
        '[switch]$ValidateMetadataOnly',
        'description                  = $description',
        'primary_mod_manager_download = $PrimaryDownload',
        'Windows installers must remain in Main; ArchiveExisting cannot be true.',
    ):
        assert marker in nexus_uploader, f"Nexus uploader is missing safe archive guard: {marker}"

    # The HUD download must remain in the first install section, before the
    # platform-specific Windows section, so it is visible without scrolling.
    hud_marker = "VISIBLE IN-GAME HUD — OPTIONAL"
    assert hud_marker in install_page
    assert install_page.index(hud_marker) < install_page.index("GENERAL NOTES")
    assert "↓ FCM HUD Mod ZIP — {download.label} {hudModVersion}" in install_page
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
    manual_hud = (ROOT / "admin-dashboard/src/features/auth/HudManualInstall.tsx").read_text(encoding="utf-8")
    assert "<HudManualInstall" in install_page
    for marker in (
        "STEP 1 — PREPARE",
        "Data/FCMChatWidget.ba2",
        "Data/ZFE/TextChat/fragments/FCMChatWidget.ini",
        "Data/hudmodloader.ini",
        "Fallout76Custom.ini",
        "Data/configuration/zfe.ini",
        "[TextChat]",
        "fresh link code",
        "enabled=true",
        "sign in with Steam or Discord",
    ):
        assert marker in manual_hud, f"HUD install instructions are missing: {marker}"

    for source, label in (
        (install_page, "website Linux instructions"),
        (linux_install, "packaged Linux instructions"),
        (linux_cli, "CLI installer notes"),
        (linux_helper, "runtime Linux helper notes"),
    ):
        for marker in ("Hyprland", "hyprctl", "plain X11", "game-running fallback"):
            assert marker.lower() in source.lower(), f"{label} is missing Linux detection marker: {marker}"

    for marker in ("Download choices on the INSTALL page", "LINUX APPIMAGE", "LINUX .DEB", "LINUX ZIP + DOCS"):
        assert marker in linux_install, f"packaged Linux instructions are missing package choice: {marker}"

    for guide in nexus_guides:
        assert "Nexus Files tab" in guide
        assert "falloutchatmod.com" not in guide
        assert "discord.gg" not in guide
        assert "github.com" not in guide
    for forbidden in ("falloutchatmod.com (SYSTEM", "install.ps1", "install.sh", "official download page"):
        assert forbidden not in nexus, f"Nexus release copy contains off-site download direction: {forbidden}"

    for marker in (
        "Optional FCM Bridge",
        "Data/FCMServerBridge.ba2",
        "9ae03b9e047c5fea221d10a8c805b0fe07cfcadb79af9667c766a4c627b54e44",
        "Fallout Chat Mod Portable $Version (Windows)",
        "README-PORTABLE-NEXUS.txt",
    ):
        assert marker in package_nexus, f"Nexus package helper is missing: {marker}"
    assert '"-BridgeZip", $BridgeZip' in release
    for script in (package_downloads, package_nexus):
        assert "9c245bcad80b7baf1681d29273fda97008403a047bb941e00622a7210bb465af" in script
    for script in (package_downloads, package_nexus, package_portable):
        assert "'0.2.8'" not in script and "0.2.8 candidate" not in script
        assert "'0.2.9'" in script

    assert 'Fallout Chat Mod-$Version.AppImage' in smoke
    assert 'Get-ChildItem -Path $DistDir -Filter "*.AppImage"' not in smoke
    assert '$env:ELECTRON_RUN_AS_NODE = $null' in smoke
    for marker in ('[ValidateSet("Default", "Portable")]', 'Fallout Chat Mod Portable $Version.exe', 'FCMData\\logs'):
        assert marker in smoke, f"portable smoke gate is missing: {marker}"
    for marker in ('Fallout Chat Mod Portable $Version.zip', 'package-portable.ps1', '$expectedBridgeZipSha256', '[Parameter(Mandatory = $true)] [string]$BridgeZip'):
        assert marker in package_downloads, f"portable package path is missing: {marker}"
    assert '"-BridgeZip", $BridgeZip' in release
    for marker in ('portableDownloadUrl', 'portable VirusTotal GATE', 'Upload-Artifact $portableZip'):
        assert marker in release, f"portable release orchestration is missing: {marker}"
    assert '[switch]$SkipPermalinkUpdate' in vt_gate

    pwsh = shutil.which("pwsh")
    assert pwsh, "PowerShell is required to test Nexus metadata handling"
    subprocess.run([pwsh, "-NoProfile", "-File", str(ROOT / "Packaging/test-nexus-metadata.ps1")], check=True)

    # The merged Linux PR made cursor locking explicit/on-demand. Keep the
    # public page from regressing to the old silent Proton/Wine mutation claim.
    assert "The installer enables it for" not in install_page
    assert "never changes the FO76 Proton/Wine" in install_page

    print("release script contract tests passed")


if __name__ == "__main__":
    main()
