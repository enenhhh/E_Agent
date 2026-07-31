import type { FileChange, Message, ToolCall } from '../../types';

import type { ToolActivityOrderEntry } from './tool-activity-types';

export interface MessageTimelineItem {
  aggregatedToolActivity?: boolean;
  groupedToolMessages?: Message[];
  key: string;
  message: Message;
  sourceIndex: number;
  toolActivityOrder?: ToolActivityOrderEntry[];
}

function hasToolActivity(message: Message): boolean {
  return Boolean(message.toolCalls?.length || message.fileChanges?.length);
}

function hasVisibleMessageContent(message: Message): boolean {
  return Boolean(
    message.content.trim() ||
      message.reasoning?.trim() ||
      message.status === 'pending' ||
      message.status === 'streaming' ||
      message.status === 'failed' ||
      message.status === 'cancelled' ||
      message.feedback,
  );
}

function mergeById<T extends { id: string }>(groups: T[][]): T[] {
  const merged: T[] = [];
  const positions = new Map<string, number>();

  for (const group of groups) {
    for (const item of group) {
      const position = positions.get(item.id);
      if (position === undefined) {
        positions.set(item.id, merged.length);
        merged.push(item);
      } else {
        merged[position] = item;
      }
    }
  }
  return merged;
}

function sumOptionalValues(
  messages: Message[],
  field: 'inputTokens' | 'latencyMs' | 'outputTokens',
): number | undefined {
  const values = messages.flatMap((message) =>
    typeof message[field] === 'number' ? [message[field]] : [],
  );
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

function withoutToolActivity(message: Message): Message {
  return {
    ...message,
    fileChanges: undefined,
    inputTokens: undefined,
    latencyMs: undefined,
    outputTokens: undefined,
    toolCalls: undefined,
  };
}

function buildToolActivityOrder(messages: Message[]): ToolActivityOrderEntry[] {
  const entries: ToolActivityOrderEntry[] = [];
  const seenToolCallIds = new Set<string>();
  const seenToolMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        if (seenToolCallIds.has(toolCall.id)) continue;
        seenToolCallIds.add(toolCall.id);
        entries.push({ id: toolCall.id, kind: 'tool-call' });
      }
    } else if (message.role === 'tool' && !seenToolMessageIds.has(message.id)) {
      seenToolMessageIds.add(message.id);
      entries.push({ id: message.id, kind: 'tool-message' });
    }
  }
  return entries;
}

/**
 * 将桌面 Agent 多轮持久化的 assistant 工具消息恢复为一个视觉工具组。
 * 保留真实消息 ID，避免删除、重试、分支等操作指向不存在的合成消息。
 */
export function buildMessageTimeline(messages: Message[]): MessageTimelineItem[] {
  const timeline: MessageTimelineItem[] = [];

  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!message) break;
    if (message.role !== 'assistant' || !hasToolActivity(message)) {
      timeline.push({ key: message.id, message, sourceIndex: index });
      index += 1;
      continue;
    }

    const activityIndexes = [index];
    let cursor = index + 1;

    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (!candidate) break;
      if (candidate.role === 'tool') {
        cursor += 1;
        continue;
      }
      if (candidate.role !== 'assistant') break;
      if (hasToolActivity(candidate)) {
        activityIndexes.push(cursor);
        cursor += 1;
        continue;
      }
      if (candidate.content.trim()) break;
      cursor += 1;
    }

    const activityMessages = activityIndexes.map((activityIndex) => messages[activityIndex]!);
    const toolCalls = mergeById<ToolCall>(
      activityMessages.map((activityMessage) => activityMessage.toolCalls ?? []),
    );
    const fileChanges = mergeById<FileChange>(
      activityMessages.map((activityMessage) => activityMessage.fileChanges ?? []),
    );
    const groupedMessages = messages.slice(index, cursor);
    const groupedToolMessages = groupedMessages.filter((candidate) => candidate.role === 'tool');

    if (toolCalls.length < 3 || (activityIndexes.length < 2 && groupedToolMessages.length === 0)) {
      timeline.push({ key: message.id, message, sourceIndex: index });
      index += 1;
      continue;
    }

    const anchorIndex = activityIndexes.at(-1) ?? index;
    const activityIndexSet = new Set(activityIndexes);
    const toolActivityOrder = buildToolActivityOrder(groupedMessages);
    const hasActiveActivity =
      toolCalls.some((toolCall) =>
        ['approval-required', 'pending', 'running'].includes(toolCall.status),
      ) || fileChanges.some((change) => change.status === 'pending');

    for (let groupedIndex = index; groupedIndex < cursor; groupedIndex += 1) {
      const groupedMessage = messages[groupedIndex];
      if (!groupedMessage) continue;
      if (groupedMessage.role === 'tool') continue;
      if (!activityIndexSet.has(groupedIndex)) {
        timeline.push({
          aggregatedToolActivity: true,
          key: groupedMessage.id,
          message: groupedMessage,
          sourceIndex: groupedIndex,
        });
        continue;
      }

      if (groupedIndex === anchorIndex) {
        const aggregatedMessage: Message = {
          ...groupedMessage,
          fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
          inputTokens: sumOptionalValues(activityMessages, 'inputTokens'),
          latencyMs: sumOptionalValues(activityMessages, 'latencyMs'),
          outputTokens: sumOptionalValues(activityMessages, 'outputTokens'),
          toolCalls,
        };

        if (groupedMessage.content.trim()) {
          timeline.push({
            aggregatedToolActivity: hasActiveActivity || undefined,
            key: groupedMessage.id,
            message: withoutToolActivity(groupedMessage),
            sourceIndex: groupedIndex,
          });
          timeline.push({
            aggregatedToolActivity: true,
            groupedToolMessages,
            key: `${groupedMessage.id}:tool-activity`,
            message: {
              ...aggregatedMessage,
              content: '',
              feedback: null,
              reasoning: undefined,
              reasoningDurationMs: undefined,
            },
            sourceIndex: groupedIndex,
            toolActivityOrder,
          });
          continue;
        }

        timeline.push({
          aggregatedToolActivity: true,
          groupedToolMessages,
          key: groupedMessage.id,
          message: aggregatedMessage,
          sourceIndex: groupedIndex,
          toolActivityOrder,
        });
        continue;
      }

      const presentationalMessage = withoutToolActivity(groupedMessage);
      if (hasVisibleMessageContent(presentationalMessage)) {
        timeline.push({
          aggregatedToolActivity: true,
          key: groupedMessage.id,
          message: presentationalMessage,
          sourceIndex: groupedIndex,
        });
      }
    }

    index = cursor;
  }

  return timeline;
}
