import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { redactText } from '@e-agent/security';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';

import { DesktopError } from './errors.js';

const sessionIdSchema = z.string().uuid();
const publicUrlSchema = z.string().url().max(2_048);
const selectorSchema = z.string().min(1).max(512).optional();

export const browserOpenArgumentsSchema = z
  .object({
    url: publicUrlSchema,
  })
  .strict();

export const browserNavigateArgumentsSchema = z
  .object({
    sessionId: sessionIdSchema,
    url: publicUrlSchema,
  })
  .strict();

export const browserExtractArgumentsSchema = z
  .object({
    sessionId: sessionIdSchema,
    selector: selectorSchema,
    format: z.enum(['text', 'html']).default('text'),
  })
  .strict();

export const browserScreenshotArgumentsSchema = z
  .object({
    sessionId: sessionIdSchema,
    fullPage: z.boolean().default(false),
  })
  .strict();

export type BrowserToolArguments =
  | { name: 'browser_extract'; input: z.infer<typeof browserExtractArgumentsSchema> }
  | { name: 'browser_navigate'; input: z.infer<typeof browserNavigateArgumentsSchema> }
  | { name: 'browser_open'; input: z.infer<typeof browserOpenArgumentsSchema> }
  | { name: 'browser_screenshot'; input: z.infer<typeof browserScreenshotArgumentsSchema> };

export interface BrowserPageMetadata {
  url: string;
  title: string;
}

export interface BrowserScreenshot {
  data: Buffer;
  height: number;
  mimeType: 'image/jpeg';
  width: number;
}

export interface BrowserPage {
  close(): Promise<void>;
  extract(input: {
    format: 'html' | 'text';
    selector?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<{ content: string; metadata: BrowserPageMetadata; truncated?: boolean }>;
  navigate(input: {
    signal?: AbortSignal;
    timeoutMs: number;
    url: string;
  }): Promise<BrowserPageMetadata>;
  screenshot(input: {
    fullPage: boolean;
    maximumBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<BrowserScreenshot>;
}

export interface BrowserPageFactory {
  create(input: {
    requestGuard: (url: string) => Promise<boolean>;
    sessionId: string;
  }): Promise<BrowserPage>;
}

export type BrowserNetworkNavigationPolicy = 'best-effort-public-only' | 'disabled';

export interface BrowserNetworkNavigationApproval {
  /**
   * 必须与本次工具参数中的完整 URL 完全一致（包含 query 与 fragment）。
   * 该值只用于内存中的单次调用校验，不应写入日志或工具结果。
   */
  approvedUrl: string;
}

export interface BrowserToolExecutionOptions {
  conversationId: string;
  networkNavigationApproval?: BrowserNetworkNavigationApproval;
  outputLimitBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

interface BrowserSession {
  conversationId: string;
  createdAt: number;
  lastUsedAt: number;
  page: BrowserPage;
}

type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export interface SafeBrowserToolServiceOptions {
  factory: BrowserPageFactory;
  maximumSessions?: number;
  networkNavigationPolicy?: BrowserNetworkNavigationPolicy;
  now?: () => number;
  resolveHost?: ResolveHost;
  sessionIdleTimeoutMs?: number;
}

/**
 * 受限浏览器工具服务。
 *
 * 网络导航默认关闭。显式启用后，每次打开或导航仍必须提供与完整 URL 绑定的审批凭证。
 * 公网限制通过 Node DNS 预检并在重定向和子资源请求时重复执行；由于 Chromium 会独立
 * 解析域名，这只是 best-effort public-only 防护，不是严格的 SSRF 网络隔离。严格隔离
 * 需要把实际连接绑定到已验证地址的固定出口代理。工具不提供点击、输入、上传或下载能力。
 */
export class SafeBrowserToolService {
  private readonly maximumSessions: number;
  private readonly networkNavigationPolicy: BrowserNetworkNavigationPolicy;
  private readonly now: () => number;
  private readonly resolveHost: ResolveHost;
  private readonly sessionIdleTimeoutMs: number;
  private readonly sessions = new Map<string, BrowserSession>();

  public constructor(private readonly options: SafeBrowserToolServiceOptions) {
    this.maximumSessions = options.maximumSessions ?? 2;
    this.networkNavigationPolicy = options.networkNavigationPolicy ?? 'disabled';
    this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  public async execute(
    invocation: BrowserToolArguments,
    options: BrowserToolExecutionOptions,
  ): Promise<unknown> {
    await this.expireIdleSessions();
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs, 60_000));
    const outputLimitBytes = Math.max(4_096, Math.min(options.outputLimitBytes, 1_048_576));

    if (invocation.name === 'browser_open') {
      this.assertNavigationApproved(invocation.input.url, options.networkNavigationApproval);
      await this.assertPublicUrl(invocation.input.url);
      await this.makeRoom();
      const sessionId = randomUUID();
      const page = await this.options.factory.create({
        sessionId,
        requestGuard: async (url) => {
          try {
            await this.assertPublicUrl(url);
            return true;
          } catch {
            return false;
          }
        },
      });
      const session: BrowserSession = {
        conversationId: options.conversationId,
        createdAt: this.now(),
        lastUsedAt: this.now(),
        page,
      };
      this.sessions.set(sessionId, session);
      try {
        const metadata = await page.navigate({
          url: invocation.input.url,
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return {
          kind: 'browser-page',
          sessionId,
          url: publicDisplayUrl(metadata.url),
          title: redactText(metadata.title),
          isolated: true,
          networkBoundary: 'best-effort-public-only',
        };
      } catch (error) {
        this.sessions.delete(sessionId);
        await page.close().catch(() => undefined);
        throw error;
      }
    }

    const session = this.requireSession(invocation.input.sessionId, options.conversationId);
    session.lastUsedAt = this.now();
    if (invocation.name === 'browser_navigate') {
      this.assertNavigationApproved(invocation.input.url, options.networkNavigationApproval);
      await this.assertPublicUrl(invocation.input.url);
      const metadata = await session.page.navigate({
        url: invocation.input.url,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return {
        kind: 'browser-page',
        sessionId: invocation.input.sessionId,
        url: publicDisplayUrl(metadata.url),
        title: redactText(metadata.title),
        isolated: true,
        networkBoundary: 'best-effort-public-only',
      };
    }
    if (invocation.name === 'browser_extract') {
      const extracted = await session.page.extract({
        format: invocation.input.format,
        timeoutMs,
        ...(invocation.input.selector === undefined ? {} : { selector: invocation.input.selector }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const redacted = redactText(extracted.content);
      const bounded = limitUtf8(redacted, Math.max(1_024, outputLimitBytes - 2_048));
      return {
        kind: 'browser-extract',
        sessionId: invocation.input.sessionId,
        url: publicDisplayUrl(extracted.metadata.url),
        title: redactText(extracted.metadata.title),
        format: invocation.input.format,
        content: bounded.value,
        truncated: bounded.truncated || extracted.truncated === true,
        redacted: redacted !== extracted.content,
      };
    }

    // Base64 会膨胀约 4/3，先为 JSON 字段和编码开销预留空间。
    const maximumImageBytes = Math.max(
      1_024,
      Math.floor((Math.max(2_048, outputLimitBytes - 3_072) * 3) / 4),
    );
    const screenshot = await session.page.screenshot({
      fullPage: invocation.input.fullPage,
      maximumBytes: maximumImageBytes,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (screenshot.data.byteLength > maximumImageBytes) {
      throw new DesktopError(
        'BROWSER_SCREENSHOT_TOO_LARGE',
        '浏览器截图在压缩后仍超过工具输出上限，未返回不完整图片。',
      );
    }
    const result = {
      kind: 'browser-screenshot',
      sessionId: invocation.input.sessionId,
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      bytes: screenshot.data.byteLength,
      base64: screenshot.data.toString('base64'),
      truncated: false,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > outputLimitBytes) {
      throw new DesktopError(
        'BROWSER_SCREENSHOT_TOO_LARGE',
        '浏览器截图编码后超过工具输出上限，未返回不完整图片。',
      );
    }
    return result;
  }

  public async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.page.close()));
  }

  private assertNavigationApproved(
    requestedUrl: string,
    approval: BrowserNetworkNavigationApproval | undefined,
  ): void {
    if (this.networkNavigationPolicy !== 'best-effort-public-only') {
      throw new DesktopError(
        'BROWSER_NETWORK_NAVIGATION_DISABLED',
        '浏览器网络导航默认关闭；必须先启用 best-effort public-only 策略并逐次审批完整 URL。',
      );
    }
    if (approval === undefined || approval.approvedUrl !== requestedUrl) {
      throw new DesktopError(
        'BROWSER_NAVIGATION_APPROVAL_REQUIRED',
        '浏览器打开或导航需要逐次审批，且审批必须与包含查询参数的完整 URL 完全一致。',
      );
    }
  }

  private async assertPublicUrl(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DesktopError('BROWSER_URL_DENIED', '浏览器只接受有效的公网 HTTP(S) URL。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new DesktopError(
        'BROWSER_URL_DENIED',
        '浏览器只允许不包含用户名或密码的公网 HTTP(S) URL。',
      );
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.home.arpa') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new DesktopError(
        'BROWSER_PRIVATE_NETWORK_DENIED',
        '浏览器工具不能访问本机或私有网络。',
      );
    }
    const addresses = isIP(hostname) === 0 ? await this.resolveHost(hostname) : [hostname];
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
      throw new DesktopError(
        'BROWSER_PRIVATE_NETWORK_DENIED',
        '浏览器工具不能访问本机或私有网络。',
      );
    }
  }

  private requireSession(sessionId: string, conversationId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.conversationId !== conversationId) {
      throw new DesktopError(
        'BROWSER_SESSION_NOT_FOUND',
        '浏览器会话不存在、已过期或不属于当前对话。',
      );
    }
    return session;
  }

  private async expireIdleSessions(): Promise<void> {
    const cutoff = this.now() - this.sessionIdleTimeoutMs;
    const expired = [...this.sessions.entries()].filter(
      ([, session]) => session.lastUsedAt <= cutoff,
    );
    for (const [sessionId, session] of expired) {
      this.sessions.delete(sessionId);
      await session.page.close().catch(() => undefined);
    }
  }

  private async makeRoom(): Promise<void> {
    if (this.sessions.size < this.maximumSessions) return;
    const oldest = [...this.sessions.entries()].sort(
      ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
    )[0];
    if (oldest === undefined) return;
    this.sessions.delete(oldest[0]);
    await oldest[1].page.close().catch(() => undefined);
  }
}

function publicDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[网页地址已隐藏]';
  }
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw new DesktopError('BROWSER_DNS_FAILED', '浏览器无法解析目标域名。');
  }
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  try {
    const parsed = ipaddr.process(normalized);
    if (parsed.kind() === 'ipv4') {
      return parsed.range() === 'unicast';
    }
    return parsed.range() === 'unicast' && parsed.match(ipaddr.IPv6.parseCIDR('2000::/3'));
  } catch {
    return false;
  }
}

function limitUtf8(value: string, maximumBytes: number): { truncated: boolean; value: string } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}
