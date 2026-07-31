import { describe, expect, it } from 'vitest';

import {
  appSettingsSchema,
  cancelChatStreamResponseSchema,
  createApiKeyRequestSchema,
  createFileChangeRequestSchema,
  createMemberRequestSchema,
  createProviderRequestSchema,
  deleteMessageQuerySchema,
  isAllowedProviderBaseUrl,
  sendChatRequestSchema,
  updateConversationRequestSchema,
  updateMemberRequestSchema,
  updateProviderModelSelectionRequestSchema,
  updateProviderRequestSchema,
  usageQuerySchema,
} from '../src/index.js';

describe('公共契约', () => {
  it('为设置填充安全默认值', () => {
    const settings = appSettingsSchema.parse({});
    expect(settings.maxConcurrentRequests).toBe(5);
    expect(settings.contextCompressionThreshold).toBe(0.7);
    expect(settings.toolExecutionPolicy).toBe('always-ask');
    expect(settings.toolCommandTimeoutMs).toBe(60_000);
    expect(settings.toolOutputLimitBytes).toBe(131_072);
    expect(() => appSettingsSchema.parse({ toolCommandTimeoutMs: 999 })).toThrow();
    expect(() => appSettingsSchema.parse({ toolOutputLimitBytes: 2_048 })).toThrow();
  });

  it('拒绝过短的 API Key', () => {
    expect(() =>
      createApiKeyRequestSchema.parse({
        providerId: crypto.randomUUID(),
        label: 'test',
        apiKey: 'short',
      }),
    ).toThrow();
  });

  it('仅接受不携带明文凭据的 HTTP(S) 提供商和代理地址', () => {
    expect(() =>
      createProviderRequestSchema.parse({
        type: 'openai',
        name: 'Unsafe',
        baseUrl: 'file:///etc/passwd',
      }),
    ).toThrow();
    expect(() =>
      createProviderRequestSchema.parse({
        type: 'openai',
        name: 'Unsafe',
        baseUrl: 'https://user:pass@example.com/v1',
      }),
    ).toThrow();
    expect(() =>
      createProviderRequestSchema.parse({
        type: 'custom',
        name: 'Unsafe query',
        baseUrl: 'https://example.com/v1?token=fixture-value',
      }),
    ).toThrow(/查询参数/);
    expect(() =>
      createProviderRequestSchema.parse({
        type: 'openai',
        name: 'Clear text',
        baseUrl: 'http://api.example.com/v1',
      }),
    ).toThrow(/HTTPS/);
    expect(
      createProviderRequestSchema.parse({
        type: 'ollama',
        name: 'Local Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }).baseUrl,
    ).toBe('http://127.0.0.1:11434/v1');
    expect(() =>
      createProviderRequestSchema.parse({
        type: 'ollama',
        name: 'Remote clear text',
        baseUrl: 'http://192.168.1.20:11434/v1',
      }),
    ).toThrow(/回环/);
    expect(() =>
      createApiKeyRequestSchema.parse({
        providerId: crypto.randomUUID(),
        label: 'unsafe proxy',
        apiKey: 'sk-test-only',
        proxyUrl: 'https://proxy.example/path',
      }),
    ).toThrow();
  });

  it('在所有入口执行 Provider 传输安全策略', () => {
    expect(isAllowedProviderBaseUrl('openai', 'https://api.example.com/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('ollama', 'http://localhost:11434/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('ollama', 'http://127.2.3.4:11434/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('ollama', 'http://[::1]:11434/v1')).toBe(true);
    expect(isAllowedProviderBaseUrl('custom', 'http://127.0.0.1/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('ollama', 'http://192.168.1.2:11434/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', 'file:///tmp/provider')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', 'not-a-url')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', `https://example.com/${'x'.repeat(4096)}`)).toBe(
      false,
    );
    expect(isAllowedProviderBaseUrl('openai', 'https://example.com/v1#fragment')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', 'https://user@example.com/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', 'https://:password@example.com/v1')).toBe(false);
    expect(isAllowedProviderBaseUrl('openai', 'https://example.com/v1?api_key=value')).toBe(false);

    expect(
      updateProviderRequestSchema.parse({
        type: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).toMatchObject({ type: 'ollama' });
    expect(() =>
      updateProviderRequestSchema.parse({
        type: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      updateProviderRequestSchema.parse({ baseUrl: 'http://10.0.0.2:11434/v1' }),
    ).toThrow(/回环/);
    expect(
      updateProviderRequestSchema.parse({ baseUrl: 'http://localhost:11434/v1' }),
    ).toMatchObject({ baseUrl: expect.stringContaining('localhost') });
    expect(updateProviderRequestSchema.parse({ name: 'Renamed', enabled: false })).toEqual({
      name: 'Renamed',
      enabled: false,
    });
  });

  it('校验服务商启用模型集合的数量、身份和唯一性', () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(
      updateProviderModelSelectionRequestSchema.parse({ enabledModelIds: [first, second] }),
    ).toEqual({ enabledModelIds: [first, second] });
    expect(() =>
      updateProviderModelSelectionRequestSchema.parse({ enabledModelIds: [first, first] }),
    ).toThrow(/重复/);
    expect(() =>
      updateProviderModelSelectionRequestSchema.parse({ enabledModelIds: ['not-an-id'] }),
    ).toThrow();
  });

  it('校验团队成员创建与更新输入', () => {
    expect(
      createMemberRequestSchema.parse({
        email: 'member@example.com',
        displayName: 'Member',
        password: 'correct horse battery staple',
        role: 'member',
      }).role,
    ).toBe('member');
    expect(() =>
      createMemberRequestSchema.parse({
        email: 'owner@example.com',
        displayName: 'Owner 2',
        password: 'correct horse battery staple',
        role: 'owner',
      }),
    ).toThrow();
    expect(() => updateMemberRequestSchema.parse({})).toThrow();
  });

  it('解析聊天、Skill、上下文提及与用量查询', () => {
    const userMessageId = crypto.randomUUID();
    const cancellationId = crypto.randomUUID();
    const chat = sendChatRequestSchema.parse({
      userMessageId,
      cancellationId,
      messages: [{ role: 'user', content: 'hello' }],
      skill: '@code-review',
      contextMentions: ['@web:https://example.com/docs'],
    });
    expect(chat.stream).toBe(true);
    expect(chat.userMessageId).toBe(userMessageId);
    expect(chat.cancellationId).toBe(cancellationId);
    expect(chat.skill).toBe('@code-review');
    expect(chat.contextMentions).toEqual(['@web:https://example.com/docs']);
    expect(() =>
      sendChatRequestSchema.parse({
        userMessageId: 'not-a-uuid',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).toThrow();
    expect(() =>
      sendChatRequestSchema.parse({
        userMessageId,
        messages: [{ role: 'assistant', content: 'not a user input' }],
      }),
    ).toThrow(/userMessageId/);
    expect(() =>
      sendChatRequestSchema.parse({
        cancellationId,
        stream: false,
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).toThrow(/cancellationId/);
    expect(() =>
      sendChatRequestSchema.parse({
        messages: [{ role: 'user', content: 'test' }],
        contextMentions: ['https://example.com'],
      }),
    ).toThrow();
    expect(cancelChatStreamResponseSchema.parse({ cancellationId, settled: true })).toEqual({
      cancellationId,
      settled: true,
    });
    expect(usageQuerySchema.parse({}).groupBy).toBe('day');
  });

  it('消息删除要求完整的并发快照前置条件', () => {
    const expectedTailMessageId = crypto.randomUUID();
    expect(
      deleteMessageQuerySchema.parse({
        expectedMessageCount: '2',
        expectedTailMessageId,
      }),
    ).toEqual({ expectedMessageCount: 2, expectedTailMessageId });
    expect(() => deleteMessageQuerySchema.parse({ expectedMessageCount: 2 })).toThrow();
    expect(() =>
      deleteMessageQuerySchema.parse({
        expectedMessageCount: 2,
        expectedTailMessageId: 'not-a-message-id',
      }),
    ).toThrow();
  });

  it('拒绝空会话更新和逃逸工作区的文件变更路径', () => {
    expect(updateConversationRequestSchema.parse({ pinned: true })).toEqual({ pinned: true });
    expect(() => updateConversationRequestSchema.parse({})).toThrow(/更新字段/);
    expect(
      createFileChangeRequestSchema.parse({
        path: 'src/features/example.ts',
        diff: '+export const ready = true;',
      }).path,
    ).toBe('src/features/example.ts');
    for (const path of ['/etc/passwd', 'C:\\Windows\\system.ini', 'src/../secret.txt']) {
      expect(() =>
        createFileChangeRequestSchema.parse({
          path,
          diff: '+blocked',
        }),
      ).toThrow();
    }
  });
});
