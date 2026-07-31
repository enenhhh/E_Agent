import { Bot, Camera, Command, FolderOpen, History, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { useTransport } from '../../context/TransportContext';
import { useConversationStore } from '../../stores/conversation-store';
import { useExtensionStore } from '../../stores/extension-store';
import { useModelStore } from '../../stores/model-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';

import { ChatComposer } from './ChatComposer';
import { ContextInspector } from './ContextInspector';
import { buildMessageTimeline } from './message-timeline';
import { MessageCard } from './MessageCard';
import { resolvePromptModel } from './model-routing';
import { SnapshotHistoryModal } from './SnapshotHistoryModal';

export function WorkspacePage(): React.JSX.Element {
  const { transport } = useTransport();
  const messages = useConversationStore((state) => state.messages);
  const conversations = useConversationStore((state) => state.conversations);
  const selectedId = useConversationStore((state) => state.selectedId);
  const loading = useConversationStore((state) => state.loading);
  const error = useConversationStore((state) => state.error);
  const send = useConversationStore((state) => state.send);
  const streaming = useConversationStore((state) => state.streaming);
  const messageMutating = useConversationStore((state) => state.messageMutationId !== null);
  const queuedPromptCount = useConversationStore(
    (state) =>
      state.queuedPrompts.filter((prompt) => prompt.conversationId === state.selectedId).length,
  );
  const sendNextQueued = useConversationStore((state) => state.sendNextQueued);
  const decideFileChange = useConversationStore((state) => state.decideFileChange);
  const createConversation = useConversationStore((state) => state.createConversation);
  const branchConversation = useConversationStore((state) => state.branchConversation);
  const selectConversation = useConversationStore((state) => state.selectConversation);
  const deleteMessage = useConversationStore((state) => state.deleteMessage);
  const setMessageFeedback = useConversationStore((state) => state.setMessageFeedback);
  const retryMessage = useConversationStore((state) => state.retryMessage);
  const editAndResend = useConversationStore((state) => state.editAndResend);
  const createSnapshot = useConversationStore((state) => state.createSnapshot);
  const loadSnapshots = useConversationStore((state) => state.loadSnapshots);
  const restoreSnapshot = useConversationStore((state) => state.restoreSnapshot);
  const snapshots = useConversationStore((state) => state.snapshots);
  const snapshotsLoading = useConversationStore((state) => state.snapshotsLoading);
  const restoringSnapshotId = useConversationStore((state) => state.restoringSnapshotId);
  const snapshotError = useConversationStore((state) => state.snapshotError);
  const models = useModelStore((state) => state.models);
  const selectedModel = useModelStore((state) => state.selectedModel);
  const routingMode = useModelStore((state) => state.routingMode);
  const defaultModels = useSettingsStore((state) => state.settings.defaultModels);
  const loadSkills = useExtensionStore((state) => state.loadSkills);
  const pushToast = useToastStore((state) => state.push);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [snapshotHistoryOpen, setSnapshotHistoryOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const timelineItems = useMemo(() => buildMessageTimeline(messages), [messages]);

  useEffect(() => {
    void loadSkills(transport);
  }, [loadSkills, transport]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followLatestRef.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (streaming || messageMutating || queuedPromptCount === 0) return;
    void sendNextQueued(transport).catch((queueError: unknown) => {
      pushToast({
        kind: 'error',
        title: '排队消息发送失败',
        description: queueError instanceof Error ? queueError.message : undefined,
      });
    });
  }, [messageMutating, pushToast, queuedPromptCount, sendNextQueued, streaming, transport]);

  const handleConversationScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    followLatestRef.current = distanceToBottom < 80;
    setShowJumpToLatest(!followLatestRef.current);
  };

  const jumpToLatest = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  };

  const handleSend = async (content: string, skill?: string): Promise<void> => {
    const requestModel = resolvePromptModel({
      content,
      selectedModel,
      routingMode,
      defaultModels,
      models,
    });
    if (!requestModel) {
      pushToast({
        kind: 'warning',
        title: '尚未选择可用模型',
        description: '请先添加 API Key 并完成模型发现。',
      });
      return;
    }
    try {
      await send(transport, {
        content,
        model: requestModel,
        skill,
      });
    } catch (sendError) {
      pushToast({
        kind: 'error',
        title: '消息发送失败',
        description: sendError instanceof Error ? sendError.message : '请检查模型与密钥状态。',
      });
    }
  };

  const resolveActionModel = (content: string): string | null =>
    resolvePromptModel({
      content,
      selectedModel,
      routingMode,
      defaultModels,
      models,
    });

  const handleCopyMessage = async (
    _messageId: string,
    content: string,
    _format: 'markdown' | 'plain',
  ): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      throw new Error('当前环境不支持剪贴板写入。');
    }
    await navigator.clipboard.writeText(content);
    pushToast({ kind: 'success', title: '消息已复制' });
  };

  const handleFeedback = async (
    messageId: string,
    feedback: 'negative' | 'positive' | null,
  ): Promise<void> => {
    await setMessageFeedback(
      transport,
      messageId,
      feedback === 'positive' ? 'helpful' : feedback === 'negative' ? 'unhelpful' : null,
    );
    pushToast({
      kind: 'success',
      title: feedback === null ? '已撤销评价' : '感谢反馈',
    });
  };

  const handleRetry = async (messageId: string): Promise<void> => {
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    const userMessage = [...messages.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === 'user');
    if (!userMessage) throw new Error('没有找到可重试的用户消息。');
    const model = resolveActionModel(userMessage.content);
    if (!model) throw new Error('请先选择可用模型。');
    await retryMessage(transport, messageId, { model });
    pushToast({
      kind: 'success',
      title: '已生成新的回答版本',
      description: '原回答保持不变，可使用版本箭头来回比较。',
    });
  };

  const handleEdit = async (messageId: string, content: string): Promise<void> => {
    const model = resolveActionModel(content);
    if (!model) throw new Error('请先选择可用模型。');
    await editAndResend(transport, messageId, content, { model });
    pushToast({
      kind: 'success',
      title: '已从编辑内容创建新对话',
      description: '原会话保持不变。',
    });
  };

  const handleDeleteMessage = async (messageId: string): Promise<void> => {
    const result = await deleteMessage(transport, messageId);
    pushToast({
      kind: 'success',
      title: result.transient ? '已移除未保存的失败消息' : `已移除 ${result.removedCount} 条消息`,
      description: result.transient
        ? '该消息尚未写入历史，无需修改持久化会话。'
        : '删除前的状态已自动保存为会话快照。',
    });
  };

  const handleMessageActionError = (_action: string, actionError: unknown): void => {
    pushToast({
      kind: 'error',
      title: '消息操作失败',
      description: actionError instanceof Error ? actionError.message : undefined,
    });
  };

  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);

  const versionNavigationFor = (
    messageId: string,
    messageIndex: number,
  ):
    | {
        current: number;
        total: number;
        previousId?: string;
        nextId?: string;
      }
    | undefined => {
    if (!selectedConversation || messages[messageIndex]?.role !== 'assistant') return undefined;
    let candidates: typeof conversations = [];
    if (
      selectedConversation.forkKind === 'retry' &&
      selectedConversation.parentConversationId &&
      selectedConversation.originMessageId
    ) {
      let lastAssistantIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') {
          lastAssistantIndex = index;
          break;
        }
      }
      if (messageIndex !== lastAssistantIndex) return undefined;
      const root = conversations.find(
        (conversation) => conversation.id === selectedConversation.parentConversationId,
      );
      if (!root) return undefined;
      const retries = conversations
        .filter(
          (conversation) =>
            conversation.parentConversationId === root.id &&
            conversation.forkKind === 'retry' &&
            conversation.originMessageId === selectedConversation.originMessageId,
        )
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      candidates = [root, ...retries];
    } else {
      const retries = conversations
        .filter(
          (conversation) =>
            conversation.parentConversationId === selectedConversation.id &&
            conversation.forkKind === 'retry' &&
            conversation.originMessageId === messageId,
        )
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      if (retries.length === 0) return undefined;
      candidates = [selectedConversation, ...retries];
    }
    const currentIndex = candidates.findIndex((conversation) => conversation.id === selectedId);
    if (currentIndex < 0) return undefined;
    return {
      current: currentIndex + 1,
      total: candidates.length,
      previousId: candidates[currentIndex - 1]?.id,
      nextId: candidates[currentIndex + 1]?.id,
    };
  };

  const openVersion = async (conversationId: string | undefined): Promise<void> => {
    if (!conversationId) return;
    followLatestRef.current = false;
    setShowJumpToLatest(true);
    await selectConversation(transport, conversationId);
  };

  const handleFileDecision = async (
    changeId: string,
    decision: 'accept' | 'reject',
  ): Promise<void> => {
    try {
      await decideFileChange(transport, changeId, decision);
      pushToast({
        kind: decision === 'accept' ? 'success' : 'info',
        title: decision === 'accept' ? '文件更改已应用' : '文件更改已拒绝',
      });
    } catch (decisionError) {
      pushToast({
        kind: 'error',
        title: '无法处理文件更改',
        description: decisionError instanceof Error ? decisionError.message : undefined,
      });
    }
  };

  const handleBranch = async (messageId: string): Promise<void> => {
    try {
      await branchConversation(transport, messageId);
      pushToast({
        kind: 'success',
        title: '分支会话已创建',
        description: '原会话保持不变，当前已切换到新分支。',
      });
    } catch (branchError) {
      pushToast({
        kind: 'error',
        title: '无法创建分支',
        description: branchError instanceof Error ? branchError.message : undefined,
      });
    }
  };

  const handleSnapshot = async (): Promise<void> => {
    try {
      await createSnapshot(transport);
      pushToast({
        kind: 'success',
        title: '会话快照已保存',
        description: '稍后可从快照历史恢复到此状态。',
      });
    } catch (snapshotError) {
      pushToast({
        kind: 'error',
        title: '无法保存快照',
        description: snapshotError instanceof Error ? snapshotError.message : undefined,
      });
    }
  };

  const handleOpenSnapshotHistory = async (): Promise<void> => {
    setSnapshotHistoryOpen(true);
    try {
      await loadSnapshots(transport);
    } catch (snapshotHistoryError) {
      pushToast({
        kind: 'error',
        title: '无法加载快照历史',
        description:
          snapshotHistoryError instanceof Error ? snapshotHistoryError.message : undefined,
      });
    }
  };

  const handleRestoreSnapshot = async (snapshotId: string): Promise<void> => {
    try {
      await restoreSnapshot(transport, snapshotId);
      setSnapshotHistoryOpen(false);
      pushToast({
        kind: 'success',
        title: '会话已恢复',
        description: '消息和上下文已回到所选快照的状态。',
      });
    } catch (restoreError) {
      pushToast({
        kind: 'error',
        title: '无法恢复快照',
        description: restoreError instanceof Error ? restoreError.message : undefined,
      });
    }
  };

  return (
    <div className="workspace-page">
      <section className="conversation-canvas">
        <div className="conversation-toolbar">
          <span>{selectedId ? '会话状态' : '尚未选择会话'}</span>
          <Button
            disabled={!selectedId || messageMutating}
            onClick={() => void handleOpenSnapshotHistory()}
            size="small"
            variant="ghost"
          >
            <History size={13} />
            快照历史
          </Button>
          <Button
            disabled={!selectedId || messageMutating}
            onClick={() => void handleSnapshot()}
            size="small"
            variant="ghost"
          >
            <Camera size={13} />
            保存快照
          </Button>
        </div>
        <div className="conversation-scroll" onScroll={handleConversationScroll} ref={scrollRef}>
          {loading ? <LoadingState label="正在加载会话…" /> : null}
          {!loading && error ? <ErrorState message={error} /> : null}
          {!loading && !error && !selectedId ? (
            <EmptyState
              action={
                <Button
                  disabled={messageMutating}
                  onClick={() => void createConversation(transport)}
                  variant="primary"
                >
                  新建会话
                </Button>
              }
              description="创建会话后，可以添加文件、目录、网页和项目记忆作为上下文。"
              icon={<Bot size={28} />}
              title="开始一次可靠的协作"
            />
          ) : null}
          {!loading && selectedId && messages.length === 0 ? (
            <div className="conversation-welcome">
              <span className="conversation-welcome__icon">
                <Sparkles size={24} />
              </span>
              <h2>今天要一起构建什么？</h2>
              <p>选择模型，添加上下文，然后描述您希望完成的结果。</p>
              <div className="conversation-prompts">
                <button
                  disabled={!selectedModel || messageMutating}
                  onClick={() =>
                    void handleSend(
                      '请审查当前工作区的架构，指出高风险问题并给出可执行的改进方案。',
                    )
                  }
                  type="button"
                >
                  <FolderOpen size={17} />
                  审查当前工作区的架构
                </button>
                <button
                  disabled={!selectedModel || messageMutating}
                  onClick={() =>
                    void handleSend(
                      '请为我接下来提供的代码生成完整的单元测试，并说明覆盖的边界条件。',
                      '@test-gen',
                    )
                  }
                  type="button"
                >
                  <Command size={17} />
                  为选中代码生成单元测试
                </button>
              </div>
            </div>
          ) : null}
          <div className="message-list">
            {timelineItems.map((item) => {
              const { message, sourceIndex } = item;
              const versionNavigation = versionNavigationFor(message.id, sourceIndex);
              const allowsMessageMutations = !item.aggregatedToolActivity;
              const hasActiveTool = message.toolCalls?.some((toolCall) =>
                ['approval-required', 'pending', 'running'].includes(toolCall.status),
              );
              return (
                <MessageCard
                  conversationBusy={streaming || messageMutating}
                  feedback={
                    message.feedback === 'helpful'
                      ? 'positive'
                      : message.feedback === 'unhelpful'
                        ? 'negative'
                        : null
                  }
                  groupedToolMessages={item.groupedToolMessages}
                  key={item.key}
                  message={message}
                  onActionError={handleMessageActionError}
                  onBranch={
                    allowsMessageMutations &&
                    (message.role === 'user' || message.role === 'assistant') &&
                    !hasActiveTool
                      ? handleBranch
                      : undefined
                  }
                  onCopy={
                    !item.aggregatedToolActivity || message.content ? handleCopyMessage : undefined
                  }
                  onDelete={
                    allowsMessageMutations &&
                    (message.role === 'user' || message.role === 'assistant')
                      ? handleDeleteMessage
                      : undefined
                  }
                  onEdit={message.role === 'user' ? handleEdit : undefined}
                  onFeedback={
                    allowsMessageMutations && message.role === 'assistant'
                      ? handleFeedback
                      : undefined
                  }
                  onFileDecision={(changeId, decision) =>
                    void handleFileDecision(changeId, decision)
                  }
                  onNextVersion={
                    allowsMessageMutations && versionNavigation?.nextId
                      ? () => openVersion(versionNavigation.nextId)
                      : undefined
                  }
                  onPreviousVersion={
                    allowsMessageMutations && versionNavigation?.previousId
                      ? () => openVersion(versionNavigation.previousId)
                      : undefined
                  }
                  onRetry={
                    allowsMessageMutations && message.role === 'assistant' ? handleRetry : undefined
                  }
                  toolActivityOrder={item.toolActivityOrder}
                  version={
                    allowsMessageMutations && versionNavigation
                      ? {
                          current: versionNavigation.current,
                          total: versionNavigation.total,
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        </div>
        {showJumpToLatest ? (
          <button className="conversation-jump-latest" onClick={jumpToLatest} type="button">
            回到最新消息
          </button>
        ) : null}
        <ChatComposer onSend={handleSend} />
      </section>
      <ContextInspector />
      <SnapshotHistoryModal
        error={snapshotError}
        loading={snapshotsLoading}
        onClose={() => setSnapshotHistoryOpen(false)}
        onRestore={handleRestoreSnapshot}
        open={snapshotHistoryOpen}
        restoringSnapshotId={restoringSnapshotId}
        snapshots={snapshots}
      />
    </div>
  );
}
