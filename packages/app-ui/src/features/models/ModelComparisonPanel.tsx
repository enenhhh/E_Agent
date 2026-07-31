import { GitCompareArrows, Play, Square, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { useTransport } from '../../context/TransportContext';
import { diffAgainstBaseline } from '../../lib/word-diff';
import { useConversationStore } from '../../stores/conversation-store';
import { useModelStore } from '../../stores/model-store';
import type { StreamEvent } from '../../types';

interface Result {
  content: string;
  running: boolean;
  error?: string;
  usage?: StreamEvent['usage'];
}

export function ModelComparisonPanel(): React.JSX.Element {
  const { transport } = useTransport();
  const models = useModelStore((state) => state.models);
  const compareModels = useModelStore((state) => state.compareModels);
  const toggleCompare = useModelStore((state) => state.toggleCompare);
  const selectedConversationId = useConversationStore((state) => state.selectedId);
  const createConversation = useConversationStore((state) => state.createConversation);
  const refreshConversationSummary = useConversationStore(
    (state) => state.refreshConversationSummary,
  );
  const messageMutating = useConversationStore((state) => state.messageMutationId !== null);
  const [prompt, setPrompt] = useState('');
  const [results, setResults] = useState<Record<string, Result>>({});
  const controllerRef = useRef<AbortController | null>(null);

  const baseline = results[compareModels[0] ?? '']?.content ?? '';
  const running = Object.values(results).some((result) => result.running);
  const canRun =
    prompt.trim().length > 0 && compareModels.length >= 2 && !running && !messageMutating;

  const selected = useMemo(
    () => compareModels.map((id) => models.find((model) => model.id === id)).filter(Boolean),
    [compareModels, models],
  );

  const runModel = async (
    modelId: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      for await (const event of transport.streamChat(
        {
          conversationId,
          content: prompt.trim(),
          model: modelId,
          contextMentions: [],
        },
        signal,
      )) {
        setResults((current) => {
          const result = current[modelId] ?? { content: '', running: true };
          if (event.type === 'delta') {
            return {
              ...current,
              [modelId]: { ...result, content: result.content + (event.delta ?? '') },
            };
          }
          if (event.type === 'usage') {
            return { ...current, [modelId]: { ...result, usage: event.usage } };
          }
          if (event.type === 'error') {
            return {
              ...current,
              [modelId]: {
                ...result,
                running: false,
                error: event.message ?? '模型返回错误。',
              },
            };
          }
          return current;
        });
      }
      setResults((current) => ({
        ...current,
        [modelId]: { ...(current[modelId] ?? { content: '' }), running: false },
      }));
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      setResults((current) => ({
        ...current,
        [modelId]: {
          ...(current[modelId] ?? { content: '' }),
          running: false,
          error: error instanceof Error ? error.message : '模型调用失败。',
        },
      }));
    }
  };

  const run = async (): Promise<void> => {
    if (!canRun) {
      return;
    }
    const conversationId = selectedConversationId ?? (await createConversation(transport));
    const controller = new AbortController();
    controllerRef.current = controller;
    setResults(
      Object.fromEntries(compareModels.map((modelId) => [modelId, { content: '', running: true }])),
    );
    await Promise.all(
      compareModels.map((modelId) => runModel(modelId, conversationId, controller.signal)),
    );
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).map(([modelId, result]) => [
          modelId,
          { ...result, running: false },
        ]),
      ),
    );
    controllerRef.current = null;
    await refreshConversationSummary(transport, conversationId);
  };

  return (
    <section className="model-comparison">
      <header className="model-comparison__header">
        <span>
          <GitCompareArrows size={18} />
          <strong>模型并排对比</strong>
          <small>选择 2–4 个模型，对相同 Prompt 并行生成并高亮差异。</small>
        </span>
        <span className="model-comparison__selection">
          {selected.map((model) =>
            model ? (
              <button key={model.id} onClick={() => toggleCompare(model.id)} type="button">
                {model.displayName}
                <X size={12} />
              </button>
            ) : null,
          )}
        </span>
      </header>
      <div className="model-comparison__prompt">
        <textarea
          aria-label="模型对比 Prompt"
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="输入要同时发送给所选模型的 Prompt…"
          rows={3}
          value={prompt}
        />
        {running ? (
          <Button onClick={() => controllerRef.current?.abort()} variant="danger">
            <Square fill="currentColor" size={13} />
            停止
          </Button>
        ) : (
          <Button disabled={!canRun} onClick={() => void run()} variant="primary">
            <Play size={15} />
            开始对比
          </Button>
        )}
      </div>
      {compareModels.length < 2 ? (
        <p className="model-comparison__hint">请在上方模型列表中至少勾选两个可用模型。</p>
      ) : null}
      {Object.keys(results).length > 0 ? (
        <div
          className="model-comparison__grid"
          style={{
            gridTemplateColumns: `repeat(${Math.min(compareModels.length, 4)}, minmax(0, 1fr))`,
          }}
        >
          {compareModels.map((modelId, index) => {
            const result = results[modelId];
            const model = models.find((item) => item.id === modelId);
            const segments =
              index === 0
                ? [{ text: result?.content ?? '', changed: false }]
                : diffAgainstBaseline(baseline, result?.content ?? '');
            return (
              <article key={modelId}>
                <header>
                  <strong>{model?.displayName ?? modelId}</strong>
                  {result?.running ? <span>正在生成…</span> : null}
                  {result?.usage ? (
                    <small>
                      {result.usage.outputTokens.toLocaleString()} tokens · $
                      {result.usage.cost.toFixed(4)}
                    </small>
                  ) : null}
                </header>
                {result?.error ? <div className="comparison-error">{result.error}</div> : null}
                <div className="comparison-output">
                  {segments.map((segment, segmentIndex) => (
                    <mark className={segment.changed ? 'is-different' : ''} key={segmentIndex}>
                      {segment.text}
                    </mark>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
