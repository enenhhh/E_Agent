import type { ChatMessageInput, ContextBreakdown } from '@e-agent/contracts';

export interface ContextSourceInput {
  source: 'system' | 'history' | 'file' | 'folder' | 'web' | 'memory';
  content: string;
}

export interface PreparedContext {
  messages: ChatMessageInput[];
  breakdown: ContextBreakdown;
}

export type ContextSummarizer = (
  messages: ChatMessageInput[],
  signal?: AbortSignal,
) => Promise<string>;

/** 近似 Token 计数；不依赖单一厂商 tokenizer，并为中日韩文本提高权重。 */
export function estimateTokens(value: string): number {
  let latin = 0;
  let wide = 0;
  for (const character of value) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\u3040-\u30ff]/u.test(character)) wide += 1;
    else latin += 1;
  }
  return Math.max(1, Math.ceil(latin / 4 + wide * 0.8));
}

function messageText(message: ChatMessageInput): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
}

function countMessages(messages: readonly ChatMessageInput[]): number {
  return messages.reduce((total, message) => total + estimateTokens(messageText(message)) + 4, 0);
}

function fallbackSummary(messages: readonly ChatMessageInput[], budget: number): string {
  return messages
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join('\n')
    .slice(-Math.max(512, budget * 3));
}

/** 管理上下文预算；超过阈值时摘要旧消息，摘要不可用则保守截断。 */
export class ContextManager {
  public constructor(
    private readonly options: {
      threshold?: number;
      summarizer?: ContextSummarizer;
    } = {},
  ) {}

  public async prepare(input: {
    messages: ChatMessageInput[];
    contextWindow: number;
    maxOutputTokens?: number;
    sources?: ContextSourceInput[];
    signal?: AbortSignal;
  }): Promise<PreparedContext> {
    const threshold = this.options.threshold ?? 0.7;
    const outputReserve =
      input.maxOutputTokens ?? Math.min(4_096, Math.floor(input.contextWindow * 0.2));
    const budget = Math.max(256, Math.floor(input.contextWindow * threshold) - outputReserve);
    const sources = input.sources ?? [];
    const sourceMessages: ChatMessageInput[] = sources.map((source) => ({
      role: 'user',
      content: `[untrusted-context:${source.source}]\n${source.content}`,
    }));
    const systemMessages = input.messages.filter((message) => message.role === 'system');
    const dialogueMessages = input.messages.filter((message) => message.role !== 'system');
    let messages = [...systemMessages, ...sourceMessages, ...dialogueMessages];
    let compressed = false;
    if (countMessages(messages) > budget) {
      compressed = true;
      const system = messages.filter((message) => message.role === 'system');
      const dialogue = messages.filter((message) => message.role !== 'system');
      const keepCount = Math.max(2, Math.min(8, Math.ceil(dialogue.length / 3)));
      const oldMessages = dialogue.slice(0, -keepCount);
      const recentMessages = dialogue.slice(-keepCount);
      let summary = '';
      if (oldMessages.length > 0 && this.options.summarizer !== undefined) {
        try {
          summary = await this.options.summarizer(oldMessages, input.signal);
        } catch {
          // 摘要模型不可用时保持对话可用，并使用确定性本地压缩兜底。
          summary = fallbackSummary(oldMessages, budget);
        }
      } else if (oldMessages.length > 0) {
        summary = fallbackSummary(oldMessages, budget);
      }
      messages = [
        ...system,
        ...(summary === ''
          ? []
          : [{ role: 'user' as const, content: `[untrusted-conversation-summary]\n${summary}` }]),
        ...recentMessages,
      ];
      while (countMessages(messages) > budget && messages.length > 2) {
        const removable = messages.findIndex(
          (message, index) => index > 0 && message.role !== 'system',
        );
        if (removable < 0) break;
        messages.splice(removable, 1);
      }
    }

    const categoryTokens = new Map<ContextBreakdown['sources'][number]['source'], number>();
    for (const source of sources) {
      categoryTokens.set(
        source.source,
        (categoryTokens.get(source.source) ?? 0) + estimateTokens(source.content),
      );
    }
    categoryTokens.set('history', countMessages(input.messages));
    const systemTokens = input.messages
      .filter((message) => message.role === 'system')
      .reduce((total, message) => total + estimateTokens(messageText(message)), 0);
    if (systemTokens > 0) categoryTokens.set('system', systemTokens);
    const totalTokens = countMessages(messages);
    return {
      messages,
      breakdown: {
        totalTokens,
        contextWindow: input.contextWindow,
        utilization: totalTokens / input.contextWindow,
        compressed,
        sources: [...categoryTokens.entries()].map(([source, tokens]) => ({
          source,
          tokens,
          percentage: totalTokens === 0 ? 0 : Math.min(100, (tokens / totalTokens) * 100),
        })),
      },
    };
  }
}
