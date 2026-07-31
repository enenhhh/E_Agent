; E Agent Windows 原生安装/卸载体验扩展。
; 所有界面均使用 NSIS/MUI2 原生控件，不加载 HTML 或浏览器插件。

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

; 使用系统原生缩放与字体；高分辨率位图仅作为装饰，不承载文字或交互。
ManifestDPIAware true
SetFont /LANG=1033 "Segoe UI" 9
SetFont /LANG=2052 "Microsoft YaHei UI" 9

!define MUI_BGCOLOR "F8FAFC"
!define MUI_TEXTCOLOR "172033"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_HEADERIMAGE_BITMAP_STRETCH "FitControl"
!define MUI_HEADERIMAGE_UNBITMAP_STRETCH "FitControl"
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"

; 语言尚未选择时，仅语言选择器自身使用双语提示。
!define MUI_LANGDLL_WINDOWTITLE "E Agent · Language / 语言"
!define MUI_LANGDLL_INFO "Select setup language / 选择安装语言"

!ifdef BUILD_UNINSTALLER
  !define MUI_UNABORTWARNING
  !define MUI_UNABORTWARNING_TEXT "$(EAgentAbortWarning)"
  !define MUI_UNFINISHPAGE_NOAUTOCLOSE
!else
  !define MUI_ABORTWARNING
  !define MUI_ABORTWARNING_TEXT "$(EAgentAbortWarning)"
  !define MUI_LICENSEPAGE_CHECKBOX
!endif

!ifdef BUILD_UNINSTALLER
    LangString EAgentWindowCaption 1033 "Uninstall ${PRODUCT_NAME} ${VERSION}"
    LangString EAgentWindowCaption 2052 "卸载 ${PRODUCT_NAME} ${VERSION}"
    LangString EAgentAbortWarning 1033 "Exit uninstall? E Agent has not been removed yet."
    LangString EAgentAbortWarning 2052 "确定要退出卸载吗？E Agent 尚未被移除。"
    LangString EAgentWelcomeTitle 1033 "Uninstall E Agent ${VERSION}"
    LangString EAgentWelcomeTitle 2052 "卸载 E Agent ${VERSION}"
    LangString EAgentWelcomeText 1033 "This wizard safely removes E Agent. On the next page, choose whether conversations, settings, plugins, and encrypted credentials are kept or permanently removed."
    LangString EAgentWelcomeText 2052 "此向导将安全移除 E Agent。下一页可选择保留或永久删除会话、设置、插件和加密凭据。"
    LangString EAgentInstFinishedHeader 1033 "E Agent has been uninstalled"
    LangString EAgentInstFinishedHeader 2052 "E Agent 已卸载"
    LangString EAgentInstFinishedSubheader 1033 "The selected cleanup operation is complete."
    LangString EAgentInstFinishedSubheader 2052 "所选清理操作已完成。"
    LangString EAgentFinishTitle 1033 "Uninstall complete"
    LangString EAgentFinishTitle 2052 "卸载完成"
    LangString EAgentFinishText 1033 "E Agent has been removed. Preserved user data remains available for a future installation."
    LangString EAgentFinishText 2052 "E Agent 程序文件已从此设备移除。若选择保留用户数据，重新安装后仍可继续使用。"
    LangString EAgentDataHeader 1033 "Data and privacy"
    LangString EAgentDataHeader 2052 "数据与隐私"
    LangString EAgentDataSubheader 1033 "Choose whether local data is kept after uninstalling."
    LangString EAgentDataSubheader 2052 "选择卸载后是否保留本地数据。"
    LangString EAgentDataIntro 1033 "Keeping data lets a future installation reuse your configuration. Removed data cannot be recovered."
    LangString EAgentDataIntro 2052 "保留数据可在重新安装后继续使用原有配置；删除操作不可恢复。"
    LangString EAgentDataGroup 1033 "User data"
    LangString EAgentDataGroup 2052 "用户数据"
    LangString EAgentKeepData 1033 "Keep conversations, settings, plugins, and encrypted credentials (recommended)"
    LangString EAgentKeepData 2052 "保留会话、设置、插件和加密凭据（推荐）"
    LangString EAgentCandidateDirectories 1033 "E Agent data directories:"
    LangString EAgentCandidateDirectories 2052 "E Agent 数据候选目录："
    LangString EAgentDeleteHint 1033 "Clear the checkbox and click Uninstall to permanently remove this data after confirmation."
    LangString EAgentDeleteHint 2052 "取消勾选并点击“卸载”后，将在二次确认后永久删除上述数据。"
    LangString EAgentUninstallButton 1033 "Uninstall"
    LangString EAgentUninstallButton 2052 "卸载"
    LangString EAgentDeleteConfirm 1033 "Permanently remove local conversations, settings, plugins, and encrypted credentials? This cannot be undone."
    LangString EAgentDeleteConfirm 2052 "永久删除本地会话、设置、插件和加密凭据吗？此操作无法撤销。"
    LangString EAgentDeleteFailed 1033 "Some user data is in use and could not be removed. No deletion is scheduled for restart. Close related programs and remove the listed directories manually."
    LangString EAgentDeleteFailed 2052 "部分用户数据正在被其他程序占用，未能完全删除。卸载器不会安排重启后删除；请关闭相关程序后手动清理上述目录。"

    !define MUI_WELCOMEPAGE_TITLE_3LINES
    !define MUI_WELCOMEPAGE_TITLE "$(EAgentWelcomeTitle)"
    !define MUI_WELCOMEPAGE_TEXT "$(EAgentWelcomeText)"
    !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "$(EAgentInstFinishedHeader)"
    !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "$(EAgentInstFinishedSubheader)"
    !define MUI_FINISHPAGE_TITLE "$(EAgentFinishTitle)"
    !define MUI_FINISHPAGE_TEXT "$(EAgentFinishText)"
!else
    LangString EAgentWindowCaption 1033 "Install ${PRODUCT_NAME} ${VERSION}"
    LangString EAgentWindowCaption 2052 "安装 ${PRODUCT_NAME} ${VERSION}"
    LangString EAgentAbortWarning 1033 "Exit setup? Installation is not complete."
    LangString EAgentAbortWarning 2052 "确定要退出安装吗？当前安装尚未完成。"
    LangString EAgentWelcomeTitle 1033 "Welcome to E Agent ${VERSION}"
    LangString EAgentWelcomeTitle 2052 "欢迎安装 E Agent ${VERSION}"
    LangString EAgentWelcomeText 1033 "A local-first AI coding workspace with multi-model support, auditable tools, Skills, MCP, and reviewable file changes.$\r$\n$\r$\nSetup uses native Windows controls and will not launch the application automatically."
    LangString EAgentWelcomeText 2052 "面向开发者的本地优先 AI 编程工作台，支持多模型、可审计工具、Skill、MCP 与可审查的文件变更。$\r$\n$\r$\n安装使用 Windows 原生控件，完成后不会自动启动应用。"
    LangString EAgentLicenseTop 1033 "Review the terms and risk notice. You must accept them to continue."
    LangString EAgentLicenseTop 2052 "请完整阅读使用条款与风险告知。必须勾选接受后才能继续。"
    LangString EAgentLicenseCheckbox 1033 "I have read, understood and accept the terms above"
    LangString EAgentLicenseCheckbox 2052 "我已阅读、理解并接受上述条款"
    LangString EAgentDirectoryTop 1033 "Choose where E Agent is installed. To avoid overwriting existing files, setup appends an E Agent subfolder when a general folder is selected."
    LangString EAgentDirectoryTop 2052 "选择 E Agent 的安装位置。为避免覆盖现有资料，若选择普通文件夹，安装器会自动追加 E Agent 子目录。"
    LangString EAgentDirectoryDestination 1033 "Destination folder"
    LangString EAgentDirectoryDestination 2052 "安装目录"
    LangString EAgentInstFinishedHeader 1033 "E Agent has been installed"
    LangString EAgentInstFinishedHeader 2052 "E Agent 已安装"
    LangString EAgentInstFinishedSubheader 1033 "Application files and shortcuts are ready."
    LangString EAgentInstFinishedSubheader 2052 "程序文件与快捷方式已准备就绪。"
    LangString EAgentFinishTitle 1033 "E Agent is ready"
    LangString EAgentFinishTitle 2052 "E Agent 已准备就绪"
    LangString EAgentFinishText 1033 "Setup is complete. Launch E Agent later from the desktop or Start menu."
    LangString EAgentFinishText 2052 "安装已完成。关闭向导后可从桌面或开始菜单启动 E Agent。"

    !define MUI_WELCOMEPAGE_TITLE_3LINES
    !define MUI_WELCOMEPAGE_TITLE "$(EAgentWelcomeTitle)"
    !define MUI_WELCOMEPAGE_TEXT "$(EAgentWelcomeText)"
    !define MUI_LICENSEPAGE_TEXT_TOP "$(EAgentLicenseTop)"
    !define MUI_LICENSEPAGE_CHECKBOX_TEXT "$(EAgentLicenseCheckbox)"
    !define MUI_DIRECTORYPAGE_TEXT_TOP "$(EAgentDirectoryTop)"
    !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "$(EAgentDirectoryDestination)"
    !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "$(EAgentInstFinishedHeader)"
    !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "$(EAgentInstFinishedSubheader)"
    !define MUI_FINISHPAGE_TITLE "$(EAgentFinishTitle)"
    !define MUI_FINISHPAGE_TEXT "$(EAgentFinishText)"
!endif

!macro customHeader
  Caption "$(EAgentWindowCaption)"
  BrandingText "${PRODUCT_NAME} ${VERSION}"
!macroend

!ifndef BUILD_UNINSTALLER
  ; 自动更新不显示欢迎页，避免打断静默升级。
  !macro customWelcomePage
    !insertmacro skipPageIfUpdated
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  ; electron-builder 默认只检查完整路径中是否包含应用名，可能把程序安装到已有资料目录。
  ; 已注册的旧版安装路径必须原样保留；其他路径按末级目录名精确校验并追加应用子目录。
  !macro EAgentEnsureDedicatedInstallDirectory
    Push $0
    Push $R1
    Push $R2
    ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $INSTDIR != $R1
    ${AndIf} $INSTDIR != $R2
      ${GetFileName} "$INSTDIR" $0
      ${If} $0 != "${APP_FILENAME}"
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
    Pop $R2
    Pop $R1
    Pop $0
  !macroend

  !macro customPageAfterChangeDir
    Page custom EAgentNormalizeInstallDirectoryPage
    ; 函数必须延迟到 electron-builder 定义 INSTALL_REGISTRY_KEY 后再展开。
    Function EAgentNormalizeInstallDirectoryPage
      !insertmacro EAgentEnsureDedicatedInstallDirectory
      ; raw custom page 中的 Abort 只跳过无界面页面，不会中止安装。
      Abort
    FunctionEnd
  !macroend

  ; 静默模式不执行页面回调，因此在初始化阶段执行相同的目录边界保护。
  !macro customInit
    ${If} ${Silent}
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallerLanguage
      ${If} $0 != ""
        StrCpy $LANGUAGE $0
      ${EndIf}
      !insertmacro EAgentEnsureDedicatedInstallDirectory
    ${EndIf}
  !macroend

  ; 保存用户选择的界面语言，卸载器沿用相同语言。
  !macro customInstall
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallerLanguage" "$LANGUAGE"
  !macroend
!else
  Var EAgentUninstallOptionsDialog
  Var EAgentKeepUserDataCheckbox
  Var EAgentDeleteUserData
  Var EAgentUserDataDeleteFailed

  ; 使用原生欢迎页和原生数据保留选项页替代单独的确认弹窗。
  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.EAgentDataOptionsCreate un.EAgentDataOptionsLeave

    Function un.EAgentDataOptionsCreate
      !insertmacro MUI_HEADER_TEXT "$(EAgentDataHeader)" "$(EAgentDataSubheader)"
      nsDialogs::Create 1018
      Pop $EAgentUninstallOptionsDialog
      ${If} $EAgentUninstallOptionsDialog == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0u 0u 300u 28u "$(EAgentDataIntro)"
      Pop $0
      ${NSD_CreateGroupBox} 0u 34u 300u 94u "$(EAgentDataGroup)"
      Pop $0
      ${NSD_CreateCheckbox} 14u 52u 272u 20u "$(EAgentKeepData)"
      Pop $EAgentKeepUserDataCheckbox
      ${NSD_Check} $EAgentKeepUserDataCheckbox

      StrCpy $1 "$APPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        StrCpy $1 "$1$\r$\n$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        StrCpy $1 "$1$\r$\n$APPDATA\${APP_PACKAGE_NAME}"
      !endif
      ${NSD_CreateLabel} 14u 76u 272u 42u "$(EAgentCandidateDirectories)$\r$\n$1"
      Pop $0
      ${NSD_CreateLabel} 0u 132u 300u 36u "$(EAgentDeleteHint)"
      Pop $0

      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(EAgentUninstallButton)"
      nsDialogs::Show
    FunctionEnd

    Function un.EAgentDataOptionsLeave
      ${NSD_GetState} $EAgentKeepUserDataCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $EAgentDeleteUserData "0"
        Return
      ${EndIf}

      MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 "$(EAgentDeleteConfirm)" IDYES deleteConfirmed
      Abort
      deleteConfirmed:
      StrCpy $EAgentDeleteUserData "1"
    FunctionEnd
  !macroend

  ; 仅在用户于原生选项页主动选择并二次确认后清理精确的 Electron userData 目录。
  !macro customUnInstall
    ${IfNot} ${isUpdated}
    ${AndIf} $EAgentDeleteUserData == "1"
      SetShellVarContext current
      StrCpy $EAgentUserDataDeleteFailed "0"
      DetailPrint "Removing E Agent user data selected by the user..."
      RMDir /r "$APPDATA\${APP_FILENAME}"
      IfFileExists "$APPDATA\${APP_FILENAME}\*.*" 0 appFilenameDataRemoved
      StrCpy $EAgentUserDataDeleteFailed "1"
      appFilenameDataRemoved:
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        IfFileExists "$APPDATA\${APP_PRODUCT_FILENAME}\*.*" 0 productFilenameDataRemoved
        StrCpy $EAgentUserDataDeleteFailed "1"
        productFilenameDataRemoved:
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        IfFileExists "$APPDATA\${APP_PACKAGE_NAME}\*.*" 0 packageNameDataRemoved
        StrCpy $EAgentUserDataDeleteFailed "1"
        packageNameDataRemoved:
      !endif
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      ${If} $EAgentUserDataDeleteFailed == "1"
        MessageBox MB_ICONEXCLAMATION|MB_OK "$(EAgentDeleteFailed)"
      ${EndIf}
    ${EndIf}
  !macroend

  ; 静默升级和内部提权实例保持默认保留；命令行 --delete-app-data 仍由 electron-builder 处理。
  !macro customUnInit
    StrCpy $EAgentDeleteUserData "0"
    StrCpy $EAgentUserDataDeleteFailed "0"
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallerLanguage
    ${If} $0 != ""
      StrCpy $LANGUAGE $0
    ${EndIf}
  !macroend
!endif
