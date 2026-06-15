; Custom NSIS hooks for Fallout Chat Mod installer.
; Included by electron-builder via nsis.include in package.json.

; Kill any running instance before files are overwritten.
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
!macroend
