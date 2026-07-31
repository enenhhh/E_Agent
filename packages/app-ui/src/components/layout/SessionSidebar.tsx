import {
  Archive,
  FolderOpen,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../context/I18nContext';
import { useTransport } from '../../context/TransportContext';
import { formatDateTime } from '../../lib/format';
import { useConversationStore } from '../../stores/conversation-store';
import { useToastStore } from '../../stores/toast-store';
import type { Conversation, WorkspaceBinding } from '../../types';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Modal } from '../ui/Modal';

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function SessionSidebar({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { mode, transport } = useTransport();
  const conversations = useConversationStore((state) => state.conversations);
  const selectedId = useConversationStore((state) => state.selectedId);
  const createConversation = useConversationStore((state) => state.createConversation);
  const selectConversation = useConversationStore((state) => state.selectConversation);
  const updateConversation = useConversationStore((state) => state.updateConversation);
  const deleteConversation = useConversationStore((state) => state.deleteConversation);
  const messageMutating = useConversationStore((state) => state.messageMutationId !== null);
  const pushToast = useToastStore((state) => state.push);
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceBinding | null>(null);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    kind: 'delete' | 'rename';
    conversation: Conversation;
  } | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'desktop') {
      void transport
        .getWorkspaceBinding()
        .then(setWorkspace)
        .catch(() => setWorkspace(null));
    }
  }, [mode, transport]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'Escape') {
        setMenuConversationId(null);
      }
    };
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!menuConversationId || !(event.target instanceof Element)) return;
      const menuRoot = event.target.closest<HTMLElement>('.session-row__actions');
      if (menuRoot?.dataset['sessionMenuId'] !== menuConversationId) {
        setMenuConversationId(null);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [menuConversationId]);

  const chooseWorkspace = async (): Promise<void> => {
    try {
      const binding = await transport.chooseWorkspace();
      setWorkspace(binding);
      if (binding) {
        pushToast({
          kind: 'success',
          title: '工作区已绑定',
          description: binding.root,
        });
      }
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '无法绑定工作区',
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const openRename = (conversation: Conversation): void => {
    setMenuConversationId(null);
    setTitleDraft(conversation.title);
    setDialog({ kind: 'rename', conversation });
  };

  const submitDialog = async (): Promise<void> => {
    if (!dialog || submitting) return;
    setSubmitting(true);
    try {
      if (dialog.kind === 'rename') {
        const title = titleDraft.trim();
        if (!title) return;
        await updateConversation(transport, dialog.conversation.id, { title });
        pushToast({ kind: 'success', title: '会话已重命名' });
      } else {
        await deleteConversation(transport, dialog.conversation.id);
        pushToast({ kind: 'success', title: '会话已删除' });
      }
      setDialog(null);
    } catch (error) {
      pushToast({
        kind: 'error',
        title: dialog.kind === 'rename' ? '无法重命名会话' : '无法删除会话',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = conversations.filter(
      (conversation) =>
        !conversation.archived &&
        (!normalized || conversation.title.toLocaleLowerCase().includes(normalized)),
    );
    return {
      today: filtered.filter((conversation) => isToday(conversation.updatedAt)),
      earlier: filtered.filter((conversation) => !isToday(conversation.updatedAt)),
    };
  }, [conversations, query]);

  if (collapsed) {
    return <aside className="session-sidebar session-sidebar--collapsed" aria-hidden />;
  }

  return (
    <aside className="session-sidebar">
      <header className="session-sidebar__header">
        <strong>会话</strong>
        <span>
          <IconButton
            disabled={messageMutating}
            label={t('newConversation')}
            onClick={() => void createConversation(transport)}
          >
            <Plus size={17} />
          </IconButton>
          <IconButton label="收起会话栏" onClick={onCollapse}>
            <PanelLeftClose size={17} />
          </IconButton>
        </span>
      </header>
      <label className="session-search">
        <Search aria-hidden size={15} />
        <input
          aria-label={t('searchConversations')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchConversations')}
          ref={searchRef}
          type="search"
          value={query}
        />
        <kbd>Ctrl P</kbd>
      </label>
      <div className="session-sidebar__list">
        {(['today', 'earlier'] as const).map((group) => (
          <section className="session-group" key={group}>
            <h2>{group === 'today' ? t('today') : t('earlier')}</h2>
            {groups[group].map((conversation, conversationIndex) => (
              <div
                className={`session-row${conversation.id === selectedId ? ' is-active' : ''}`}
                key={conversation.id}
              >
                <button
                  className="session-row__select"
                  disabled={messageMutating}
                  onClick={() => void selectConversation(transport, conversation.id)}
                  type="button"
                >
                  <span className="session-row__title">
                    {conversation.pinned ? <Pin aria-hidden size={12} /> : null}
                    {conversation.title}
                  </span>
                  <time>{formatDateTime(conversation.updatedAt).split(' ').at(-1)}</time>
                </button>
                <span
                  className={`session-row__actions${
                    menuConversationId === conversation.id ? ' is-menu-open' : ''
                  }${
                    groups[group].length > 2 && conversationIndex >= groups[group].length - 2
                      ? ' is-menu-up'
                      : ''
                  }`}
                  data-session-menu-id={conversation.id}
                >
                  <IconButton
                    label={conversation.pinned ? '取消置顶' : '置顶'}
                    onClick={() => {
                      void updateConversation(transport, conversation.id, {
                        pinned: !conversation.pinned,
                      });
                    }}
                  >
                    <Pin size={13} />
                  </IconButton>
                  <IconButton
                    label="归档"
                    onClick={() => {
                      void updateConversation(transport, conversation.id, { archived: true });
                    }}
                  >
                    <Archive size={13} />
                  </IconButton>
                  <IconButton
                    disabled={messageMutating}
                    label="更多会话操作"
                    onClick={() =>
                      setMenuConversationId((current) =>
                        current === conversation.id ? null : conversation.id,
                      )
                    }
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                  {menuConversationId === conversation.id ? (
                    <div aria-label="会话操作" className="session-row__menu" role="menu">
                      <button
                        onClick={() => openRename(conversation)}
                        role="menuitem"
                        type="button"
                      >
                        <Pencil size={13} />
                        重命名
                      </button>
                      <button
                        className="is-danger"
                        disabled={messageMutating}
                        onClick={() => {
                          setMenuConversationId(null);
                          setDialog({ kind: 'delete', conversation });
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <Trash2 size={13} />
                        删除会话
                      </button>
                    </div>
                  ) : null}
                </span>
              </div>
            ))}
          </section>
        ))}
        {groups.today.length === 0 && groups.earlier.length === 0 ? (
          <div className="session-sidebar__empty">
            <span>{query ? '没有匹配的会话' : '还没有会话'}</span>
            {!query ? (
              <Button
                disabled={messageMutating}
                onClick={() => void createConversation(transport)}
                size="small"
                variant="ghost"
              >
                <Plus size={14} />
                新建会话
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        className="session-sidebar__workspace"
        disabled={mode !== 'desktop'}
        onClick={() => void chooseWorkspace()}
        title={workspace?.root ?? undefined}
        type="button"
      >
        <span className="workspace-symbol">
          <FolderOpen size={14} />
        </span>
        <span>
          <strong>{workspace?.name ?? (mode === 'desktop' ? '绑定工作区' : '服务器工作区')}</strong>
          <small>
            {workspace?.root ?? (mode === 'desktop' ? '点击选择本地文件夹' : 'Web 协作模式')}
          </small>
        </span>
      </button>
      <Modal
        description={
          dialog?.kind === 'delete'
            ? dialog.conversation.branchCount > 0
              ? `该会话有 ${dialog.conversation.branchCount} 个独立分支；分支会保留。`
              : '删除后无法恢复，请确认不再需要这段会话。'
            : '输入一个便于检索的新名称。'
        }
        footer={
          <>
            <Button disabled={submitting} onClick={() => setDialog(null)} variant="ghost">
              取消
            </Button>
            <Button
              disabled={messageMutating || (dialog?.kind === 'rename' && !titleDraft.trim())}
              loading={submitting}
              onClick={() => void submitDialog()}
              variant={dialog?.kind === 'delete' ? 'danger' : 'primary'}
            >
              {dialog?.kind === 'delete' ? '删除会话' : '保存'}
            </Button>
          </>
        }
        onClose={() => {
          if (!submitting) setDialog(null);
        }}
        open={dialog !== null}
        title={dialog?.kind === 'delete' ? '删除这个会话？' : '重命名会话'}
      >
        {dialog?.kind === 'rename' ? (
          <label className="session-rename-field">
            <span>会话名称</span>
            <input
              autoFocus
              maxLength={200}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitDialog();
                }
              }}
              value={titleDraft}
            />
          </label>
        ) : null}
      </Modal>
    </aside>
  );
}
