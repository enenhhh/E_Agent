import { Fragment } from 'react';

import { FileChangePanel } from '../../components/content/FileChangePanel';
import { ToolResultCard } from '../../components/content/ToolResultCard';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';
import { useConversationStore } from '../../stores/conversation-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { FileChange, Message, ToolCall } from '../../types';

import type { ToolActivityOrderEntry } from './tool-activity-types';
import { ToolCallGroup } from './ToolCallGroup';

const GROUP_THRESHOLD = 3;

function toolMessageResult(message: Message, ordinal: number): ToolCall {
  return {
    arguments: '',
    id: `tool-message:${message.id}`,
    metadata: {
      displayName: `工具返回 #${ordinal}`,
      kind: 'provider-tool-result',
    },
    name: 'provider_tool_result',
    result: message.content,
    status:
      message.status === 'failed'
        ? 'failed'
        : message.status === 'cancelled'
          ? 'cancelled'
          : message.status === 'pending' || message.status === 'streaming'
            ? 'running'
            : 'completed',
    summary: `对应工具调用 #${ordinal} 的 Provider 原始结果`,
  };
}

export function ToolActivity({
  conversationId,
  fileChanges = [],
  onFileDecision,
  order = [],
  toolCalls = [],
  toolMessages = [],
}: {
  conversationId: string;
  fileChanges?: FileChange[];
  onFileDecision: (changeId: string, decision: 'accept' | 'reject') => void;
  order?: ToolActivityOrderEntry[];
  toolCalls?: ToolCall[];
  toolMessages?: Message[];
}): React.JSX.Element {
  const { mode, transport } = useTransport();
  const decideToolCall = useConversationStore((state) => state.decideToolCall);
  const role = useAuthStore((state) => state.session?.user.role);
  const autoExpandRunningTools = useSettingsStore((state) => state.settings.autoExpandRunningTools);
  const grouped = toolCalls.length >= GROUP_THRESHOLD;
  const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const toolCallOrdinals = new Map(toolCalls.map((toolCall, index) => [toolCall.id, index + 1]));
  const toolMessagesById = new Map(
    toolMessages.map((toolMessage) => [toolMessage.id, toolMessage]),
  );
  const orderedToolCallIds = new Set(
    order.filter((entry) => entry.kind === 'tool-call').map((entry) => entry.id),
  );
  const orderedToolMessageIds = new Set(
    order.filter((entry) => entry.kind === 'tool-message').map((entry) => entry.id),
  );
  const toolMessageOrdinals = new Map(
    toolMessages.map((toolMessage, index) => [toolMessage.id, index + 1]),
  );

  const renderToolCall = (toolCall: ToolCall): React.JSX.Element => (
    <ToolResultCard
      defaultExpanded={
        !grouped &&
        autoExpandRunningTools &&
        (toolCall.status === 'pending' || toolCall.status === 'running')
      }
      key={`tool-call:${toolCall.id}`}
      sequenceNumber={grouped ? toolCallOrdinals.get(toolCall.id) : undefined}
      {...(toolCall.status === 'approval-required' &&
      toolCall.name !== 'workspace_propose_write' &&
      mode === 'desktop' &&
      role !== 'viewer'
        ? {
            onDecision: (decision: 'approve' | 'reject') =>
              decideToolCall(transport, conversationId, toolCall.id, decision),
          }
        : toolCall.status === 'approval-required' && toolCall.name !== 'workspace_propose_write'
          ? {
              executionUnavailableReason:
                role === 'viewer'
                  ? 'Viewer 角色不能批准或拒绝工具执行。'
                  : toolCall.name === 'workspace_run_command'
                    ? '本地命令仅可在桌面端的已绑定工作区中执行。'
                    : '需要桌面端本地运行时才能批准并执行此工具调用。',
            }
          : {})}
      toolCall={toolCall}
    />
  );

  const renderToolMessage = (toolMessage: Message): React.JSX.Element => (
    <ToolResultCard
      key={`tool-message:${toolMessage.id}`}
      toolCall={toolMessageResult(toolMessage, toolMessageOrdinals.get(toolMessage.id) ?? 1)}
    />
  );

  const orderedActivity =
    order.length > 0
      ? [
          ...order.flatMap((entry) => {
            if (entry.kind === 'tool-call') {
              const toolCall = toolCallsById.get(entry.id);
              return toolCall ? [renderToolCall(toolCall)] : [];
            }
            const toolMessage = toolMessagesById.get(entry.id);
            return toolMessage ? [renderToolMessage(toolMessage)] : [];
          }),
          ...toolCalls
            .filter((toolCall) => !orderedToolCallIds.has(toolCall.id))
            .map(renderToolCall),
          ...toolMessages
            .filter((toolMessage) => !orderedToolMessageIds.has(toolMessage.id))
            .map(renderToolMessage),
        ]
      : [...toolCalls.map(renderToolCall), ...toolMessages.map(renderToolMessage)];

  const activity = (
    <Fragment>
      {orderedActivity}
      {fileChanges.map((change) => (
        <FileChangePanel
          change={change}
          key={change.id}
          {...(mode === 'desktop' && role !== 'viewer'
            ? {
                onAccept: () => onFileDecision(change.id, 'accept'),
                onReject: () => onFileDecision(change.id, 'reject'),
              }
            : {
                unavailableReason:
                  role === 'viewer'
                    ? 'Viewer 角色不能接受或拒绝文件修改。'
                    : '本地文件修改仅可在桌面端的已绑定工作区中审批。',
              })}
        />
      ))}
    </Fragment>
  );

  if (!grouped) return activity;

  return (
    <ToolCallGroup
      autoExpandRunningTools={autoExpandRunningTools}
      fileChanges={fileChanges}
      toolCalls={toolCalls}
    >
      {activity}
    </ToolCallGroup>
  );
}
