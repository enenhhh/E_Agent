import {
  Brain,
  ChevronRight,
  FileCode2,
  FolderTree,
  Gauge,
  History,
  Rows3,
  Sparkles,
} from 'lucide-react';

import { Progress } from '../../components/ui/Progress';
import { formatCompactNumber } from '../../lib/format';
import { useConversationStore } from '../../stores/conversation-store';

const sourceIcons = {
  system: Sparkles,
  history: History,
  file: FileCode2,
  folder: FolderTree,
  web: Gauge,
  memory: Brain,
} as const;

export function ContextInspector(): React.JSX.Element {
  const context = useConversationStore((state) => state.context);
  const queue = useConversationStore((state) => state.queue);
  const ratio = context ? (context.usedTokens / Math.max(context.contextWindow, 1)) * 100 : 0;

  return (
    <aside className="context-inspector">
      <header>
        <h2>上下文</h2>
      </header>
      <section className="context-budget">
        <span>
          <strong>令牌使用</strong>
          <code>
            {formatCompactNumber(context?.usedTokens ?? 0)} /{' '}
            {formatCompactNumber(context?.contextWindow ?? 0)}
          </code>
        </span>
        <Progress
          label="上下文窗口使用率"
          tone={ratio >= 85 ? 'danger' : ratio >= 70 ? 'warning' : 'default'}
          value={ratio}
        />
        <small>
          {ratio.toFixed(1)}%{context?.compressed ? ' · 已自动压缩' : ''}
        </small>
      </section>
      <section className="context-section">
        <h3>来源</h3>
        <div className="context-sources">
          {context?.sources.map((source) => {
            const Icon = sourceIcons[source.type];
            const sourceRatio = (source.tokens / Math.max(context.usedTokens, 1)) * 100;
            return (
              <div className="context-source" key={source.id}>
                <span className="context-source__label">
                  <Icon size={14} />
                  {source.label}
                </span>
                <span className="context-source__value">
                  {source.tokens.toLocaleString()} ({sourceRatio.toFixed(0)}%)
                </span>
                <Progress value={sourceRatio} />
              </div>
            );
          })}
          {!context?.sources.length ? (
            <p className="context-muted">发送消息后显示上下文来源。</p>
          ) : null}
        </div>
      </section>
      <section className="context-section">
        <h3>当前文件</h3>
        <div className="context-link">
          <FileCode2 size={15} />
          <span>
            <strong>尚未绑定文件</strong>
            <small>输入 @file 添加上下文</small>
          </span>
          <ChevronRight aria-hidden size={14} />
        </div>
      </section>
      <section className="context-section">
        <h3>项目记忆</h3>
        <div className="context-link">
          <Brain size={15} />
          <span>
            <strong>技术栈与代码风格</strong>
            <small>绑定项目后跨会话加载</small>
          </span>
          <ChevronRight aria-hidden size={14} />
        </div>
      </section>
      <section className="context-queue">
        <span>
          <Rows3 size={15} />
          请求队列
        </span>
        <strong>{queue.position ? `第 ${queue.position} 位` : queue.queued}</strong>
        <small>{queue.running ? `${queue.running} 个请求正在运行` : '当前无排队请求'}</small>
      </section>
    </aside>
  );
}
