# HUD 2.10.121 XSCAL-SHAREDHUDTOOLS-ROLLBACK Native Acceptance

This private build is native-unverified. Install it manually in a disposable test setup only. Do
not replace the production HUD, publish the archive, or register it as a release. Back up the
existing `Data/FCMChat.ini`, `Data/FCMChatWidget.ba2`, and provider configuration first.

## Test setup

- Record Fallout 76 build, controller model, Steam Input state, provider name/version, and the
  complete `[Keybinds]` section from `Data/FCMChat.ini`.
- Test one provider at a time. Never coinstall ZFE and xScal provider fragments.
- Run the default profile, then a rotated profile that changes every non-empty action key.
- Include at least one intentionally overlapping binding and record which action wins.

## ZFE acceptance (current input.v1 + hotkeys.v1 build)

With the controller connected and active, verify every configured action: open, hide, next/previous
channel, scroll up/down, scroll bottom, and activate link. Hold each action once and confirm it fires
on one down-edge rather than repeating. Open the editor and verify normal typing, Backspace, Delete,
Enter submit, and Escape cancel. Repeat after opening/closing a game modal, fast travel, UI reload,
and HUD shutdown/reload.

Pass only if the final text/revision belongs to the active input session, submit/cancel occurs once,
held keys do not repeat, stale callbacks do not act on the new editor, controller gameplay resumes
after close, and Enter/Escape do not activate an underlying game action.

## xScal 0.2.16 acceptance

With the controller connected and active, verify every supported configured action in both profiles,
including held-key edge behavior and overlap precedence. Repeat after modal interruption, fast travel,
UI reload, and HUD shutdown/reload. Confirm controller gameplay resumes after the editor closes.

Record SharedHUDTools typing, Backspace/Delete, Enter, and Escape separately as observed behavior.
xScal 0.2.16 documents key registration/polling and controller-button suppression, but no keyboard
capture or keyboard-suppression API; a text-edit failure is therefore an upstream limitation, not a
claim of parity. Attach `fcm.log` diagnostics for editor startup, callback delivery, and recovery.

## Desktop overlay checklist (no overlay source changes in this build)

With the controller connected, verify each configured overlay shortcut, including open/customize,
hide, channel navigation, scrolling, bottom, and link activation. In the renderer editor, verify
typing, Backspace, Delete, Enter, and Escape. Record Steam Input state and any game action that also
fires. This checklist does not authorize changing, stopping, installing, or restarting either desktop
overlay.

## Rollback

Remove the test `Data/FCMChatWidget.ba2`, restore the backed-up HUD/config files, and restore the prior
single-provider fragment. A rollback must not touch either desktop overlay or the Fallout 76 process.
