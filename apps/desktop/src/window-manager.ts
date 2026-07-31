import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, type Rectangle, session, shell, type WebContents } from 'electron';
import { z } from 'zod';

import type { AppLogger } from './services/logger.js';
import { isSafeExternalUrl, validateDevelopmentUrl } from './services/url-policy.js';
import type { DesktopEventChannel } from './shared/ipc.js';

const windowStateSchema = z
  .object({
    bounds: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(960).max(10_000),
        height: z.number().int().min(640).max(10_000),
      })
      .strict()
      .optional(),
    maximized: z.boolean().default(false),
  })
  .strict();

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
].join('; ');

export interface WindowManagerOptions {
  stateFile: string;
  logger: AppLogger;
  rendererUrl?: string;
}

/**
 * 创建和管理采用上下文隔离、沙箱及导航白名单的主窗口。
 */
export class WindowManager {
  private window: BrowserWindow | undefined;

  public constructor(private readonly options: WindowManagerOptions) {}

  /**
   * 安装会话级 CSP 和默认拒绝的权限策略。
   */
  public installSessionSecurity(): void {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      headers['Content-Security-Policy'] = [contentSecurityPolicy];
      callback({ responseHeaders: headers });
    });
  }

  /**
   * 创建主窗口；内容准备完成前保持隐藏，避免白屏。
   */
  public async create(): Promise<BrowserWindow> {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      return this.window;
    }
    const state = await this.readWindowState();
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const browserWindow = new BrowserWindow({
      title: 'E Agent',
      width: state.bounds?.width ?? 1440,
      height: state.bounds?.height ?? 900,
      ...(state.bounds?.x === undefined ? {} : { x: state.bounds.x }),
      ...(state.bounds?.y === undefined ? {} : { y: state.bounds.y }),
      minWidth: 960,
      minHeight: 640,
      show: false,
      backgroundColor: '#0b0d10',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(currentDirectory, 'preload.cjs'),
        devTools: this.options.rendererUrl !== undefined,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: true,
        safeDialogs: true,
      },
    });
    this.window = browserWindow;
    if (state.maximized) {
      browserWindow.maximize();
    }
    this.hardenWebContents(browserWindow.webContents);
    browserWindow.once('ready-to-show', () => browserWindow.show());
    browserWindow.on('close', () => {
      void this.persistWindowState(browserWindow);
    });
    browserWindow.on('closed', () => {
      if (this.window === browserWindow) {
        this.window = undefined;
      }
    });
    browserWindow.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('渲染进程退出', {
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });

    if (this.options.rendererUrl !== undefined) {
      const url = validateDevelopmentUrl(this.options.rendererUrl);
      await browserWindow.loadURL(url);
    } else {
      await browserWindow.loadFile(join(currentDirectory, 'renderer', 'index.html'));
    }
    return browserWindow;
  }

  /**
   * 判断 IPC 发送者是否为当前主窗口且来自已加载页面。
   */
  public isTrustedSender(sender: WebContents): boolean {
    if (this.window?.webContents.id !== sender.id || sender.isDestroyed()) {
      return false;
    }
    const url = sender.getURL();
    if (this.options.rendererUrl !== undefined) {
      try {
        return (
          new URL(url).origin === new URL(validateDevelopmentUrl(this.options.rendererUrl)).origin
        );
      } catch {
        return false;
      }
    }
    return url.startsWith('file:');
  }

  /**
   * 向渲染进程发送白名单事件。
   */
  public emit(channel: DesktopEventChannel, payload: unknown): void {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  /**
   * 返回当前主窗口。
   */
  public get(): BrowserWindow | undefined {
    return this.window;
  }

  /**
   * 聚焦或恢复主窗口。
   */
  public focus(): void {
    if (this.window?.isMinimized()) {
      this.window.restore();
    }
    this.window?.show();
    this.window?.focus();
  }

  private hardenWebContents(webContents: WebContents): void {
    webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    webContents.on('will-navigate', (event, targetUrl) => {
      if (!this.isAllowedAppNavigation(webContents.getURL(), targetUrl)) {
        event.preventDefault();
      }
    });
    webContents.on('will-attach-webview', (event) => event.preventDefault());
  }

  private isAllowedAppNavigation(currentUrl: string, targetUrl: string): boolean {
    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      if (current.protocol === 'file:') {
        return target.protocol === 'file:' && target.pathname === current.pathname;
      }
      return target.origin === current.origin && target.pathname === current.pathname;
    } catch {
      return false;
    }
  }

  private async readWindowState(): Promise<z.infer<typeof windowStateSchema>> {
    try {
      return windowStateSchema.parse(
        JSON.parse(await readFile(this.options.stateFile, 'utf8')) as unknown,
      );
    } catch {
      return { maximized: false };
    }
  }

  private async persistWindowState(window: BrowserWindow): Promise<void> {
    const bounds: Rectangle = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    await writeFile(
      this.options.stateFile,
      JSON.stringify({ bounds, maximized: window.isMaximized() }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    ).catch((error: unknown) => {
      this.options.logger.warn('窗口状态保存失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}
