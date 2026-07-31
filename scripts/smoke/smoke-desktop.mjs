#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileSize, listFiles, parseArguments, resolveWorkspacePath } from '../lib/workspace.mjs';

const argumentsMap = parseArguments(process.argv.slice(2));
const releaseDirectory = resolveWorkspacePath(argumentsMap.get('directory'), 'release');
const expectedVersionArgument = argumentsMap.get('version');
const expectedVersion =
  typeof expectedVersionArgument === 'string'
    ? expectedVersionArgument.replace(/^v/u, '')
    : undefined;
const platform =
  (typeof argumentsMap.get('platform') === 'string'
    ? argumentsMap.get('platform')
    : process.platform) ?? process.platform;
const minimumBytes = Number(
  typeof argumentsMap.get('minimum-bytes') === 'string'
    ? argumentsMap.get('minimum-bytes')
    : '1048576',
);
const platformExtensions = {
  darwin: new Set(['.dmg', '.pkg', '.zip']),
  linux: new Set(['.appimage', '.deb', '.rpm', '.snap', '.tar.gz']),
  macos: new Set(['.dmg', '.pkg', '.zip']),
  win32: new Set(['.exe', '.msi', '.zip']),
  windows: new Set(['.exe', '.msi', '.zip']),
};
const expectedExtensions = platformExtensions[platform];

if (!expectedExtensions) {
  throw new Error(`不支持的平台：${platform}`);
}
if (!Number.isFinite(minimumBytes) || minimumBytes < 1) {
  throw new Error('minimum-bytes 必须是正数。');
}
if (
  expectedVersion !== undefined &&
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)
) {
  throw new Error(`version 不是有效的 SemVer：${String(expectedVersionArgument)}`);
}

function extensionOf(filePath) {
  const lowerCasePath = filePath.toLowerCase();
  if (lowerCasePath.endsWith('.tar.gz')) {
    return '.tar.gz';
  }
  return path.extname(lowerCasePath);
}

const candidates = (
  await listFiles(releaseDirectory, {
    ignoredDirectories: new Set(),
  })
).filter(
  (filePath) =>
    path.dirname(filePath) === releaseDirectory && expectedExtensions.has(extensionOf(filePath)),
);

if (candidates.length === 0) {
  throw new Error(
    `${releaseDirectory} 中没有 ${platform} 的安装包（${[...expectedExtensions].join(', ')}）。`,
  );
}

for (const candidate of candidates) {
  const bytes = await fileSize(candidate);
  if (bytes < minimumBytes) {
    throw new Error(`安装包过小，可能不完整：${candidate} (${bytes} bytes)`);
  }
  console.log(`安装包检查通过：${path.basename(candidate)} (${bytes} bytes)`);
}

function isPackagedExecutable(filePath) {
  const portablePath = filePath.split(path.sep).join('/').toLowerCase();
  if (platform === 'windows' || platform === 'win32') {
    return portablePath.endsWith('/win-unpacked/e agent.exe');
  }
  if (platform === 'macos' || platform === 'darwin') {
    return portablePath.endsWith('/e agent.app/contents/macos/e agent');
  }
  const executableName = path.basename(portablePath);
  return (
    platform === 'linux' &&
    portablePath.includes('/linux-unpacked/') &&
    (executableName === 'e-agent' || executableName === 'e agent')
  );
}

const packagedFiles = await listFiles(releaseDirectory, {
  ignoredDirectories: new Set(),
});
const executable = packagedFiles.find(isPackagedExecutable);
if (executable === undefined) {
  throw new Error(`${releaseDirectory} 中没有可执行的解包应用，无法验证主进程启动。`);
}

const smokeDirectory = await mkdtemp(path.join(tmpdir(), 'e-agent-smoke-'));
const markerPath = path.join(smokeDirectory, 'ready.json');
const userDataDirectory = path.join(smokeDirectory, 'user-data');
const electronLogPath = path.join(smokeDirectory, 'electron.log');
const child = spawn(
  executable,
  [
    `--user-data-dir=${userDataDirectory}`,
    '--enable-logging=file',
    `--log-file=${electronLogPath}`,
  ],
  {
    env: {
      ...process.env,
      E_AGENT_DISABLE_UPDATES: '1',
      E_AGENT_E2E: '1',
      E_AGENT_SMOKE_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

const capturedOutput = {
  stdout: '',
  stderr: '',
};
const maximumCapturedCharacters = 32_768;

function captureOutput(target, chunk) {
  capturedOutput[target] = `${capturedOutput[target]}${String(chunk)}`.slice(
    -maximumCapturedCharacters,
  );
}

child.stdout?.on('data', (chunk) => captureOutput('stdout', chunk));
child.stderr?.on('data', (chunk) => captureOutput('stderr', chunk));

function redactDiagnostics(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED_API_KEY]')
    .replace(
      /((?:authorization|api[-_ ]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    );
}

async function collectDiagnostics() {
  const diagnosticFiles = (await listFiles(smokeDirectory, { ignoredDirectories: new Set() }))
    .filter((filePath) => /\.(?:jsonl|log|txt)$/iu.test(filePath))
    .slice(0, 8);
  const sections = [];
  for (const filePath of diagnosticFiles) {
    try {
      const contents = (await readFile(filePath, 'utf8')).slice(-maximumCapturedCharacters);
      if (contents.trim() !== '') {
        sections.push(`--- ${path.relative(smokeDirectory, filePath)} ---\n${contents}`);
      }
    } catch {
      // 日志读取失败不应覆盖真正的启动异常。
    }
  }
  for (const [stream, contents] of Object.entries(capturedOutput)) {
    if (contents.trim() !== '') {
      sections.push(`--- ${stream} ---\n${contents}`);
    }
  }
  return redactDiagnostics(sections.join('\n')).slice(-maximumCapturedCharacters);
}

try {
  const startedAt = Date.now();
  let marker;
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`打包应用在就绪前退出，退出码：${child.exitCode}`);
    }
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (marker?.ready !== true) {
    throw new Error('打包应用未在 30 秒内完成主进程启动。');
  }
  if (marker.healthy !== true) {
    throw new Error(
      `打包应用自检失败：${Array.isArray(marker.failedChecks) ? marker.failedChecks.join(', ') : 'unknown'}`,
    );
  }
  if (expectedVersion !== undefined && marker.version !== expectedVersion) {
    throw new Error(
      `打包应用版本不匹配：期望 ${expectedVersion}，实际 ${String(marker.version ?? '缺失')}`,
    );
  }
  console.log(`打包应用启动检查通过：${path.basename(executable)} ${marker.version}`);
} catch (error) {
  const diagnostics = await collectDiagnostics();
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    diagnostics === '' ? message : `${message}\n\n打包应用启动诊断：\n${diagnostics}`,
    { cause: error },
  );
} finally {
  const childExited = new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
  });
  if (child.exitCode === null) child.kill();
  await Promise.race([
    childExited,
    new Promise((resolve) => {
      setTimeout(resolve, 3_000);
    }),
  ]);
  await rm(smokeDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
