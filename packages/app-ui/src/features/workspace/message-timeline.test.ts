import { describe, expect, it } from 'vitest';

import type { Message, ToolCall } from '../../types';

import { buildMessageTimeline } from './message-timeline';

function toolCall(id: string): ToolCall {
  return {
    arguments: '{}',
    id,
    name: 'workspace_run_command',
    status: 'completed',
  };
}

function message(id: string, role: Message['role'], input: Partial<Message> = {}): Message {
  return {
    content: '',
    conversationId: 'conversation-1',
    createdAt: `2026-07-31T08:00:${id.padStart(2, '0')}.000Z`,
    id,
    role,
    status: 'completed',
    ...input,
  };
}

describe('buildMessageTimeline', () => {
  it('把刷新后拆开的多轮 assistant 工具消息合并到最后一条真实消息', () => {
    const messages = [
      message('1', 'user', { content: '完成这个任务' }),
      message('2', 'assistant', {
        inputTokens: 10,
        outputTokens: 2,
        toolCalls: [toolCall('tool-1')],
      }),
      message('3', 'assistant', {
        inputTokens: 12,
        outputTokens: 3,
        toolCalls: [toolCall('tool-2')],
      }),
      message('4', 'assistant', {
        inputTokens: 14,
        outputTokens: 4,
        toolCalls: [toolCall('tool-3')],
      }),
      message('5', 'assistant', { content: '任务已完成。' }),
    ];

    const timeline = buildMessageTimeline(messages);

    expect(timeline.map((item) => item.message.id)).toEqual(['1', '4', '5']);
    expect(timeline[1]?.message.toolCalls?.map((tool) => tool.id)).toEqual([
      'tool-1',
      'tool-2',
      'tool-3',
    ]);
    expect(timeline[1]?.message.inputTokens).toBe(36);
    expect(timeline[1]?.message.outputTokens).toBe(9);
    expect(timeline[1]?.sourceIndex).toBe(3);
    expect(timeline[1]?.aggregatedToolActivity).toBe(true);
    expect(timeline[2]?.message.content).toBe('任务已完成。');
  });

  it('reasoning 和工具前说明不断组，且保持原有显示顺序', () => {
    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '分析并修改' }),
      message('2', 'assistant', {
        content: '我先读取项目。',
        toolCalls: [toolCall('tool-1')],
      }),
      message('3', 'assistant', { reasoning: '需要检查第二个文件。' }),
      message('4', 'assistant', {
        toolCalls: [toolCall('tool-2'), toolCall('tool-3')],
      }),
      message('5', 'assistant', { content: '修改完成。' }),
    ]);

    expect(timeline.map((item) => item.message.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(timeline[1]?.message.content).toBe('我先读取项目。');
    expect(timeline[1]?.message.toolCalls).toBeUndefined();
    expect(timeline[1]?.aggregatedToolActivity).toBe(true);
    expect(timeline[2]?.message.reasoning).toBe('需要检查第二个文件。');
    expect(timeline[2]?.aggregatedToolActivity).toBe(true);
    expect(timeline[3]?.message.toolCalls).toHaveLength(3);
    expect(timeline[4]?.message.content).toBe('修改完成。');
  });

  it('锚点同时含正文时拆成可操作正文和无消息动作的工具块', () => {
    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '执行任务' }),
      message('2', 'assistant', { toolCalls: [toolCall('tool-1')] }),
      message('3', 'assistant', {
        content: '最后一轮工具说明。',
        toolCalls: [toolCall('tool-2'), toolCall('tool-3')],
      }),
    ]);

    expect(timeline.map((item) => item.key)).toEqual(['1', '3', '3:tool-activity']);
    expect(timeline[1]?.message.id).toBe('3');
    expect(timeline[1]?.message.content).toBe('最后一轮工具说明。');
    expect(timeline[1]?.message.toolCalls).toBeUndefined();
    expect(timeline[1]?.aggregatedToolActivity).toBeUndefined();
    expect(timeline[2]?.message.id).toBe('3');
    expect(timeline[2]?.message.content).toBe('');
    expect(timeline[2]?.message.toolCalls).toHaveLength(3);
    expect(timeline[2]?.aggregatedToolActivity).toBe(true);
  });

  it('新的用户消息会切断聚合边界', () => {
    const messages = [
      message('1', 'user', { content: '第一轮' }),
      message('2', 'assistant', { toolCalls: [toolCall('tool-1')] }),
      message('3', 'assistant', { toolCalls: [toolCall('tool-2')] }),
      message('4', 'user', { content: '第二轮' }),
      message('5', 'assistant', { toolCalls: [toolCall('tool-3')] }),
      message('6', 'assistant', { toolCalls: [toolCall('tool-4')] }),
    ];

    const timeline = buildMessageTimeline(messages);

    expect(timeline).toHaveLength(messages.length);
    expect(timeline[1]?.message.toolCalls).toHaveLength(1);
    expect(timeline[2]?.message.toolCalls).toHaveLength(1);
    expect(timeline[4]?.message.toolCalls).toHaveLength(1);
    expect(timeline[5]?.message.toolCalls).toHaveLength(1);
  });

  it('非空 assistant 正文和 system 消息都是硬边界', () => {
    const withAssistantBoundary = buildMessageTimeline([
      message('1', 'user', { content: '第一轮' }),
      message('2', 'assistant', { toolCalls: [toolCall('tool-1')] }),
      message('3', 'assistant', { toolCalls: [toolCall('tool-2')] }),
      message('4', 'assistant', { content: '阶段结论。' }),
      message('5', 'assistant', { toolCalls: [toolCall('tool-3')] }),
    ]);
    const withSystemBoundary = buildMessageTimeline([
      message('1', 'user', { content: '第一轮' }),
      message('2', 'assistant', { toolCalls: [toolCall('tool-1')] }),
      message('3', 'assistant', { toolCalls: [toolCall('tool-2')] }),
      message('4', 'system', { content: '系统边界' }),
      message('5', 'assistant', { toolCalls: [toolCall('tool-3')] }),
    ]);

    expect(withAssistantBoundary).toHaveLength(5);
    expect(withSystemBoundary).toHaveLength(5);
    expect(withAssistantBoundary.filter((item) => item.message.toolCalls?.length)).toHaveLength(3);
    expect(withSystemBoundary.filter((item) => item.message.toolCalls?.length)).toHaveLength(3);
  });

  it('按 ID 去重并保留工具和文件变更的最后状态', () => {
    const pendingTool = { ...toolCall('tool-1'), status: 'pending' as const };
    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '执行任务' }),
      message('2', 'assistant', {
        fileChanges: [
          {
            diff: 'pending',
            id: 'change-1',
            path: 'src/index.ts',
            status: 'pending',
          },
        ],
        toolCalls: [pendingTool],
      }),
      message('3', 'assistant', {
        toolCalls: [toolCall('tool-1'), toolCall('tool-2')],
      }),
      message('4', 'assistant', {
        fileChanges: [
          {
            diff: 'accepted',
            id: 'change-1',
            path: 'src/index.ts',
            status: 'accepted',
          },
        ],
        toolCalls: [toolCall('tool-3')],
      }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.message.toolCalls).toHaveLength(3);
    expect(timeline[1]?.message.toolCalls?.find((item) => item.id === 'tool-1')?.status).toBe(
      'completed',
    );
    expect(timeline[1]?.message.fileChanges).toEqual([
      {
        diff: 'accepted',
        id: 'change-1',
        path: 'src/index.ts',
        status: 'accepted',
      },
    ]);
  });

  it('重复记录不足三个唯一工具时不触发跨消息聚合', () => {
    const messages = [
      message('1', 'user', { content: '执行任务' }),
      message('2', 'assistant', {
        toolCalls: [{ ...toolCall('tool-1'), status: 'pending' as const }],
      }),
      message('3', 'assistant', {
        toolCalls: [toolCall('tool-1'), toolCall('tool-2')],
      }),
    ];

    const timeline = buildMessageTimeline(messages);
    expect(timeline).toHaveLength(messages.length);
    expect(timeline[1]?.message.toolCalls?.[0]?.status).toBe('pending');
  });

  it('把 role=tool 的结果消息收进连续工具组', () => {
    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '执行任务' }),
      message('2', 'assistant', { toolCalls: [toolCall('tool-1')] }),
      message('3', 'tool', { content: '第一步输出' }),
      message('4', 'assistant', {
        toolCalls: [toolCall('tool-2'), toolCall('tool-3')],
      }),
      message('5', 'assistant', { content: '全部完成。' }),
    ]);

    expect(timeline.map((item) => item.message.id)).toEqual(['1', '4', '5']);
    expect(timeline[1]?.groupedToolMessages?.map((item) => item.id)).toEqual(['3']);
    expect(timeline[1]?.groupedToolMessages?.[0]?.content).toBe('第一步输出');
    expect(timeline[1]?.message.toolCalls).toHaveLength(3);
    expect(timeline[1]?.aggregatedToolActivity).toBe(true);
    expect(timeline[1]?.toolActivityOrder).toEqual([
      { id: 'tool-1', kind: 'tool-call' },
      { id: '3', kind: 'tool-message' },
      { id: 'tool-2', kind: 'tool-call' },
      { id: 'tool-3', kind: 'tool-call' },
    ]);
  });

  it('单条 assistant 并行调用三个工具时也会收纳后续 tool 结果', () => {
    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '并行执行任务' }),
      message('2', 'assistant', {
        toolCalls: [toolCall('tool-1'), toolCall('tool-2'), toolCall('tool-3')],
      }),
      message('3', 'tool', { content: '结果一' }),
      message('4', 'tool', { content: '结果二' }),
      message('5', 'assistant', { content: '全部完成。' }),
    ]);

    expect(timeline.map((item) => item.message.id)).toEqual(['1', '2', '5']);
    expect(timeline[1]?.groupedToolMessages?.map((item) => item.id)).toEqual(['3', '4']);
    expect(timeline[1]?.toolActivityOrder).toEqual([
      { id: 'tool-1', kind: 'tool-call' },
      { id: 'tool-2', kind: 'tool-call' },
      { id: 'tool-3', kind: 'tool-call' },
      { id: '3', kind: 'tool-message' },
      { id: '4', kind: 'tool-message' },
    ]);
  });

  it('流式阶段已经聚合在单条消息中的工具保持原消息 ID', () => {
    const streamingMessage = message('2', 'assistant', {
      status: 'streaming',
      toolCalls: Array.from({ length: 8 }, (_, index) => toolCall(`tool-${index}`)),
    });

    const timeline = buildMessageTimeline([
      message('1', 'user', { content: '执行任务' }),
      streamingMessage,
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.message).toBe(streamingMessage);
    expect(timeline[1]?.message.toolCalls).toHaveLength(8);
  });
});
