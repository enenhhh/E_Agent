import { describe, expect, it, vi } from 'vitest';

import {
  browserExtractArgumentsSchema,
  browserNavigateArgumentsSchema,
  browserOpenArgumentsSchema,
  browserScreenshotArgumentsSchema,
  SafeBrowserToolService,
  type BrowserPage,
  type BrowserPageFactory,
  type BrowserPageMetadata,
} from './browser-tool-service.js';

class FakePage implements BrowserPage {
  public readonly close = vi.fn(async () => undefined);
  public readonly navigate = vi.fn(
    async (input: { url: string }): Promise<BrowserPageMetadata> => ({
      url: input.url,
      title: 'Example',
    }),
  );
  public readonly extract = vi.fn<BrowserPage['extract']>(async () => ({
    content: `api_key=plain-secret-value ${'内容'.repeat(4_000)}`,
    metadata: { url: 'https://example.com/docs', title: 'Docs' },
  }));
  public readonly screenshot = vi.fn(async () => ({
    data: Buffer.from('jpeg'),
    height: 600,
    mimeType: 'image/jpeg' as const,
    width: 800,
  }));
}

class FakeFactory implements BrowserPageFactory {
  public readonly pages: FakePage[] = [];
  public requestGuard: ((url: string) => Promise<boolean>) | undefined;

  public async create(input: {
    requestGuard: (url: string) => Promise<boolean>;
  }): Promise<BrowserPage> {
    this.requestGuard = input.requestGuard;
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }
}

function browserFixture(
  options: {
    maximumSessions?: number;
    now?: () => number;
    resolveHost?: (hostname: string) => Promise<readonly string[]>;
    sessionIdleTimeoutMs?: number;
  } = {},
) {
  const factory = new FakeFactory();
  const service = new SafeBrowserToolService({
    factory,
    networkNavigationPolicy: 'best-effort-public-only',
    resolveHost: options.resolveHost ?? (async () => ['93.184.216.34']),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maximumSessions === undefined ? {} : { maximumSessions: options.maximumSessions }),
    ...(options.sessionIdleTimeoutMs === undefined
      ? {}
      : { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs }),
  });
  return { factory, service };
}

async function openSession(
  service: SafeBrowserToolService,
  conversationId = 'conversation-a',
): Promise<string> {
  const url = 'https://example.com/docs';
  const result = (await service.execute(
    { name: 'browser_open', input: { url } },
    {
      conversationId,
      networkNavigationApproval: { approvedUrl: url },
      outputLimitBytes: 32_768,
      timeoutMs: 10_000,
    },
  )) as { sessionId: string };
  return result.sessionId;
}

describe('SafeBrowserToolService', () => {
  it('校验浏览器工具参数、补齐默认值并拒绝额外字段', () => {
    expect(browserOpenArgumentsSchema.parse({ url: 'https://example.com/' })).toEqual({
      url: 'https://example.com/',
    });
    expect(
      browserNavigateArgumentsSchema.safeParse({
        sessionId: 'not-a-uuid',
        url: 'https://example.com/',
      }).success,
    ).toBe(false);
    expect(
      browserExtractArgumentsSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000000',
      format: 'text',
    });
    expect(
      browserScreenshotArgumentsSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000000',
      fullPage: false,
    });
    expect(() =>
      browserOpenArgumentsSchema.parse({ url: 'https://example.com/', unexpected: true }),
    ).toThrow();
    expect(() =>
      browserExtractArgumentsSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000000',
        selector: '',
      }),
    ).toThrow();
  });

  it('默认关闭网络导航，并在 DNS、建窗和发网前 fail closed', async () => {
    const factory = new FakeFactory();
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const service = new SafeBrowserToolService({ factory, resolveHost });
    const url = 'https://example.com/private-query?token=must-not-leave';

    await expect(
      service.execute(
        { name: 'browser_open', input: { url } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: url },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_NETWORK_NAVIGATION_DISABLED' });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(factory.pages).toHaveLength(0);
  });

  it('best-effort 策略仍要求绑定完整 URL 的逐次审批，且拒绝缺失或过期审批', async () => {
    const factory = new FakeFactory();
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const service = new SafeBrowserToolService({
      factory,
      networkNavigationPolicy: 'best-effort-public-only',
      resolveHost,
    });
    const url = 'https://example.com/report?project=approved';

    for (const networkNavigationApproval of [
      undefined,
      { approvedUrl: 'https://example.com/report?project=different' },
    ]) {
      await expect(
        service.execute(
          { name: 'browser_open', input: { url } },
          {
            conversationId: 'conversation-a',
            ...(networkNavigationApproval === undefined ? {} : { networkNavigationApproval }),
            outputLimitBytes: 32_768,
            timeoutMs: 10_000,
          },
        ),
      ).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_APPROVAL_REQUIRED' });
    }
    expect(resolveHost).not.toHaveBeenCalled();
    expect(factory.pages).toHaveLength(0);
  });

  it('创建按对话隔离的无持久浏览器会话，并对提取内容脱敏和截断', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);

    const result = (await service.execute(
      {
        name: 'browser_extract',
        input: { sessionId, format: 'text' },
      },
      {
        conversationId: 'conversation-a',
        outputLimitBytes: 4_096,
        timeoutMs: 10_000,
      },
    )) as { content: string; redacted: boolean; truncated: boolean };

    expect(result.content).not.toContain('plain-secret-value');
    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(4_096);
    await expect(
      service.execute(
        { name: 'browser_screenshot', input: { sessionId, fullPage: false } },
        {
          conversationId: 'conversation-b',
          outputLimitBytes: 4_096,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
    expect(factory.pages).toHaveLength(1);
  });

  it('打开和导航时传递信号、限制超时并隐藏页面元数据中的凭据', async () => {
    const { factory, service } = browserFixture();
    const controller = new AbortController();
    const startUrl = 'https://example.com/start';
    const opened = (await service.execute(
      {
        name: 'browser_open',
        input: { url: startUrl },
      },
      {
        conversationId: 'conversation-a',
        networkNavigationApproval: { approvedUrl: startUrl },
        outputLimitBytes: 32_768,
        timeoutMs: 1,
        signal: controller.signal,
      },
    )) as { sessionId: string };
    expect(factory.pages[0]?.navigate).toHaveBeenNthCalledWith(1, {
      url: 'https://example.com/start',
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    factory.pages[0]?.navigate.mockResolvedValueOnce({
      url: 'https://user:secret@example.com/next?token=secret#private',
      title: 'api_key=title-secret',
    });
    const nextUrl = 'https://example.com/next';
    const navigated = (await service.execute(
      {
        name: 'browser_navigate',
        input: { sessionId: opened.sessionId, url: nextUrl },
      },
      {
        conversationId: 'conversation-a',
        networkNavigationApproval: { approvedUrl: nextUrl },
        outputLimitBytes: 32_768,
        timeoutMs: 90_000,
        signal: controller.signal,
      },
    )) as { title: string; url: string };

    expect(factory.pages[0]?.navigate).toHaveBeenNthCalledWith(2, {
      url: 'https://example.com/next',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(navigated.url).toBe('https://example.com/next');
    expect(navigated.title).not.toContain('title-secret');
  });

  it('导航前拒绝私网目标，且不会调用现有页面', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);

    await expect(
      service.execute(
        {
          name: 'browser_navigate',
          input: { sessionId, url: 'http://10.1.2.3/private' },
        },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'http://10.1.2.3/private' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_PRIVATE_NETWORK_DENIED' });
    expect(factory.pages[0]?.navigate).toHaveBeenCalledOnce();
  });

  it('打开页面导航失败时移除会话并关闭页面，即使关闭本身失败', async () => {
    const { factory, service } = browserFixture();
    const navigateFailure = new Error('navigation timed out');
    const page = new FakePage();
    page.navigate.mockRejectedValueOnce(navigateFailure);
    page.close.mockRejectedValueOnce(new Error('close failed'));
    vi.spyOn(factory, 'create').mockImplementationOnce(async () => {
      factory.pages.push(page);
      return page;
    });

    await expect(
      service.execute(
        { name: 'browser_open', input: { url: 'https://example.com/' } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'https://example.com/' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toBe(navigateFailure);
    expect(page.close).toHaveBeenCalledOnce();
    await expect(
      service.execute(
        {
          name: 'browser_extract',
          input: {
            sessionId: '00000000-0000-4000-8000-000000000000',
            format: 'text',
          },
        },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
  });

  it('提取时传递格式、选择器和信号，并合并页面自身的截断标记', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);
    const controller = new AbortController();
    factory.pages[0]?.extract.mockResolvedValueOnce({
      content: 'short public content',
      metadata: { url: 'not a URL', title: 'Public title' },
      truncated: true,
    });

    const result = (await service.execute(
      {
        name: 'browser_extract',
        input: { sessionId, selector: 'main article', format: 'html' },
      },
      {
        conversationId: 'conversation-a',
        outputLimitBytes: 2_000_000,
        timeoutMs: 5_000,
        signal: controller.signal,
      },
    )) as {
      content: string;
      redacted: boolean;
      truncated: boolean;
      url: string;
    };

    expect(factory.pages[0]?.extract).toHaveBeenCalledWith({
      format: 'html',
      selector: 'main article',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      content: 'short public content',
      redacted: false,
      truncated: true,
    });
    expect(result.url).not.toContain('not a URL');
  });

  it('持久化和展示浏览器地址前移除查询参数与 Fragment', async () => {
    const { service } = browserFixture();
    const result = (await service.execute(
      {
        name: 'browser_open',
        input: { url: 'https://example.com/callback?code=oauth-secret#access_token=hidden' },
      },
      {
        conversationId: 'conversation-a',
        networkNavigationApproval: {
          approvedUrl: 'https://example.com/callback?code=oauth-secret#access_token=hidden',
        },
        outputLimitBytes: 32_768,
        timeoutMs: 10_000,
      },
    )) as { url: string };

    expect(result.url).toBe('https://example.com/callback');
    expect(result.url).not.toContain('oauth-secret');
    expect(result.url).not.toContain('access_token');
    await service.dispose();
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://[::1]/admin',
    'http://localhost/admin',
    'http://user:password@example.com/',
    'file:///etc/passwd',
  ])('拒绝本机、私网、带凭据或非 HTTP(S) 地址：%s', async (url) => {
    const { service } = browserFixture();
    await expect(
      service.execute(
        { name: 'browser_open', input: { url } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: url },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/BROWSER_(?:PRIVATE_NETWORK|URL)_DENIED/u),
    });
  });

  it.each([
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://172.31.255.255/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::ffff:c0a8:101]/',
    'http://[::c0a8:101]/',
    'http://[fec0::1]/',
    'http://[64:ff9b::c0a8:101]/',
    'http://[2002:c0a8:101::]/',
    'http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/',
  ])('拒绝更多保留、链路本地和映射后的私网地址：%s', async (url) => {
    const { service } = browserFixture();
    await expect(
      service.execute(
        { name: 'browser_open', input: { url } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: url },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_PRIVATE_NETWORK_DENIED' });
  });

  it.each([
    'https://service.local/',
    'https://service.internal/',
    'https://device.home.arpa/',
    'https://metadata.google.internal/',
  ])('拒绝本地用途域名：%s', async (url) => {
    const { service } = browserFixture();
    await expect(
      service.execute(
        { name: 'browser_open', input: { url } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: url },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_PRIVATE_NETWORK_DENIED' });
  });

  it('域名无法解析到地址时 fail closed，并保留解析器错误', async () => {
    const empty = browserFixture({ resolveHost: async () => [] });
    await expect(
      empty.service.execute(
        { name: 'browser_open', input: { url: 'https://empty.example/' } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'https://empty.example/' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_PRIVATE_NETWORK_DENIED' });

    const dnsFailure = new Error('DNS unavailable');
    const failed = browserFixture({
      resolveHost: async () => {
        throw dnsFailure;
      },
    });
    await expect(
      failed.service.execute(
        { name: 'browser_open', input: { url: 'https://failed.example/' } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'https://failed.example/' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toBe(dnsFailure);
  });

  it('域名同时解析到公网和私网地址时 fail closed，并让请求拦截器复用同一规则', async () => {
    const { factory, service } = browserFixture({
      resolveHost: async (hostname) =>
        hostname === 'mixed.example' ? ['93.184.216.34', '169.254.169.254'] : ['93.184.216.34'],
    });
    await expect(
      service.execute(
        { name: 'browser_open', input: { url: 'https://mixed.example/' } },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'https://mixed.example/' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_PRIVATE_NETWORK_DENIED' });

    await openSession(service);
    await expect(factory.requestGuard?.('http://10.0.0.1/internal')).resolves.toBe(false);
    await expect(factory.requestGuard?.('https://cdn.example.com/asset.js')).resolves.toBe(true);
  });

  it('超过会话上限时关闭最久未使用的页面，保留最近活动会话', async () => {
    let now = 100;
    const { factory, service } = browserFixture({
      maximumSessions: 2,
      now: () => now,
      sessionIdleTimeoutMs: 10_000,
    });
    const first = await openSession(service, 'conversation-a');
    now = 200;
    const second = await openSession(service, 'conversation-b');
    now = 300;
    await service.execute(
      {
        name: 'browser_extract',
        input: { sessionId: first, format: 'text' },
      },
      {
        conversationId: 'conversation-a',
        outputLimitBytes: 32_768,
        timeoutMs: 10_000,
      },
    );
    now = 400;
    await openSession(service, 'conversation-c');

    expect(factory.pages[1]?.close).toHaveBeenCalledOnce();
    expect(factory.pages[0]?.close).not.toHaveBeenCalled();
    await expect(
      service.execute(
        {
          name: 'browser_extract',
          input: { sessionId: second, format: 'text' },
        },
        {
          conversationId: 'conversation-b',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
  });

  it('会清理过期会话，并在释放服务时关闭所有隔离页面', async () => {
    let now = 1_000_000;
    const { factory, service } = browserFixture({ now: () => now });
    const first = await openSession(service);
    now += 5 * 60_000 + 1;
    await openSession(service, 'conversation-b');

    expect(factory.pages[0]?.close).toHaveBeenCalledOnce();
    await expect(
      service.execute(
        { name: 'browser_extract', input: { sessionId: first, format: 'text' } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
    await service.dispose();
    expect(factory.pages[1]?.close).toHaveBeenCalledOnce();
  });

  it('清理过期页和 dispose 时吞掉单页关闭错误，并使旧会话失效', async () => {
    let now = 1_000;
    const { factory, service } = browserFixture({
      now: () => now,
      sessionIdleTimeoutMs: 100,
    });
    const first = await openSession(service);
    factory.pages[0]?.close.mockRejectedValueOnce(new Error('expired close failed'));
    now = 1_101;
    const second = await openSession(service);
    factory.pages[1]?.close.mockRejectedValueOnce(new Error('dispose close failed'));

    await expect(
      service.execute(
        { name: 'browser_extract', input: { sessionId: first, format: 'text' } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
    await expect(service.dispose()).resolves.toBeUndefined();
    await expect(
      service.execute(
        { name: 'browser_extract', input: { sessionId: second, format: 'text' } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_NOT_FOUND' });
  });

  it('截图在 Base64 编码前预留输出空间，超限时不返回损坏图片', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);
    factory.pages[0]?.screenshot.mockResolvedValueOnce({
      data: Buffer.alloc(2_000),
      height: 600,
      mimeType: 'image/jpeg',
      width: 800,
    });

    await expect(
      service.execute(
        { name: 'browser_screenshot', input: { sessionId, fullPage: false } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 4_096,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_SCREENSHOT_TOO_LARGE' });
  });

  it('返回完整截图，并向页面传递全页、信号、超时和压缩上限', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);
    const controller = new AbortController();
    factory.pages[0]?.screenshot.mockResolvedValueOnce({
      data: Buffer.from('jpeg-result'),
      height: 900,
      mimeType: 'image/jpeg',
      width: 1_200,
    });

    const result = await service.execute(
      { name: 'browser_screenshot', input: { sessionId, fullPage: true } },
      {
        conversationId: 'conversation-a',
        outputLimitBytes: 8_192,
        timeoutMs: 90_000,
        signal: controller.signal,
      },
    );

    expect(factory.pages[0]?.screenshot).toHaveBeenCalledWith({
      fullPage: true,
      maximumBytes: 3_840,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result).toEqual({
      kind: 'browser-screenshot',
      sessionId,
      mimeType: 'image/jpeg',
      width: 1_200,
      height: 900,
      bytes: 11,
      base64: Buffer.from('jpeg-result').toString('base64'),
      truncated: false,
    });
  });

  it('保留页面层的导航、提取与截图超时错误', async () => {
    const { factory, service } = browserFixture();
    const sessionId = await openSession(service);
    const timeout = new Error('page timeout');
    factory.pages[0]?.navigate.mockRejectedValueOnce(timeout);
    await expect(
      service.execute(
        {
          name: 'browser_navigate',
          input: { sessionId, url: 'https://example.com/next' },
        },
        {
          conversationId: 'conversation-a',
          networkNavigationApproval: { approvedUrl: 'https://example.com/next' },
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toBe(timeout);
    factory.pages[0]?.extract.mockRejectedValueOnce(timeout);
    await expect(
      service.execute(
        { name: 'browser_extract', input: { sessionId, format: 'text' } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toBe(timeout);
    factory.pages[0]?.screenshot.mockRejectedValueOnce(timeout);
    await expect(
      service.execute(
        { name: 'browser_screenshot', input: { sessionId, fullPage: false } },
        {
          conversationId: 'conversation-a',
          outputLimitBytes: 32_768,
          timeoutMs: 10_000,
        },
      ),
    ).rejects.toBe(timeout);
  });
});
