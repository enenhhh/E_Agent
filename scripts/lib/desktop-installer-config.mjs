import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isPathInside, workspaceRoot } from './workspace.mjs';

const PRODUCT_PACKAGE_PATHS = [
  'package.json',
  'apps/desktop/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
];
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

async function readJson(relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `无法读取安装器配置依赖 ${relativePath}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function requireCondition(condition, message, failures) {
  if (!condition) failures.push(message);
}

function resolveDesktopResource(relativePath, label, failures) {
  const desktopDirectory = path.join(workspaceRoot, 'apps', 'desktop');
  if (
    typeof relativePath !== 'string' ||
    relativePath.trim() === '' ||
    path.isAbsolute(relativePath)
  ) {
    failures.push(`${label} 必须是 apps/desktop 内的安全相对路径。`);
    return undefined;
  }
  const resourcePath = path.resolve(desktopDirectory, relativePath);
  if (!isPathInside(desktopDirectory, resourcePath)) {
    failures.push(`${label} 不能离开 apps/desktop：${relativePath}`);
    return undefined;
  }
  return resourcePath;
}

async function readRequiredResource(resourcePath, label, failures) {
  if (resourcePath === undefined) return '';
  try {
    return await readFile(resourcePath, 'utf8');
  } catch (error) {
    failures.push(
      `${label} 不存在或不可读：${resourcePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
    return '';
  }
}

async function readRequiredBinaryResource(resourcePath, label, failures) {
  if (resourcePath === undefined) return Buffer.alloc(0);
  try {
    return await readFile(resourcePath);
  } catch (error) {
    failures.push(
      `${label} 不存在或不可读：${resourcePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
    return Buffer.alloc(0);
  }
}

function validateNativeBitmap(contents, width, height, label, failures) {
  const hasHeader = contents.length >= 54 && contents.subarray(0, 2).toString('ascii') === 'BM';
  requireCondition(hasHeader, `${label} 必须是有效的原生 BMP 文件。`, failures);
  if (!hasHeader) return;
  requireCondition(contents.readUInt32LE(14) >= 40, `${label} 的 DIB header 无效。`, failures);
  requireCondition(
    contents.readInt32LE(18) === width,
    `${label} 宽度必须是 ${width}px。`,
    failures,
  );
  requireCondition(
    Math.abs(contents.readInt32LE(22)) === height,
    `${label} 高度必须是 ${height}px。`,
    failures,
  );
  requireCondition(contents.readUInt16LE(26) === 1, `${label} 的颜色平面必须为 1。`, failures);
  requireCondition(contents.readUInt16LE(28) === 24, `${label} 必须使用 24 位颜色。`, failures);
  requireCondition(contents.readUInt32LE(30) === 0, `${label} 必须是未压缩 BMP。`, failures);
}

function validateMultiResolutionIcon(contents, label, failures) {
  const hasHeader =
    contents.length >= 6 && contents.readUInt16LE(0) === 0 && contents.readUInt16LE(2) === 1;
  requireCondition(hasHeader, `${label} 必须是有效的 ICO 文件。`, failures);
  if (!hasHeader) return;
  const count = contents.readUInt16LE(4);
  requireCondition(contents.length >= 6 + count * 16, `${label} 的目录结构不完整。`, failures);
  if (contents.length < 6 + count * 16) return;
  const sizes = new Set(
    Array.from({ length: count }, (_, index) => {
      const encodedSize = contents[6 + index * 16];
      return encodedSize === 0 ? 256 : encodedSize;
    }),
  );
  for (const requiredSize of [16, 24, 32, 48, 64, 128, 256]) {
    requireCondition(sizes.has(requiredSize), `${label} 缺少 ${requiredSize}px 图层。`, failures);
  }
}

/**
 * 校验产品版本与 Windows assisted installer 的安全交互契约。
 *
 * @returns {Promise<{ version: string; desktopPackage: Record<string, unknown> }>}
 */
export async function validateDesktopInstallerConfig() {
  const failures = [];
  const packageEntries = await Promise.all(
    PRODUCT_PACKAGE_PATHS.map(async (relativePath) => ({
      relativePath,
      packageJson: await readJson(relativePath),
    })),
  );
  const rootVersion = packageEntries[0]?.packageJson?.version;
  requireCondition(
    typeof rootVersion === 'string' && SEMVER_PATTERN.test(rootVersion),
    `根 package.json 版本不是有效 SemVer：${String(rootVersion)}`,
    failures,
  );
  for (const entry of packageEntries.slice(1)) {
    requireCondition(
      entry.packageJson.version === rootVersion,
      `产品版本不一致：${entry.relativePath}=${String(entry.packageJson.version)}，根版本=${String(rootVersion)}`,
      failures,
    );
  }

  const desktopPackage = packageEntries[1]?.packageJson ?? {};
  const build = desktopPackage.build ?? {};
  const windowsTargets = Array.isArray(build.win?.target)
    ? build.win.target
    : build.win?.target === undefined
      ? []
      : [build.win.target];
  requireCondition(windowsTargets.includes('nsis'), 'Windows target 必须包含 nsis。', failures);

  const nsis = build.nsis ?? {};
  requireCondition(
    nsis.oneClick === false,
    'NSIS 必须使用 assisted 模式（oneClick=false）。',
    failures,
  );
  requireCondition(
    nsis.allowToChangeInstallationDirectory === true,
    'NSIS 必须允许用户修改安装目录。',
    failures,
  );
  requireCondition(
    nsis.perMachine === false,
    'NSIS 必须允许选择当前用户或所有用户安装。',
    failures,
  );
  requireCondition(
    nsis.selectPerMachineByDefault === false,
    'NSIS 默认应选择当前用户安装，避免无意请求管理员权限。',
    failures,
  );
  requireCondition(nsis.allowElevation === true, 'NSIS 应允许用户主动选择提权安装。', failures);
  requireCondition(
    nsis.removeDefaultUninstallWelcomePage === false,
    '原生卸载欢迎页与数据保留选项启用时不得移除卸载欢迎流程。',
    failures,
  );
  requireCondition(
    nsis.deleteAppDataOnUninstall === false,
    '普通卸载必须默认保留本地数据与加密凭据。',
    failures,
  );
  requireCondition(nsis.runAfterFinish === false, '安装完成后不得未经确认自动启动应用。', failures);
  requireCondition(nsis.warningsAsErrors === true, 'NSIS 编译警告必须作为错误处理。', failures);
  requireCondition(nsis.createDesktopShortcut === true, '安装器应创建桌面快捷方式。', failures);
  requireCondition(
    nsis.createStartMenuShortcut === true,
    '安装器应创建开始菜单快捷方式。',
    failures,
  );
  requireCondition(
    nsis.uninstallDisplayName === '${productName} ${version}',
    '卸载列表名称必须包含产品名称与版本。',
    failures,
  );
  requireCondition(
    nsis.artifactName === '${productName}-Setup-${version}-${arch}.${ext}',
    'Windows 安装包名称必须包含 Setup、版本和架构。',
    failures,
  );
  requireCondition(
    JSON.stringify(nsis.installerLanguages) === JSON.stringify(['en_US', 'zh_CN']),
    '安装器语言必须明确包含 en_US 与 zh_CN。',
    failures,
  );
  requireCondition(
    nsis.displayLanguageSelector === true,
    '安装器必须先显示原生语言选择器。',
    failures,
  );
  requireCondition(
    nsis.license === undefined,
    '不得配置单一免责条款；应由 license_en.txt 与 license_zh_CN.txt 跟随所选语言。',
    failures,
  );
  requireCondition(
    nsis.installerHeader === 'build/installer-header.bmp',
    '安装器必须使用品牌化原生 header BMP。',
    failures,
  );
  requireCondition(
    nsis.installerSidebar === 'build/installer-sidebar.bmp',
    '安装器必须使用品牌化原生 sidebar BMP。',
    failures,
  );
  requireCondition(
    nsis.uninstallerSidebar === 'build/uninstaller-sidebar.bmp',
    '卸载器必须使用独立的品牌化原生 sidebar BMP。',
    failures,
  );

  const englishLicensePath = resolveDesktopResource(
    'build/license_en.txt',
    'English NSIS license',
    failures,
  );
  const chineseLicensePath = resolveDesktopResource(
    'build/license_zh_CN.txt',
    'Chinese NSIS license',
    failures,
  );
  const includePath = resolveDesktopResource(nsis.include, 'NSIS include', failures);
  const installerHeaderPath = resolveDesktopResource(
    nsis.installerHeader,
    'NSIS installer header',
    failures,
  );
  const installerSidebarPath = resolveDesktopResource(
    nsis.installerSidebar,
    'NSIS installer sidebar',
    failures,
  );
  const uninstallerSidebarPath = resolveDesktopResource(
    nsis.uninstallerSidebar,
    'NSIS uninstaller sidebar',
    failures,
  );
  const installerIconPath = resolveDesktopResource(
    nsis.installerIcon,
    'NSIS installer icon',
    failures,
  );
  const [englishLicenseBytes, chineseLicenseBytes] = await Promise.all([
    readRequiredBinaryResource(englishLicensePath, '英文免责声明', failures),
    readRequiredBinaryResource(chineseLicensePath, '中文免责声明', failures),
  ]);
  const englishLicense = englishLicenseBytes.toString('utf8').replace(/^\uFEFF/u, '');
  const chineseLicense = chineseLicenseBytes.toString('utf8').replace(/^\uFEFF/u, '');
  const includeContents = await readRequiredResource(includePath, '安装器扩展脚本', failures);
  const [installerHeader, installerSidebar, uninstallerSidebar, installerIcon] = await Promise.all([
    readRequiredBinaryResource(installerHeaderPath, '安装器 header', failures),
    readRequiredBinaryResource(installerSidebarPath, '安装器 sidebar', failures),
    readRequiredBinaryResource(uninstallerSidebarPath, '卸载器 sidebar', failures),
    readRequiredBinaryResource(installerIconPath, '安装器图标', failures),
  ]);

  for (const [label, contents] of [
    ['英文免责声明', englishLicenseBytes],
    ['中文免责声明', chineseLicenseBytes],
  ]) {
    requireCondition(
      contents.length >= 3 && contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf,
      `${label}必须带 UTF-8 BOM，确保原生 NSIS 控件正确显示。`,
      failures,
    );
  }
  validateNativeBitmap(installerHeader, 450, 171, '安装器 3x header', failures);
  validateNativeBitmap(installerSidebar, 492, 942, '安装器 3x sidebar', failures);
  validateNativeBitmap(uninstallerSidebar, 492, 942, '卸载器 3x sidebar', failures);
  validateMultiResolutionIcon(installerIcon, '安装器高 DPI 图标', failures);

  for (const marker of [
    `E Agent ${String(rootVersion)}`,
    'AI 输出需要人工复核',
    '文件、命令与浏览器工具',
    '第三方模型、数据与费用',
    '普通卸载默认保留',
  ]) {
    requireCondition(
      chineseLicense.includes(marker),
      `中文免责声明缺少必要内容：${marker}`,
      failures,
    );
  }
  for (const marker of [
    `E Agent ${String(rootVersion)}`,
    'Human review is required',
    'Third-party models, data, and charges',
    'normal uninstall keeps',
  ]) {
    requireCondition(
      englishLicense.includes(marker),
      `英文免责声明缺少必要内容：${marker}`,
      failures,
    );
  }
  requireCondition(
    !/[\u3400-\u9fff]/u.test(englishLicense),
    '英文免责声明不得混入中文正文。',
    failures,
  );
  for (const [label, licenseContents] of [
    ['英文免责声明', englishLicense],
    ['中文免责声明', chineseLicense],
  ]) {
    requireCondition(
      !/<(?:!doctype|html|head|body|script|iframe)\b/iu.test(licenseContents),
      `${label}必须是纯文本，禁止 HTML 文档或可执行标签。`,
      failures,
    );
    requireCondition(
      !/https?:\/\//iu.test(licenseContents),
      `${label}必须可完全离线显示，禁止远程 URL。`,
      failures,
    );
  }

  for (const marker of [
    'ManifestDPIAware true',
    'SetFont /LANG=1033 "Segoe UI" 9',
    'SetFont /LANG=2052 "Microsoft YaHei UI" 9',
    '!define MUI_BGCOLOR',
    '!define MUI_TEXTCOLOR',
    '!define MUI_HEADERIMAGE_BITMAP_STRETCH "FitControl"',
    '!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"',
    '!define MUI_LANGDLL_WINDOWTITLE',
    '!define MUI_LANGDLL_INFO',
    'LangString EAgentWelcomeTitle 1033',
    'LangString EAgentWelcomeTitle 2052',
    'LangString EAgentDeleteConfirm 1033',
    'LangString EAgentDeleteConfirm 2052',
    '!define MUI_WELCOMEPAGE_TITLE',
    '!define MUI_WELCOMEPAGE_TEXT',
    '!define MUI_LICENSEPAGE_TEXT_TOP',
    '!define MUI_LICENSEPAGE_CHECKBOX',
    '!define MUI_LICENSEPAGE_CHECKBOX_TEXT',
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    '!include nsDialogs.nsh',
    '!macro customHeader',
    '!macro customWelcomePage',
    '!insertmacro skipPageIfUpdated',
    '!insertmacro MUI_PAGE_WELCOME',
    '!macro EAgentEnsureDedicatedInstallDirectory',
    'ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
    'ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '${If} $INSTDIR != $R1',
    '${AndIf} $INSTDIR != $R2',
    '${GetFileName} "$INSTDIR" $0',
    '${If} $0 != "${APP_FILENAME}"',
    'StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"',
    '!macro customPageAfterChangeDir',
    'Page custom EAgentNormalizeInstallDirectoryPage',
    'Function EAgentNormalizeInstallDirectoryPage',
    '!macro customInit',
    '${If} ${Silent}',
    '!macro customInstall',
    'WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallerLanguage" "$LANGUAGE"',
    '!macro customUnWelcomePage',
    '!insertmacro MUI_UNPAGE_WELCOME',
    'UninstPage custom un.EAgentDataOptionsCreate un.EAgentDataOptionsLeave',
    '${NSD_Check} $EAgentKeepUserDataCheckbox',
    'Function un.EAgentDataOptionsLeave',
    'MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2',
    'StrCpy $EAgentDeleteUserData "1"',
    '!macro customUnInstall',
    '!macro customUnInit',
    '${IfNot} ${isUpdated}',
    '${AndIf} $EAgentDeleteUserData == "1"',
    'SetShellVarContext current',
    'IfFileExists "$APPDATA\\${APP_FILENAME}\\*.*" 0 appFilenameDataRemoved',
    'StrCpy $EAgentUserDataDeleteFailed "1"',
    'MessageBox MB_ICONEXCLAMATION|MB_OK',
    'StrCpy $EAgentDeleteUserData "0"',
    'ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallerLanguage',
    'StrCpy $LANGUAGE $0',
    'Abort',
  ]) {
    requireCondition(
      includeContents.includes(marker),
      `安装器扩展脚本缺少保护：${marker}`,
      failures,
    );
  }
  const customHeaderIndex = includeContents.indexOf('!macro customHeader');
  for (const pageDefine of [
    '!define MUI_WELCOMEPAGE_TITLE ',
    '!define MUI_WELCOMEPAGE_TEXT ',
    '!define MUI_LICENSEPAGE_TEXT_TOP ',
    '!define MUI_LICENSEPAGE_CHECKBOX_TEXT ',
    '!define MUI_DIRECTORYPAGE_TEXT_TOP ',
    '!define MUI_DIRECTORYPAGE_TEXT_DESTINATION ',
    '!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT ',
    '!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT ',
    '!define MUI_FINISHPAGE_TITLE ',
    '!define MUI_FINISHPAGE_TEXT ',
  ]) {
    const defineIndex = includeContents.indexOf(pageDefine);
    requireCondition(
      defineIndex >= 0 && defineIndex < customHeaderIndex,
      `${pageDefine.trim()} 必须在 customHeader 之前的顶层声明，确保 MUI 页面展开时生效。`,
      failures,
    );
  }
  const customHeaderBody =
    includeContents.match(/!macro customHeader\b([\s\S]*?)!macroend/u)?.[1] ?? '';
  requireCondition(
    !/!define\s+MUI_(?:WELCOME|LICENSE|DIRECTORY|INSTFILES|FINISH)/u.test(customHeaderBody),
    'customHeader 在 MUI 页面展开后才执行，不得在其中定义页面文案。',
    failures,
  );
  const customInitBody =
    includeContents.match(/!macro customInit\b([\s\S]*?)!macroend/u)?.[1] ?? '';
  requireCondition(
    customInitBody.includes(
      'ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallerLanguage',
    ) && customInitBody.includes('StrCpy $LANGUAGE $0'),
    '静默安装或更新必须先恢复已保存的安装器语言，避免覆盖用户选择。',
    failures,
  );
  const languagePickerLinesRemoved = includeContents
    .split(/\r?\n/u)
    .filter((line) => !/MUI_LANGDLL_(?:WINDOWTITLE|INFO)/u.test(line))
    .join('\n');
  requireCondition(
    !/"[^"\r\n]* \/ [^"\r\n]*"/u.test(languagePickerLinesRemoved),
    '语言选择完成后的安装/卸载文案不得中英文并排显示。',
    failures,
  );

  const destructiveLines = includeContents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:RMDir|Delete)\b/iu.test(line));
  const permittedDestructiveLines = [
    'RMDir /r "$APPDATA\\${APP_FILENAME}"',
    'RMDir /r "$APPDATA\\${APP_PRODUCT_FILENAME}"',
    'RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"',
  ];
  requireCondition(
    JSON.stringify(destructiveLines) === JSON.stringify(permittedDestructiveLines),
    '卸载脚本只能在用户主动确认后删除三个精确的 Electron userData 候选目录。',
    failures,
  );
  requireCondition(
    !/\/REBOOTOK\b/iu.test(includeContents),
    '用户数据删除禁止使用 /REBOOTOK，避免卸载完成后于重启时延迟删除。',
    failures,
  );

  if (failures.length > 0) {
    throw new Error(
      `桌面安装器配置校验失败（${failures.length} 项）：\n- ${failures.join('\n- ')}`,
    );
  }
  return { version: rootVersion, desktopPackage };
}
