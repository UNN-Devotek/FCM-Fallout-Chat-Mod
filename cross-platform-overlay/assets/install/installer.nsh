; Custom NSIS hooks for Fallout Chat Mod installer.
; Included by electron-builder via nsis.include in package.json.

; Kill any running instance before files are overwritten. The two compact names
; are legacy product names used before v1.3.62 renamed the product to
; "Fallout Chat Mod". The legacy executable must be stopped before its old
; per-user install can be removed below.
; Uses nsExec (built-in NSIS) + taskkill — no extra plugins required.
; Without this, the installer races with the still-running tray process,
; causing file-lock errors and leaving a stale second instance alive after install.
!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM "Fallout Chat Mod.exe" /T'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}

  nsExec::ExecToStack 'taskkill /F /IM "Fallout ChatMod.exe" /T'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}

  nsExec::ExecToStack 'taskkill /F /IM "FalloutChatMod.exe" /T'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}

  ; v1.3.62 changed productName from "Fallout ChatMod" to
  ; "Fallout Chat Mod", which changed the default per-user install directory.
  ; Run only the exact legacy uninstaller if it exists. NSIS leaves the user's
  ; %APPDATA% settings alone, so the new install can keep the existing account.
  IfFileExists "$LOCALAPPDATA\Programs\Fallout ChatMod\Uninstall Fallout ChatMod.exe" 0 fcm_legacy_uninstall_done
    nsExec::ExecToStack '"$LOCALAPPDATA\Programs\Fallout ChatMod\Uninstall Fallout ChatMod.exe" /S'
    Pop $0
    Pop $1
    Sleep 1500
fcm_legacy_uninstall_done:
!macroend
