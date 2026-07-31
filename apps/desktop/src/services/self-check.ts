import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';

export interface SelfCheckItem {
  id: string;
  label: string;
  status: 'error' | 'ok' | 'warning';
  message: string;
}

export interface SelfCheckReport {
  healthy: boolean;
  checkedAt: string;
  items: readonly SelfCheckItem[];
}

export interface SelfCheckOptions {
  userDataDirectory: string;
  pluginHostPath: string;
  minimumNodeMajor?: number;
}

/**
 * 检查运行时版本、数据目录写入能力、插件宿主和可选 Python 环境。
 */
export async function runSelfCheck(options: SelfCheckOptions): Promise<SelfCheckReport> {
  const items: SelfCheckItem[] = [];
  const minimumNodeMajor = options.minimumNodeMajor ?? 22;
  const nodeMajor = parseMajorVersion(process.versions.node);
  items.push({
    id: 'node',
    label: 'Node.js 运行时',
    status: nodeMajor >= minimumNodeMajor ? 'ok' : 'error',
    message:
      nodeMajor >= minimumNodeMajor
        ? `Node.js ${process.versions.node}`
        : `需要 Node.js ${minimumNodeMajor} 或更高版本`,
  });

  const temporaryPath = `${options.userDataDirectory}/.write-check-${randomUUID()}`;
  try {
    await mkdir(options.userDataDirectory, { recursive: true });
    await writeFile(temporaryPath, 'ok', { encoding: 'utf8', flag: 'wx' });
    await rm(temporaryPath, { force: true });
    items.push({
      id: 'user-data',
      label: '配置目录',
      status: 'ok',
      message: '配置目录可写',
    });
  } catch {
    items.push({
      id: 'user-data',
      label: '配置目录',
      status: 'error',
      message: '配置目录不可写，请检查磁盘空间和目录权限',
    });
  }

  try {
    await access(options.pluginHostPath);
    items.push({
      id: 'plugin-host',
      label: '插件宿主',
      status: 'ok',
      message: '插件宿主文件完整',
    });
  } catch {
    items.push({
      id: 'plugin-host',
      label: '插件宿主',
      status: 'error',
      message: '插件宿主未构建或安装包不完整',
    });
  }

  const python = await detectPython();
  items.push({
    id: 'python',
    label: 'Python（可选）',
    status: python === undefined ? 'warning' : 'ok',
    message: python === undefined ? '未检测到 Python；仅依赖 Python 的 Skill 不可用' : python,
  });

  return {
    healthy: !items.some((item) => item.status === 'error'),
    checkedAt: new Date().toISOString(),
    items,
  };
}

/**
 * 从语义版本字符串中读取主版本号。
 */
export function parseMajorVersion(version: string): number {
  const value = Number(version.replace(/^v/, '').split('.')[0]);
  return Number.isInteger(value) ? value : 0;
}

async function detectPython(): Promise<string | undefined> {
  for (const executable of process.platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python']) {
    const result = await executeVersion(executable);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

async function executeVersion(executable: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      executable,
      ['--version'],
      {
        timeout: 3_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolvePromise(undefined);
          return;
        }
        resolvePromise((stdout || stderr).trim().slice(0, 200));
      },
    );
    child.on('error', () => resolvePromise(undefined));
  });
}
