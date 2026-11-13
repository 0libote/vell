; Native fonts scale with Windows DPI. Do not bake lettering into installer BMPs.
SetFont "Segoe UI" 10

Var VellSmallFont
Var VellWordmarkFont
Var VellTaglineFont
Var VellTitleFont

!macro VellCreateFont HANDLE POINTS WEIGHT FACE
  Push $0
  Push $1
  Push $2
  System::Call 'user32::GetDC(p $HWNDPARENT) p .r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i .r1'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  System::Call 'kernel32::MulDiv(i ${POINTS}, i r1, i 72) i .r2'
  IntOp $2 0 - $2
  ; Grayscale antialiasing stays clean on the transparent dark-panel labels.
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 4, i 0, w "${FACE}") p .r0'
  StrCpy ${HANDLE} $0
  ${If} ${HANDLE} == 0
    CreateFont ${HANDLE} "${FACE}" ${POINTS} ${WEIGHT}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro VellSidebarLabel COLOR FONT
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${NSD_AddExStyle} $0 ${WS_EX_TRANSPARENT}
  SetCtlColors $0 "${COLOR}" transparent
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  ; A bitmap otherwise covers later nsDialogs labels in the sibling Z order.
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

!macro VellSidebarText
  ; Cache handles across Back/Next navigation; the setup process owns them.
  ${If} $VellSmallFont == ""
    !insertmacro VellCreateFont $VellSmallFont 10 400 "Segoe UI"
    !insertmacro VellCreateFont $VellWordmarkFont 21 600 "Segoe UI Semibold"
    !insertmacro VellCreateFont $VellTaglineFont 11 400 "Segoe UI"
    !insertmacro VellCreateFont $VellTitleFont 14 700 "Segoe UI"
  ${EndIf}

  ${NSD_CreateLabel} 5u 11u 99u 12u "FOR WINDOWS"
  Pop $0
  !insertmacro VellSidebarLabel "A9C5B7" $VellSmallFont

  ${NSD_CreateLabel} 5u 96u 99u 24u "Vell"
  Pop $0
  !insertmacro VellSidebarLabel "F1F7F4" $VellWordmarkFont

  ${NSD_CreateLabel} 5u 124u 99u 30u "Your voice.$\r$\nIn writing."
  Pop $0
  !insertmacro VellSidebarLabel "C3D8CD" $VellTaglineFont

  ${NSD_CreateLabel} 5u 172u 99u 12u "Private by design"
  Pop $0
  !insertmacro VellSidebarLabel "A9C5B7" $VellSmallFont
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW VellWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "Your voice, ready anywhere"
  !define MUI_WELCOMEPAGE_TEXT "Set up Vell, a private dictation workspace built for Windows.$\r$\n$\r$\nPress Ctrl+Shift+Space in any app to speak. Your words are transcribed locally and pasted where you were working.$\r$\n$\r$\nNo account. No telemetry. No API key."
  !insertmacro MUI_PAGE_WELCOME

  Function VellWelcomeShow
    !insertmacro VellSidebarText
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $VellTitleFont 1
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $VellSmallFont 1
  FunctionEnd
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "Vell is ready"
  !define MUI_FINISHPAGE_TEXT "Press Ctrl+Shift+Space to dictate in any app.$\r$\n$\r$\nChoose your microphone and speech engine in Settings."
  !define MUI_FINISHPAGE_TEXT_LARGE

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW VellFinishShow

  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Vell"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH

  ; Keep the credit below the launch option, including on the reboot page.
  Function VellFinishShow
    !insertmacro VellSidebarText
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $VellTitleFont 1
    SendMessage $mui.FinishPage.Text ${WM_SETFONT} $VellSmallFont 1
    SendMessage $mui.FinishPage.Run ${WM_SETFONT} $VellSmallFont 1
    ${NSD_CreateLabel} 120u 158u 195u 12u "Made by Sounak"
    Pop $0
    SetCtlColors $0 "5E726A" "${MUI_BGCOLOR}"
    SendMessage $0 ${WM_SETFONT} $VellSmallFont 1
  FunctionEnd
!macroend

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VellWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "Remove Vell"
  !define MUI_WELCOMEPAGE_TEXT "This will remove the Vell app from your computer.$\r$\n$\r$\nYour dictation history and local preferences are kept on this PC. You can remove them separately from Vell's data folder."
  !insertmacro MUI_UNPAGE_WELCOME

  Function un.VellWelcomeShow
    !insertmacro VellSidebarText
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $VellTitleFont 1
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $VellSmallFont 1
  FunctionEnd
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VellFinishShow
  !insertmacro MUI_UNPAGE_FINISH

  Function un.VellFinishShow
    !insertmacro VellSidebarText
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $VellTitleFont 1
    SendMessage $mui.FinishPage.Text ${WM_SETFONT} $VellSmallFont 1
  FunctionEnd
!macroend
