import type { ConversationMessage } from '@e-agent/contracts';
import { describe, expect, it } from 'vitest';

import { composeDesktopChatMessages } from './chat-message-composer.js';

function message(
  id: string,
  role: ConversationMessage['role'],
  content: string,
): ConversationMessage {
  return {
    id,
    conversationId: '00000000-0000-4000-8000-000000000010',
    parentMessageId: null,
    role,
    content,
    reasoning: null,
    reasoningDurationMs: null,
    toolCalls: [],
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    feedback: null,
    createdAt: '2026-07-28T00:00:00.000Z',
  };
}

describe('composeDesktopChatMessages', () => {
  it('没有补充上下文时只提交本轮消息，由核心服务自动加载历史', () => {
    expect(
      composeDesktopChatMessages({
        history: [message('00000000-0000-4000-8000-000000000001', 'user', '旧问题')],
        supplemental: [],
        userContent: '新问题',
      }),
    ).toEqual([{ role: 'user', content: '新问题' }]);
  });

  it('注入上下文或 Skill 时显式保留完整会话历史', () => {
    expect(
      composeDesktopChatMessages({
        history: [
          message('00000000-0000-4000-8000-000000000001', 'user', '旧问题'),
          message('00000000-0000-4000-8000-000000000002', 'assistant', '旧回答'),
        ],
        supplemental: [{ role: 'system', content: 'Skill 指令' }],
        userContent: '新问题',
      }),
    ).toEqual([
      { role: 'system', content: 'Skill 指令' },
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '新问题' },
    ]);
  });
});
