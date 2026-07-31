import {
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  GitCompareArrows,
  Hash,
  ListPlus,
  Paperclip,
  Pencil,
  Send,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';

import { IconButton } from '../../components/ui/IconButton';
import { Select } from '../../components/ui/Select';
import { useI18n } from '../../context/I18nContext';
import { useConversationStore } from '../../stores/conversation-store';
import { useExtensionStore } from '../../stores/extension-store';
import { useModelStore } from '../../stores/model-store';

interface ChatComposerProps {
  onSend: (content: string, skill?: string) => Promise<void>;
}

export function ChatComposer({ onSend }: ChatComposerProps): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [content, setContent] = useState('');
  const [skill, setSkill] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [queueDraft, setQueueDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = useConversationStore((state) => state.streaming);
  const messageMutating = useConversationStore((state) => state.messageMutationId !== null);
  const stop = useConversationStore((state) => state.stop);
  const selectedId = useConversationStore((state) => state.selectedId);
  const allQueuedPrompts = useConversationStore((state) => state.queuedPrompts);
  const queuedPrompts = useMemo(
    () => allQueuedPrompts.filter((prompt) => prompt.conversationId === selectedId),
    [allQueuedPrompts, selectedId],
  );
  const updateQueuedPrompt = useConversationStore((state) => state.updateQueuedPrompt);
  const moveQueuedPrompt = useConversationStore((state) => state.moveQueuedPrompt);
  const removeQueuedPrompt = useConversationStore((state) => state.removeQueuedPrompt);
  const compareModels = useModelStore((state) => state.compareModels);
  const toggleCompare = useModelStore((state) => state.toggleCompare);
  const models = useModelStore((state) => state.models);
  const selectedModel = useModelStore((state) => state.selectedModel);
  const skills = useExtensionStore((state) => state.skills);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [content]);

  useEffect(() => {
    setHistoryIndex(-1);
    setHistoryOpen(false);
  }, [selectedId]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      if (historyOpen) {
        event.preventDefault();
        setHistoryOpen(false);
        textareaRef.current?.focus();
        return;
      }
      if (streaming && document.querySelector('[role="dialog"],[role="menu"]') === null) {
        event.preventDefault();
        stop();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [historyOpen, stop, streaming]);

  const submit = async (): Promise<void> => {
    const nextContent = content.trim();
    if (!nextContent || !selectedModel || messageMutating) return;
    setHistory((current) =>
      [nextContent, ...current.filter((entry) => entry !== nextContent)].slice(0, 50),
    );
    setHistoryIndex(-1);
    setHistoryOpen(false);
    setContent('');
    await onSend(nextContent, skill || undefined);
    textareaRef.current?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      setHistoryOpen((value) => !value);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      void submit();
      return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (history.length === 0) return;
      const nextIndex =
        event.key === 'ArrowUp'
          ? Math.min(history.length - 1, historyIndex + 1)
          : Math.max(-1, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setContent(nextIndex < 0 ? '' : (history[nextIndex] ?? ''));
    }
  };

  const appendMention = (kind: 'file' | 'folder'): void => {
    setContent((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${kind}:""`);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursor = Math.max(0, textarea.value.length - 1);
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const startQueueEdit = (id: string, value: string): void => {
    setEditingQueueId(id);
    setQueueDraft(value);
  };

  const saveQueueEdit = (): void => {
    if (editingQueueId && queueDraft.trim()) {
      updateQueuedPrompt(editingQueueId, queueDraft);
    }
    setEditingQueueId(null);
    setQueueDraft('');
  };

  return (
    <section className="chat-composer">
      {queuedPrompts.length > 0 ? (
        <div aria-label="下一轮消息队列" className="chat-composer__queue">
          <header>
            <span>
              <ListPlus size={14} />
              已排队 {queuedPrompts.length} 条
            </span>
            <small>当前生成结束后依次发送</small>
          </header>
          {queuedPrompts.map((prompt, index) => (
            <div className="chat-composer__queue-item" key={prompt.id}>
              <span className="chat-composer__queue-index">{index + 1}</span>
              {editingQueueId === prompt.id ? (
                <input
                  aria-label={`编辑第 ${index + 1} 条排队消息`}
                  autoFocus
                  onChange={(event) => setQueueDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) saveQueueEdit();
                    if (event.key === 'Escape') setEditingQueueId(null);
                  }}
                  value={queueDraft}
                />
              ) : (
                <span title={prompt.input.content}>{prompt.input.content}</span>
              )}
              <span className="chat-composer__queue-actions">
                {editingQueueId === prompt.id ? (
                  <IconButton label="保存排队消息" onClick={saveQueueEdit}>
                    <Check size={14} />
                  </IconButton>
                ) : (
                  <IconButton
                    label="编辑排队消息"
                    onClick={() => startQueueEdit(prompt.id, prompt.input.content)}
                  >
                    <Pencil size={13} />
                  </IconButton>
                )}
                <IconButton
                  disabled={index === 0}
                  label="向前移动"
                  onClick={() => moveQueuedPrompt(prompt.id, -1)}
                >
                  <ChevronUp size={14} />
                </IconButton>
                <IconButton
                  disabled={index === queuedPrompts.length - 1}
                  label="向后移动"
                  onClick={() => moveQueuedPrompt(prompt.id, 1)}
                >
                  <ChevronDown size={14} />
                </IconButton>
                <IconButton label="移出队列" onClick={() => removeQueuedPrompt(prompt.id)}>
                  <Trash2 size={14} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {compareModels.length >= 2 ? (
        <div className="chat-composer__compare">
          <GitCompareArrows size={14} />
          <span>已选对比模型</span>
          {compareModels.map((modelId) => (
            <button key={modelId} onClick={() => toggleCompare(modelId)} type="button">
              {models.find((model) => model.id === modelId)?.displayName ?? modelId}
              <X size={12} />
            </button>
          ))}
          <button
            className="chat-composer__compare-link"
            onClick={() => navigate('/models')}
            type="button"
          >
            打开并排对比
          </button>
        </div>
      ) : null}

      <textarea
        aria-label="消息"
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={keyDown}
        placeholder={t('sendPlaceholder')}
        ref={textareaRef}
        rows={2}
        value={content}
      />

      {historyOpen ? (
        <div aria-label="输入历史" className="chat-composer__history" role="dialog">
          <header>
            <span>
              <Clock3 size={14} />
              输入历史
            </span>
            <button onClick={() => setHistoryOpen(false)} type="button">
              <X size={14} />
              <span className="sr-only">关闭输入历史</span>
            </button>
          </header>
          {history.length === 0 ? (
            <p>本次使用中还没有发送记录。</p>
          ) : (
            history.map((entry) => (
              <button
                key={entry}
                onClick={() => {
                  setContent(entry);
                  setHistoryOpen(false);
                  textareaRef.current?.focus();
                }}
                type="button"
              >
                {entry}
              </button>
            ))
          )}
        </div>
      ) : null}

      <footer className="chat-composer__footer">
        <span className="chat-composer__tools">
          <IconButton label="添加文件上下文" onClick={() => appendMention('file')}>
            <AtSign size={18} />
          </IconButton>
          <IconButton label="附加文件" onClick={() => appendMention('file')}>
            <Paperclip size={18} />
          </IconButton>
          <IconButton label="添加项目目录" onClick={() => appendMention('folder')}>
            <Hash size={17} />
          </IconButton>
          <Select
            aria-label="选择 Skill"
            onChange={(event) => setSkill(event.target.value)}
            value={skill}
          >
            <option value="">不使用 Skill</option>
            {skills
              .filter((item) => item.enabled)
              .map((item) => (
                <option key={item.id} value={item.command}>
                  {item.command}
                </option>
              ))}
          </Select>
          <IconButton disabled label="终端上下文即将开放">
            <TerminalSquare size={17} />
          </IconButton>
        </span>
        <span className="chat-composer__submit">
          <kbd>{streaming ? 'Ctrl ↵ 排队 · Esc 停止' : 'Ctrl ↵ · Ctrl R 历史'}</kbd>
          {streaming ? (
            <>
              <IconButton
                className="composer-send"
                disabled={!content.trim() || !selectedModel || messageMutating}
                label="加入下一轮队列"
                onClick={() => void submit()}
              >
                <ListPlus size={17} />
              </IconButton>
              <IconButton className="composer-stop" label="停止生成" onClick={stop}>
                <Square fill="currentColor" size={14} />
              </IconButton>
            </>
          ) : (
            <IconButton
              className="composer-send"
              disabled={!content.trim() || !selectedModel || messageMutating}
              label="发送消息"
              onClick={() => void submit()}
            >
              <Send size={18} />
            </IconButton>
          )}
        </span>
      </footer>
    </section>
  );
}
