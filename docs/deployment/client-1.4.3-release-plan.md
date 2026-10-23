# Overlay 1.4.3 / HUD 2.10.151 release

Status: preparation in progress; not published. The owner approved the exact
16-line [public notes](next-release-notes.txt) and confirmed overlay **1.4.3**,
HUD **2.10.151** and Server Bridge **0.2.19** on 2026-10-23.

## Distribution

- Website: Windows installer and portable EXEs/ZIPs, Linux AppImage, `.deb` and
  ZIP, and the HUD ZIP. The optional bridge is bundled with overlay downloads.
- Nexus: Linux AppImage and `.deb` packages plus the executable-free HUD ZIP.
  Use `-SkipWindowsNexus`; preserve all existing Windows Nexus files.
- Discord: the normal combined release announcement, with direct website links
  for Windows installer, Windows portable, Linux AppImage, Linux `.deb`, Linux
  ZIP and HUD, plus the download page and Nexus endorsement field. All links
  must be checked before registration and read back after posting.

The owner authorized native GitHub-hosted Windows builds because the MSI signer
is offline. Use the release workflow's `runner=github-hosted` input. No game or
installed user overlay needs to be stopped for this release.

## Candidate and gates

Application/HUD source is the accepted Dev/Prod tree from production merge
`d7e471aafbff8148f2ec40bb20af68b6ac7b9172`. Release-tooling changes add the hosted
Windows option, signature/native launch receipts and current bridge packaging.
They require their own review and CI before promotion.

The pinned PROD bridge ZIP is identified in the
[release runbook](releasing-the-overlay.md). Preserve that exact ZIP; recompiling
the same source may change ZIP metadata and therefore the archive hash.

Required before any public artifact upload or release registration:

1. Passing exact-candidate CI, including source/package/Haxe and full Ruffle gates.
2. Signed Windows installer and portable artifacts with matching native launch
   receipts; passing Linux release smoke test.
3. Completed passing VirusTotal scans of both Windows executables.
4. Validated website/Nexus archives, PROD stamps and payload hashes, with no
   scripts/executables in the Nexus HUD package.
5. Website upload and served byte/hash verification, then selected Nexus uploads
   with preserved descriptions and previous Linux/HUD versions archived.
6. Combined release registration using the approved notes, followed by website,
   Discord download links, in-app version metadata and GitHub release readback.

Basic mixed HUD/xScal ↔ bridge/ZFE blue names were user-confirmed on the accepted
source. This release record does not claim that the exhaustive native matrix or
stationary availability was newly measured. It does not announce an emote fix.
