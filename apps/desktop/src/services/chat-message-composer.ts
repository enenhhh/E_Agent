import type { ChatMessageInput, ConversationMessage } from '@e-agent/contracts';

/**
 * 组合桌面端聊天请求。
 *
 * 核心聊天服务会为“仅包含本轮用户消息”的请求自动补齐历史；一旦桌面端注入
 * 上下文或 Skill 系统消息，就必须在这里显式带上历史，避免丢失既有对话。
 */
export function composeDesktopChatMessages(input: {
  history: readonly ConversationMessage[];
  supplemental: readonly ChatMessageInput[];
  userContent: string;
}): ChatMessageInput[] {
  const currentUserMessage: ChatMessageInput = {
    role: 'user',
    content: input.userContent,
  };
  if (input.supplemental.length === 0) {
    return [currentUserMessage];
  }
  return [
    ...input.supplemental,
    ...input.history.map(mapConversationMessageToPrompt),
    currentUserMessage,
  ];
}

function mapConversationMessageToPrompt(message: ConversationMessage): ChatMessageInput {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls.length === 0 ? {} : { toolCalls: message.toolCalls }),
    ...(message.role === 'tool' && message.parentMessageId !== null
      ? { toolCallId: message.parentMessageId }
      : {}),
  };
}
