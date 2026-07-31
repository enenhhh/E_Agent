#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArguments, resolveWorkspacePath, workspaceRoot } from '../lib/workspace.mjs';

const productName = 'E Agent';
const supportedArchitectures = new Set(['x64', 'ia32', 'arm64']);
const powershellMetadataScript = `
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:E_AGENT_INSTALLER_VERIFY_PATH
$info = $item.VersionInfo
[ordered]@{
  FileVersion = $info.FileVersion
  ProductVersion = $info.ProductVersion
  ProductName = $info.ProductName
} | ConvertTo-Json -Compress
`;

/** 将发布标签规范化为安装包使用的 SemVer。 */
export function normalizeReleaseVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('必须通过 --version 提供安装包版本。');
  }
  const normalized = value.replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`安装包版本不是有效的 SemVer：${value}`);
  }
  return normalized;
}

/** 返回 electron-builder 配置约定的精确 Windows 安装包文件名。 */
export function expectedWindowsInstallerName(version, architecture = 'x64') {
  const normalizedVersion = normalizeReleaseVersion(version);
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`不支持的 Windows 架构：${architecture}`);
  }
  return `${productName}-Setup-${normalizedVersion}-${architecture}.exe`;
}

/**
 * 从顶层目录项中选择唯一的目标安装包。
 *
 * 任何其他 E Agent EXE（旧版本或其他架构）都会使检查失败，避免陈旧产物混入发布。
 */
export function selectWindowsInstaller(entries, version, architecture = 'x64') {
  const expectedName = expectedWindowsInstallerName(version, architecture);
  const candidates = entries.filter((entry) =>
    /^E Agent-(?:Setup-)?[^\\/]+\.exe$/iu.test(entry.name),
  );
  const candidateNames = candidates
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (candidateNames.length !== 1 || candidateNames[0] !== expectedName) {
    throw new Error(
      `Windows 安装包必须且只能是 ${expectedName}；实际为：${
        candidateNames.length === 0 ? '无' : candidateNames.join(', ')
      }`,
    );
  }
  const selected = candidates[0];
  if (
    selected === undefined ||
    typeof selected.isFile !== 'function' ||
    !selected.isFile() ||
    (typeof selected.isSymbolicLink === 'function' && selected.isSymbolicLink())
  ) {
    throw new Error(`Windows 安装包不是普通文件：${expectedName}`);
  }
  return expectedName;
}

/** 校验差分更新 blockmap 与目标安装包一一对应，避免旧更新元数据混入发布。 */
export function selectWindowsInstallerBlockmap(entries, installerName) {
  const expectedName = `${installerName}.blockmap`;
  const candidates = entries.filter((entry) => /^E Agent-.+\.exe\.blockmap$/iu.test(entry.name));
  const candidateNames = candidates
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (candidateNames.length !== 1 || candidateNames[0] !== expectedName) {
    throw new Error(
      `Windows blockmap 必须且只能是 ${expectedName}；实际为：${
        candidateNames.length === 0 ? '无' : candidateNames.join(', ')
      }`,
    );
  }
  const selected = candidates[0];
  if (
    selected === undefined ||
    typeof selected.isFile !== 'function' ||
    !selected.isFile() ||
    (typeof selected.isSymbolicLink === 'function' && selected.isSymbolicLink())
  ) {
    throw new Error(`Windows blockmap 不是普通文件：${expectedName}`);
  }
  return expectedName;
}

/** 校验安装器 PE VERSIONINFO 中的产品与版本字段。 */
export function validatePeMetadata(metadata, version) {
  const normalizedVersion = normalizeReleaseVersion(version);
  if (metadata === null || typeof metadata !== 'object') {
    throw new Error('无法读取 Windows 安装包 PE 元数据。');
  }
  if (metadata.FileVersion !== normalizedVersion) {
    throw new Error(
      `Windows 安装包 FileVersion 不匹配：期望 ${normalizedVersion}，实际 ${
        metadata.FileVersion ?? '缺失'
      }`,
    );
  }
  if (metadata.ProductVersion !== normalizedVersion) {
    throw new Error(
      `Windows 安装包 ProductVersion 不匹配：期望 ${normalizedVersion}，实际 ${
        metadata.ProductVersion ?? '缺失'
      }`,
    );
  }
  if (metadata.ProductName !== productName) {
    throw new Error(
      `Windows 安装包 ProductName 不匹配：期望 ${productName}，实际 ${
        metadata.ProductName ?? '缺失'
      }`,
    );
  }
}

function appArchiveName(architecture) {
  if (architecture === 'x64') return 'app-64.7z';
  if (architecture === 'ia32') return 'app-32.7z';
  if (architecture === 'arm64') return 'app-arm64.7z';
  throw new Error(`不支持的 Windows 架构：${architecture}`);
}

/** 校验 7-Zip NSIS 列表中必须存在的安装器资源。 */
export function validateNsisListing(listing, architecture = 'x64') {
  if (typeof listing !== 'string' || !/^Type = Nsis\s*$/imu.test(listing)) {
    throw new Error('目标文件不是可识别的 NSIS 安装包。');
  }
  if (!/^SubType = NSIS-3 Unicode\s*$/imu.test(listing)) {
    throw new Error('NSIS 安装包必须使用 Unicode 模式。');
  }
  const paths = new Set(
    [...listing.matchAll(/^Path = (.+)$/gimu)].map((match) =>
      match[1].trim().replaceAll('/', '\\').toLocaleLowerCase('en-US'),
    ),
  );
  const requiredPaths = [
    `$PLUGINSDIR\\${appArchiveName(architecture)}`,
    '$R0\\Uninstall E Agent.exe',
    '$PLUGINSDIR\\modern-wizard.bmp',
    '$PLUGINSDIR\\modern-header.bmp',
  ];
  const missing = requiredPaths.filter(
    (requiredPath) => !paths.has(requiredPath.toLocaleLowerCase('en-US')),
  );
  if (missing.length > 0) {
    throw new Error(`NSIS 安装包缺少必要资源：${missing.join(', ')}`);
  }
  const forbiddenPaths = ['$PLUGINSDIR\\license.html', '$PLUGINSDIR\\EmbedHTML.dll'];
  const legacyHtmlResources = forbiddenPaths.filter((forbiddenPath) =>
    paths.has(forbiddenPath.toLocaleLowerCase('en-US')),
  );
  if (legacyHtmlResources.length > 0) {
    throw new Error(
      `NSIS 安装包仍包含已禁用的 HTML 免责条款资源：${legacyHtmlResources.join(', ')}`,
    );
  }
}

function assertCommandSucceeded(result, label) {
  if (result?.error !== undefined) throw result.error;
  if (result?.status !== 0) {
    throw new Error(
      `${label}失败（退出码 ${result?.status ?? 'unknown'}）：${String(result?.stderr ?? '').trim()}`,
    );
  }
  return String(result.stdout ?? '');
}

function assertExpectedToolExecutable(executablePath, allowedNames, label) {
  const executableName = path.win32.basename(executablePath).toLocaleLowerCase('en-US');
  if (!allowedNames.has(executableName)) {
    throw new Error(`${label}路径不是允许的只读检查工具：${executablePath}`);
  }
}

/**
 * 通过 PowerShell 的 Get-Item.VersionInfo 读取 PE 资源。
 *
 * 安装包路径只通过环境变量作为数据传入；该函数不会把安装包作为进程执行。
 */
export function readWindowsPeMetadata(
  installerPath,
  { powershellPath = 'powershell.exe', runCommand = spawnSync } = {},
) {
  assertExpectedToolExecutable(
    powershellPath,
    new Set(['powershell.exe', 'pwsh.exe', 'pwsh']),
    'PowerShell',
  );
  const result = runCommand(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-Command', powershellMetadataScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        E_AGENT_INSTALLER_VERIFY_PATH: installerPath,
      },
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  const output = assertCommandSucceeded(result, '读取 PE 元数据');
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new Error('PowerShell 返回的 PE 元数据不是有效 JSON。', { cause: error });
  }
}

/**
 * 使用带 NSIS handler 的本地 7-Zip 只读列出安装器内容。
 *
 * 仅执行 7-Zip，本函数不会执行安装器或其中的卸载器。
 */
export function listNsisContents(installerPath, { sevenZipPath, runCommand = spawnSync }) {
  if (typeof sevenZipPath !== 'string' || sevenZipPath.trim() === '') {
    throw new Error('缺少可读取 NSIS 的本地 7-Zip 路径。');
  }
  assertExpectedToolExecutable(sevenZipPath, new Set(['7z.exe', '7za.exe', '7zz.exe']), '7-Zip');
  const result = runCommand(sevenZipPath, ['l', '-tNsis', '-slt', installerPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return assertCommandSucceeded(result, '列出 NSIS 内容');
}

/** 定位 pnpm 依赖图内 electron-winstaller 自带的完整 7-Zip。 */
export async function findLocalSevenZip() {
  const pnpmDirectory = path.join(workspaceRoot, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = await readdir(pnpmDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error('无法读取本地 pnpm 依赖目录，请先安装开发依赖。', { cause: error });
  }
  const packageDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('electron-winstaller@'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const packageDirectory of packageDirectories) {
    const candidate = path.join(
      pnpmDirectory,
      packageDirectory,
      'node_modules',
      'electron-winstaller',
      'vendor',
      '7z.exe',
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续检查下一个本地版本。
    }
  }
  throw new Error('未找到支持 NSIS 的本地 7-Zip；请确认 electron-winstaller 依赖完整。');
}

/**
 * 只读验证 Windows 安装包。测试可注入元数据与 NSIS 读取器，因此无需真实安装包或 Windows。
 */
export async function verifyWindowsInstaller(
  { directory, version, architecture = 'x64', sevenZipPath = undefined },
  dependencies = {},
) {
  const normalizedVersion = normalizeReleaseVersion(version);
  const entries = await (dependencies.readDirectory ?? readdir)(directory, {
    withFileTypes: true,
  });
  const installerName = selectWindowsInstaller(entries, normalizedVersion, architecture);
  const blockmapName = selectWindowsInstallerBlockmap(entries, installerName);
  const installerPath = path.join(directory, installerName);

  const readPeMetadata = dependencies.readPeMetadata ?? readWindowsPeMetadata;
  let listContents = dependencies.listNsisContents;
  if (listContents === undefined) {
    if (process.platform !== 'win32') {
      throw new Error('真实 Windows 安装包验证必须在 Windows 上运行。');
    }
    const resolvedSevenZip = sevenZipPath ?? (await findLocalSevenZip());
    listContents = (filePath) =>
      listNsisContents(filePath, {
        sevenZipPath: resolvedSevenZip,
      });
  }

  const metadata = await readPeMetadata(installerPath);
  validatePeMetadata(metadata, normalizedVersion);
  const listing = await listContents(installerPath);
  validateNsisListing(listing, architecture);
  return {
    installerPath,
    installerName,
    blockmapName,
    version: normalizedVersion,
    architecture,
    productName,
  };
}

export async function main(argumentsList = process.argv.slice(2)) {
  const argumentsMap = parseArguments(argumentsList);
  const allowedArguments = new Set(['directory', 'version', 'arch', 'seven-zip']);
  for (const name of argumentsMap.keys()) {
    if (!allowedArguments.has(name)) throw new Error(`无法识别的参数：--${name}`);
  }
  const version = argumentsMap.get('version');
  if (typeof version !== 'string') {
    throw new Error('必须通过 --version 提供安装包版本。');
  }
  const architectureArgument = argumentsMap.get('arch');
  const architecture = typeof architectureArgument === 'string' ? architectureArgument : 'x64';
  const sevenZipArgument = argumentsMap.get('seven-zip');
  const result = await verifyWindowsInstaller({
    directory: resolveWorkspacePath(argumentsMap.get('directory'), 'release'),
    version,
    architecture,
    ...(typeof sevenZipArgument === 'string'
      ? { sevenZipPath: path.resolve(workspaceRoot, sevenZipArgument) }
      : {}),
  });
  console.log(
    `Windows 安装包只读验证通过：${result.installerName} (${result.productName} ${result.version})`,
  );
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
