# FCM HUD Mod 2.10.85

HUD-only release. Desktop overlay versions and Nexus downloads are unchanged.

- Removed the white flash that could appear whenever chat refreshed. Feed rows are now assembled
  in a hidden snapshot and shown only after the complete layout is ready.
- Reduced message-refresh microstutters. Large histories are rebuilt in six-row slices instead of
  32-row frame-blocking batches, based on Windows 10 xScal timing evidence.
- Fixed the one-letter input problem. The shared editor now preserves normal selection and caret
  behavior so typed characters form complete words.
- Fixed lost sends and stuck Insert input after HUDModLoader dropped its final editor callback.
  Enter submissions recover once after a short grace period; other lost-focus sessions cancel and
  allow Insert to open chat again.
- Restored Delete as the default idle hide key. Delete edits characters while the input box is open
  and hides the HUD only after the editor closes.
- Reset the shipped controls to Insert for chat, Page Up/Down for channels, Arrow Up/Down for feed
  scrolling while typing, and Delete for idle hide.
- One unified HUD file supports both xScal and ZFE. Provider-specific discovery, configuration,
  input fallback, and key behavior are documented in the included guides.

Installation: exit Fallout 76, replace the HUD file, and follow the included instructions for the
selected extender. xScal users enable `[Chat] enabled=true`; ZFE users keep the effective
`OpenChatKey` aligned with `Data/FCMChat.ini` `openKey`. Restart Fallout 76 after replacing the BA2
or changing extender configuration.

Please test Insert → type a full word → Delete → Enter → Insert again. Delete should edit while the
input is open and hide the HUD only while idle. Report remaining stutters with Windows version,
extender/version, HUD version, retained message count, and the provider log.

Scope: no desktop overlay installer, portable executable, AppImage, `.deb`, desktop version, or
desktop download is replaced by this HUD-only release.

Discord announcement setting: use `releaseTarget: "hud"` and
`suppressNotifications: true`. This keeps the visible HUD Mod update-role mention
while suppressing push notifications; release notices never use `@everyone`.
