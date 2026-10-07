; QA updates stop only the QA application and retain its separate settings.
!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM "Fallout Chat Mod QA.exe" /T'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}
!macroend
