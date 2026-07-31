import { describe, expect, it, vi } from 'vitest';

import { DesktopContextResolver } from './context-resolver.js';

function workspaceStub() {
  return {
    read: vi.fn(async (path: string) => ({
      path,
      content: 'export const answer = 42;',
      size: 25,
      hash: 'hash',
      modifiedAt: new Date(0).toISOString(),
    })),
    list: vi.fn(async () => [
      {
        path: 'src',
        name: 'src',
        type: 'directory' as const,
        children: [
          {
            path: 'src/main.ts',
            name: 'main.ts',
            type: 'file' as const,
            size: 25,
          },
        ],
      },
    ]),
  };
}

describe('DesktopContextResolver', () => {
  it('通过工作区沙箱解析文件和目录提及', async () => {
    const workspace = workspaceStub();
    const resolver = new DesktopContextResolver({
      workspace: workspace as never,
    });
    const messages = await resolver.resolve(['@file:src/main.ts', '@folder:"src"']);

    expect(workspace.read).toHaveBeenCalledWith('src/main.ts', 300_000);
    expect(workspace.list).toHaveBeenCalledWith('src', 3);
    expect(messages.every((message) => message.role === 'user')).toBe(true);
    expect(messages[0]?.content).toContain('[untrusted-context:file');
    expect(messages[1]?.content).toContain('[untrusted-context:folder');
    expect(messages[0]?.content).toContain('answer = 42');
    expect(messages[1]?.content).toContain('main.ts');
  });

  it('对非 HTTPS 网页提及返回明确限制错误', async () => {
    const resolver = new DesktopContextResolver({
      workspace: workspaceStub() as never,
    });
    await expect(resolver.resolve(['@web:http://example.com'])).rejects.toMatchObject({
      code: 'WEB_CONTEXT_RESTRICTED',
    });
  });

  it('拒绝回环地址，避免网页上下文访问本机服务', async () => {
    const fetchImplementation = vi.fn();
    const resolver = new DesktopContextResolver({
      workspace: workspaceStub() as never,
      fetchImplementation,
    });
    await expect(resolver.resolve(['@web:https://127.0.0.1/private'])).rejects.toMatchObject({
      code: 'WEB_CONTEXT_PRIVATE_HOST',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('去重提及，并拒绝无效格式和已经取消的请求', async () => {
    const workspace = workspaceStub();
    const resolver = new DesktopContextResolver({ workspace: workspace as never });
    await expect(
      resolver.resolve(['@file:src/main.ts', '@file:src/main.ts']),
    ).resolves.toHaveLength(1);
    expect(workspace.read).toHaveBeenCalledOnce();
    await expect(resolver.resolve(['@folder:   '])).rejects.toMatchObject({
      code: 'CONTEXT_MENTION_INVALID',
    });
    await expect(resolver.resolve(['plain text'])).rejects.toMatchObject({
      code: 'CONTEXT_MENTION_INVALID',
    });

    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    await expect(resolver.resolve(['@file:src/main.ts'], controller.signal)).rejects.toThrow(
      'cancelled by test',
    );
    const emptyReason = new AbortController();
    emptyReason.abort();
    await expect(resolver.resolve(['@file:src/main.ts'], emptyReason.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
  });

  it('读取公网 HTML、清理脚本与实体，并支持有限重定向', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://8.8.4.4/article' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          '<style>.hidden{}</style><script>alert(1)</script><h1>Hello&nbsp;&amp;&lt;&gt;&quot;&#39;</h1>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
      );
    const resolver = new DesktopContextResolver({
      workspace: workspaceStub() as never,
      fetchImplementation,
    });

    const [message] = await resolver.resolve(['@web:https://8.8.8.8/start']);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(message?.content).toContain('https://8.8.4.4/article');
    expect(message?.content).toContain(`Hello &<>"'`);
    expect(message?.content).not.toContain('alert(1)');
  });

  it('拒绝凭据 URL、私有主机、DNS 失败和异常响应', async () => {
    const resolver = new DesktopContextResolver({
      workspace: workspaceStub() as never,
      fetchImplementation: vi.fn(),
    });
    await expect(resolver.resolve(['@web:not-a-url'])).rejects.toMatchObject({
      code: 'WEB_CONTEXT_URL_INVALID',
    });
    await expect(resolver.resolve(['@web:https://user:pass@8.8.8.8/'])).rejects.toMatchObject({
      code: 'WEB_CONTEXT_RESTRICTED',
    });
    await expect(resolver.resolve(['@web:https://8.8.8.8:8443/'])).rejects.toMatchObject({
      code: 'WEB_CONTEXT_RESTRICTED',
    });
    for (const host of [
      'localhost',
      'service.local',
      'service.internal',
      '10.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
    ]) {
      await expect(resolver.resolve([`@web:https://${host}/`])).rejects.toMatchObject({
        code: 'WEB_CONTEXT_PRIVATE_HOST',
      });
    }
    await expect(
      resolver.resolve(['@web:https://definitely-missing-host.invalid/']),
    ).rejects.toMatchObject({ code: 'WEB_CONTEXT_DNS_FAILED' });
  });

  it('规范化网络、状态码、类型、长度和重定向错误', async () => {
    const resolveWith = async (response: Response | Error) => {
      const fetchImplementation =
        response instanceof Error
          ? vi.fn<typeof fetch>().mockRejectedValue(response)
          : vi.fn<typeof fetch>().mockResolvedValue(response);
      return new DesktopContextResolver({
        workspace: workspaceStub() as never,
        fetchImplementation,
      }).resolve(['@web:https://8.8.8.8/resource']);
    };

    await expect(resolveWith(new Error('offline'))).rejects.toMatchObject({
      code: 'WEB_CONTEXT_FAILED',
    });
    await expect(resolveWith(new Response('no', { status: 503 }))).rejects.toMatchObject({
      code: 'WEB_CONTEXT_FAILED',
    });
    await expect(
      resolveWith(
        new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }),
      ),
    ).rejects.toMatchObject({ code: 'WEB_CONTEXT_UNSUPPORTED' });
    await expect(
      resolveWith(
        new Response('compressed', {
          headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WEB_CONTEXT_UNSUPPORTED' });
    await expect(
      resolveWith(
        new Response('small', {
          headers: { 'content-type': 'text/plain', 'content-length': String(512 * 1024 + 1) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WEB_CONTEXT_TOO_LARGE' });
    await expect(
      resolveWith(
        new Response('x'.repeat(512 * 1024 + 1), {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WEB_CONTEXT_TOO_LARGE' });
    await expect(resolveWith(new Response(null, { status: 302 }))).rejects.toMatchObject({
      code: 'WEB_CONTEXT_REDIRECT',
    });
  });

  it('空响应体产生安全的空网页上下文', async () => {
    const resolver = new DesktopContextResolver({
      workspace: workspaceStub() as never,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { headers: { 'content-type': 'application/json' } })),
    });
    await expect(resolver.resolve(['@web:https://8.8.8.8/empty'])).resolves.toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('[untrusted-context:web'),
      }),
    ]);
  });
});
