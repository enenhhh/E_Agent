import { describe, expect, it } from 'vitest';

import {
  applicationInvokeSchemas,
  applicationStreamSchemas,
  streamStartSchema,
} from './application-ipc.js';
import { desktopInvokeSchemas } from './ipc.js';

describe('桌面 IPC schema', () => {
  it('拒绝业务通道中的未知字段', () => {
    expect(() =>
      applicationInvokeSchemas['auth:login'].parse({
        email: 'developer@example.com',
        password: 'password',
        role: 'owner',
        active: true,
      }),
    ).toThrow();
  });

  it('严格校验服务商 CRUD，并允许 Key 通过 providerId 关联', () => {
    expect(
      applicationInvokeSchemas['providers:create'].parse({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://api.example.com/v1',
        keyStrategy: 'round-robin',
        enabled: true,
      }),
    ).toMatchObject({ name: 'Gateway' });
    expect(
      applicationInvokeSchemas['providers:update'].parse({
        id: 'provider-1',
        input: { name: 'Gateway Updated', enabled: false },
      }),
    ).toMatchObject({ input: { enabled: false } });
    expect(
      applicationInvokeSchemas['credentials:create'].parse({
        name: 'Primary',
        providerId: 'provider-1',
        apiKey: 'secret-value',
        strategy: 'round-robin',
        priority: 1,
      }),
    ).toMatchObject({ providerId: 'provider-1' });
    expect(() =>
      applicationInvokeSchemas['credentials:create'].parse({
        name: 'Orphan',
        apiKey: 'secret-value',
        strategy: 'round-robin',
        priority: 1,
      }),
    ).toThrow(/服务商/);
  });

  it('严格校验定向模型发现与服务商启用模型集合', () => {
    const providerId = crypto.randomUUID();
    const firstModelId = crypto.randomUUID();
    expect(
      applicationInvokeSchemas['models:discover'].parse({
        providerId,
      }),
    ).toEqual({ providerId });
    expect(
      applicationInvokeSchemas['models:update-provider-selection'].parse({
        providerId,
        enabledModelIds: [firstModelId],
      }),
    ).toEqual({
      providerId,
      enabledModelIds: [firstModelId],
    });
    expect(() =>
      applicationInvokeSchemas['models:update-provider-selection'].parse({
        providerId,
        enabledModelIds: [firstModelId, firstModelId],
      }),
    ).toThrow(/重复/);
  });

  it('只允许通过受控 ID 定向读取单个会话摘要', () => {
    expect(applicationInvokeSchemas['conversations:get'].parse({ id: 'conversation-1' })).toEqual({
      id: 'conversation-1',
    });
    expect(() =>
      applicationInvokeSchemas['conversations:get'].parse({
        id: 'conversation-1',
        includeMessages: true,
      }),
    ).toThrow();
    expect(() => applicationInvokeSchemas['conversations:get'].parse({ id: '' })).toThrow();
  });

  it('拒绝工作区绝对路径', () => {
    expect(() =>
      desktopInvokeSchemas['workspace:read'].parse({
        path: 'C:\\Windows\\system.ini',
      }),
    ).toThrow(/相对路径/);
  });

  it('只接受声明的聊天流通道', () => {
    expect(() =>
      streamStartSchema.parse({
        streamId: crypto.randomUUID(),
        channel: 'shell:stream',
        payload: {},
      }),
    ).toThrow();
  });

  it('把聊天上下文提及限制为严格格式且最多 32 个', () => {
    const userMessageId = crypto.randomUUID();
    const base = {
      conversationId: crypto.randomUUID(),
      userMessageId,
      content: 'hello',
      model: 'model',
    };
    expect(() =>
      applicationStreamSchemas['chat:stream'].parse({
        ...base,
        contextMentions: ['not-a-mention'],
      }),
    ).toThrow();
    expect(() =>
      applicationStreamSchemas['chat:stream'].parse({
        ...base,
        contextMentions: Array.from({ length: 33 }, (_, index) => `@file:file-${index}.ts`),
      }),
    ).toThrow();
    expect(
      applicationStreamSchemas['chat:stream'].parse({
        ...base,
        contextMentions: ['@file:src/index.ts', '@web:https://example.com'],
      }).contextMentions,
    ).toHaveLength(2);
    expect(
      applicationStreamSchemas['chat:stream'].parse({
        ...base,
        contextMentions: [],
      }).userMessageId,
    ).toBe(userMessageId);
    expect(() =>
      applicationStreamSchemas['chat:stream'].parse({
        ...base,
        userMessageId: 'temporary-message',
        contextMentions: [],
      }),
    ).toThrow();
  });

  it('删除消息必须携带同一快照的数量与尾消息标识', () => {
    const input = {
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      expectedMessageCount: 2,
      expectedTailMessageId: crypto.randomUUID(),
    };
    expect(applicationInvokeSchemas['messages:delete'].parse(input)).toEqual(input);
    expect(() =>
      applicationInvokeSchemas['messages:delete'].parse({
        conversationId: input.conversationId,
        messageId: input.messageId,
      }),
    ).toThrow();
  });

  it('严格校验 Workflow IPC 定义', () => {
    const workflow = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.review',
      name: 'Review',
      steps: [
        {
          id: 'review-1',
          skillId: 'com.eagent.code-review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
      ],
    };
    expect(applicationInvokeSchemas['workflows:save'].parse({ workflow }).workflow).toEqual(
      workflow,
    );
    expect(() =>
      applicationInvokeSchemas['workflows:save'].parse({
        workflow: { ...workflow, arbitrary: true },
      }),
    ).toThrow();
  });

  it('工具审批只接受会话、调用标识和明确决定', () => {
    const input = {
      conversationId: crypto.randomUUID(),
      toolCallId: 'call_workspace_run_command_1',
      decision: 'approve' as const,
    };
    expect(applicationInvokeSchemas['tools:decide'].parse(input)).toEqual(input);
    expect(() =>
      applicationInvokeSchemas['tools:decide'].parse({
        ...input,
        decision: 'accept',
      }),
    ).toThrow();
    expect(() =>
      applicationInvokeSchemas['tools:decide'].parse({
        ...input,
        executable: 'node',
        args: ['untrusted.js'],
      }),
    ).toThrow();
  });

  it('工具审批与续写统一接受最长 256 字符的工具调用标识', () => {
    const conversationId = crypto.randomUUID();
    const maximumIdentifier = 't'.repeat(256);
    expect(
      applicationInvokeSchemas['tools:decide'].parse({
        conversationId,
        toolCallId: maximumIdentifier,
        decision: 'approve',
      }).toolCallId,
    ).toBe(maximumIdentifier);
    expect(
      applicationStreamSchemas['chat:stream'].parse({
        conversationId,
        content: '',
        model: 'model',
        continuationToolCallId: maximumIdentifier,
        contextMentions: [],
      }).continuationToolCallId,
    ).toBe(maximumIdentifier);
    expect(() =>
      applicationStreamSchemas['chat:stream'].parse({
        conversationId,
        content: '',
        model: 'model',
        continuationToolCallId: 't'.repeat(257),
        contextMentions: [],
      }),
    ).toThrow();
  });

  it('严格区分 stdio 与 Streamable HTTP MCP 配置', () => {
    expect(
      applicationInvokeSchemas['mcp:save'].parse({
        displayName: 'Local tools',
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        inheritEnv: false,
      }),
    ).toEqual({
      displayName: 'Local tools',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      inheritEnv: false,
    });
    expect(
      applicationInvokeSchemas['mcp:save'].parse({
        id: 'remote.search',
        displayName: 'Remote search',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
      }),
    ).toEqual({
      id: 'remote.search',
      displayName: 'Remote search',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
    });
    expect(() =>
      applicationInvokeSchemas['mcp:save'].parse({
        displayName: 'Mixed config',
        transport: 'stdio',
        command: 'node',
        url: 'https://mcp.example.com/mcp',
      }),
    ).toThrow();
  });
});
