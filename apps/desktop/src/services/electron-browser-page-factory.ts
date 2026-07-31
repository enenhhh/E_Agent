import { BrowserWindow, session, type NativeImage, type Session } from 'electron';

import type {
  BrowserPage,
  BrowserPageFactory,
  BrowserPageMetadata,
  BrowserScreenshot,
} from './browser-tool-service.js';
import { DesktopError } from './errors.js';

const isolatedWorldId = 10_001;

export class ElectronBrowserPageFactory implements BrowserPageFactory {
  public async create(input: {
    requestGuard: (url: string) => Promise<boolean>;
    sessionId: string;
  }): Promise<BrowserPage> {
    const partition = `e-agent-browser-${input.sessionId}`;
    const isolatedSession = session.fromPartition(partition, { cache: false });
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.on('will-download', (event) => event.preventDefault());
    isolatedSession.webRequest.onBeforeRequest(
      {
        urls: ['file://*/*', 'ftp://*/*', 'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      },
      (details, callback) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(details.method.toUpperCase())) {
          callback({ cancel: true });
          return;
        }
        void input
          .requestGuard(details.url)
          .then((allowed) => callback({ cancel: !allowed }))
          .catch(() => callback({ cancel: true }));
      },
    );

    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1_280,
      height: 900,
      webPreferences: {
        backgroundThrottling: true,
        contextIsolation: true,
        devTools: false,
        javascript: false,
        nodeIntegration: false,
        sandbox: true,
        session: isolatedSession,
        spellcheck: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {
      let protocol = '';
      try {
        protocol = new URL(url).protocol;
      } catch {
        event.preventDefault();
      }
      if (protocol !== 'http:' && protocol !== 'https:') event.preventDefault();
    });

    return new ElectronBrowserPage(window, isolatedSession);
  }
}

class ElectronBrowserPage implements BrowserPage {
  public constructor(
    private readonly window: BrowserWindow,
    private readonly isolatedSession: Session,
  ) {}

  public async navigate(input: {
    signal?: AbortSignal;
    timeoutMs: number;
    url: string;
  }): Promise<BrowserPageMetadata> {
    await withTimeout(
      this.window.webContents.loadURL(input.url, {
        extraHeaders: 'DNT: 1\r\n',
        userAgent: 'EAgentBrowser/1.0',
      }),
      input.timeoutMs,
      input.signal,
      () => this.window.webContents.stop(),
    );
    return this.metadata();
  }

  public async extract(input: {
    format: 'html' | 'text';
    selector?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<{ content: string; metadata: BrowserPageMetadata; truncated?: boolean }> {
    const serializedInput = JSON.stringify({
      format: input.format,
      selector: input.selector ?? null,
    });
    const result = await withTimeout(
      this.window.webContents.executeJavaScriptInIsolatedWorld(
        isolatedWorldId,
        [
          {
            code: `(() => {
              const input = ${serializedInput};
              const root = input.selector === null
                ? document.body
                : document.querySelector(input.selector);
              if (root === null) return { found: false, content: '' };
              const content = input.format === 'html'
                ? root.outerHTML
                : (root.innerText || root.textContent || '');
              return {
                found: true,
                content: content.slice(0, 2000000),
                truncated: content.length > 2000000
              };
            })()`,
          },
        ],
        false,
      ),
      input.timeoutMs,
      input.signal,
      () => this.window.webContents.stop(),
    );
    if (
      result === null ||
      typeof result !== 'object' ||
      !('found' in result) ||
      result.found !== true
    ) {
      throw new DesktopError('BROWSER_SELECTOR_NOT_FOUND', '页面中没有找到指定的元素。');
    }
    return {
      content: 'content' in result && typeof result.content === 'string' ? result.content : '',
      metadata: this.metadata(),
      truncated: 'truncated' in result && result.truncated === true,
    };
  }

  public async screenshot(input: {
    fullPage: boolean;
    maximumBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<BrowserScreenshot> {
    let previousSize: [number, number] | undefined;
    if (input.fullPage) {
      const dimensions = await withTimeout(
        this.window.webContents.executeJavaScriptInIsolatedWorld(
          isolatedWorldId,
          [
            {
              code: `({
                width: Math.min(2560, Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)),
                height: Math.min(4096, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0))
              })`,
            },
          ],
          false,
        ),
        input.timeoutMs,
        input.signal,
      );
      if (
        dimensions !== null &&
        typeof dimensions === 'object' &&
        'width' in dimensions &&
        'height' in dimensions &&
        typeof dimensions.width === 'number' &&
        typeof dimensions.height === 'number'
      ) {
        const bounds = this.window.getContentBounds();
        previousSize = [bounds.width, bounds.height];
        this.window.setContentSize(
          Math.max(320, Math.floor(dimensions.width)),
          Math.max(240, Math.floor(dimensions.height)),
        );
      }
    }

    try {
      const image = await withTimeout(
        this.window.webContents.capturePage(),
        input.timeoutMs,
        input.signal,
        () => this.window.webContents.stop(),
      );
      return compressImage(image, input.maximumBytes);
    } finally {
      if (previousSize !== undefined && !this.window.isDestroyed()) {
        this.window.setContentSize(previousSize[0], previousSize[1]);
      }
    }
  }

  public async close(): Promise<void> {
    if (!this.window.isDestroyed()) this.window.destroy();
    await this.isolatedSession.clearStorageData();
  }

  private metadata(): BrowserPageMetadata {
    return {
      url: this.window.webContents.getURL(),
      title: this.window.webContents.getTitle().slice(0, 500),
    };
  }
}

function compressImage(image: NativeImage, maximumBytes: number): BrowserScreenshot {
  let current = image;
  let size = current.getSize();
  const maximumWidth = 1_920;
  if (size.width > maximumWidth) {
    current = current.resize({ width: maximumWidth, quality: 'good' });
    size = current.getSize();
  }
  for (const quality of [75, 60, 45, 30]) {
    const data = current.toJPEG(quality);
    if (data.byteLength <= maximumBytes) {
      return { data, mimeType: 'image/jpeg', width: size.width, height: size.height };
    }
  }
  const scale = Math.min(1, Math.sqrt(maximumBytes / Math.max(1, current.toJPEG(30).byteLength)));
  if (scale < 1) {
    current = current.resize({
      width: Math.max(320, Math.floor(size.width * scale)),
      quality: 'good',
    });
    size = current.getSize();
  }
  const data = current.toJPEG(25);
  return { data, mimeType: 'image/jpeg', width: size.width, height: size.height };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (signal?.aborted) {
    onAbort?.();
    throw new DesktopError('BROWSER_CANCELLED', '浏览器操作已取消。');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onAbort?.();
      reject(new DesktopError('BROWSER_TIMEOUT', '浏览器操作已超时。'));
    }, timeoutMs);
    timer.unref();
  });
  const aborted =
    signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            onAbort?.();
            reject(new DesktopError('BROWSER_CANCELLED', '浏览器操作已取消。'));
          };
          signal.addEventListener('abort', abortListener, { once: true });
        });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}
