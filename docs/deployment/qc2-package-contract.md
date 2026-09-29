# Quick Configuration 2 package contract

The [UNN-Devotek Quick Configuration 2 fork](https://github.com/UNN-Devotek/QuickConfiguration2)
imports production FCM ZIPs through its normal **Mods > Install mod** and drag-and-drop flow.
It selects the installed ZFE or xScal provider for the visible HUD, or asks which provider to
download when neither is present. It offers HUDModLoader when missing. Importing the optional
Server Bridge from a desktop ZIP is a separate choice; the visible HUD and bridge cannot be
installed together. The base Quick Configuration 2 and NukaMods require extracting the ZIP
and importing only the selected BA2, followed by manual INI merges.

## Stable inputs

Keep these paths and metadata stable across ordinary version updates. `Packaging/qc2-package-contract.py`
checks the finished production archives and is called by both website and Nexus packagers.
The fork's parser is `QuickConfiguration2/src-tauri/src/commands/fcm/import.rs` in the sibling
repository. Update both sides and their tests before intentionally changing this contract.

| Package | Required paths and metadata |
| --- | --- |
| HUD ZIP | Root `README.txt`; `ZFE (Install for ZFE only)/` and `xScal (Install for xScal only)/`. Each has `INSTALL.txt` with `PRODUCTION` and the semantic version on its first line, `Fallout76Custom.ini`, and `Data (drag the contents into data folder)/` with `FCMChatWidget.ba2`, `FCMChat.ini`, and `hudmodloader.ini`. Each `FCMChat.ini` must contain exactly one `xscalInputMode=native`. The ZFE Data folder has `ZFE/TextChat/fragments/FCMChatWidget.ini`; the xScal folder has `xscal.ini` at its provider root. Both BA2s must be identical, begin with `BTDX`, and contain the stated version. |
| Standalone bridge ZIP | `BUILD.json` with semantic `version`, `target: "prod"`, and `ba2Sha256`; `Data/FCMServerBridge.ba2` must begin with `BTDX` and match that SHA-256. The manual guide and loader fragment remain part of the human package. |
| Desktop overlay ZIP | Exactly one `Optional FCM Bridge/BUILD.json` and matching `Data/FCMServerBridge.ba2` under that folder, possibly inside one portable wrapper folder. The bridge must satisfy the standalone bridge metadata checks. The overlay never installs it by default. |

The importer obtains the HUD version from the selected production `INSTALL.txt` (or the BA2
for an extracted single-provider folder). It obtains the bridge version from `BUILD.json` and
checks its BA2 hash. Thus a new **version** with the same shape needs no importer change. The
desktop release version does not determine the HUD or bridge version. Provider and HUDModLoader
downloads are separate prerequisites and depend on their official Nexus packages being
available; the ZIP does not bundle them.

## INI and ownership rules

- The package INIs are merge inputs, not replacements for existing user files. Preserve custom
  `FCMChat.ini` values, unrelated `hudmodloader.ini` lines, archive entries, and provider settings.
- Treat an existing `FCMChatWidget` or `FCMServerBridge` loader line as already registered.
  A future HUDModLoader default list may include either line. Keep exactly one selected FCM
  loader entry and one selected BA2 in the active `Fallout76Custom.ini` archive list. The HUD
  packager also filters both FCM names out of its copied defaults before adding one widget entry.
- Install only the chosen provider's settings. ZFE uses its FCM fragment; xScal merges its
  `[Chat]` values. The Server Bridge does not change provider chat settings.
- An update, repeat import, switch, or removal must use the fork's preview, backup, and normal
  mod removal path. Re-read current INIs before targeted writes so a delayed app save cannot
  replace a newer game or user edit. Roll back all touched files on failure.

## Release gate and compatibility review

1. Build the production HUD ZIP and bridge ZIP. `package-downloads.ps1` validates the HUD,
   bridge, and website overlay ZIPs. `publish-nexus-release.ps1` validates the distinct Nexus
   HUD and overlay ZIPs before its publish gate. The standalone validator can be run as
   `python3 Packaging/qc2-package-contract.py --hud HUD.zip --bridge BRIDGE.zip --overlay OVERLAY.zip`.
2. Run the FCM package tests and QC2 contract tests in CI. For any HUD/bridge source or package
   change, run the full Haxe/source/package and Ruffle simulator gates required by
   [the HUD automation plan](../testing/hud-automation-plan.md). A ZIP layout or metadata
   change requires a matching QC2 importer change and fixture tests for both providers, repeat
   imports, switching, removal, failed downloads, rollback, and existing loader lines.
3. Review the bridge ZIP and BA2 hashes locked by `Packaging/package-downloads.ps1` and
   `Packaging/package-nexus-downloads.ps1` whenever publishing a new bridge. Update the pins
   only after validating the production package. Compare the embedded bridge hash in every
   outer ZIP with the approved standalone bridge.
4. Before a supported release, import the final production ZIP into a disposable game profile
   through the fork. Check one BA2, one loader line, one archive entry, provider settings,
   customized INI preservation, and normal removal. Test the Windows build on the gaming PC
   and compare files before/after game launch. Restore the profile snapshot afterward.

The validator catches ZIP structure, version stamps, and bridge integrity. CI and fixture tests
catch importer behavior. Native game and third-party provider changes still need the bounded
manual checks above; no static contract can guarantee every future game or provider update.
