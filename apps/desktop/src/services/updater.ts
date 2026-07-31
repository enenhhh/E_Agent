import updaterPackage, { type UpdateInfo } from 'electron-updater';

const { autoUpdater } = updaterPackage;

import type { AppLogger } from './logger.js';

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'disabled' }
  | { state: 'downloaded'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'error'; message: string }
  | { state: 'not-available'; version: string }
  | { state: 'available'; version: string };

export interface UpdateServiceOptions {
  enabled: boolean;
  logger: AppLogger;
  emit: (status: UpdateStatus) => void;
}

/**
 * 对 electron-updater 进行显式下载和安装封装。
 */
export class UpdateService {
  public constructor(private readonly options: UpdateServiceOptions) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => options.emit({ state: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      options.emit({ state: 'available', version: info.version }),
    );
    autoUpdater.on('update-not-available', (info) =>
      options.emit({ state: 'not-available', version: info.version }),
    );
    autoUpdater.on('download-progress', (progress) =>
      options.emit({
        state: 'downloading',
        percent: Math.max(0, Math.min(100, progress.percent)),
      }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      options.emit({ state: 'downloaded', version: info.version }),
    );
    autoUpdater.on('error', (error) => {
      options.logger.warn('自动更新失败', { message: error.message });
      options.emit({ state: 'error', message: '更新服务暂时不可用' });
    });
  }

  /**
   * 检查更新，但不自动下载。
   */
  public async check(): Promise<UpdateInfo | undefined> {
    if (!this.options.enabled) {
      this.options.emit({ state: 'disabled' });
      return undefined;
    }
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo;
  }

  /**
   * 下载此前发现的更新。
   */
  public async download(): Promise<void> {
    if (!this.options.enabled) {
      throw new Error('开发或 E2E 模式不执行自动更新');
    }
    await autoUpdater.downloadUpdate();
  }

  /**
   * 在用户明确操作后退出并安装已经下载的更新。
   */
  public installAndRestart(): void {
    if (!this.options.enabled) {
      throw new Error('开发或 E2E 模式不执行自动更新');
    }
    autoUpdater.quitAndInstall(false, true);
  }
}
