export interface ServerSentEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

const DEFAULT_MAX_BUFFER_CHARACTERS = 8 * 1024 * 1024;

export interface SseParserOptions {
  maxBufferCharacters?: number;
}

/** 上游流没有按 SSE 事件边界结束，或单个事件超过安全上限。 */
export class SseProtocolError extends Error {
  public readonly code = 'INVALID_PROVIDER_STREAM';

  public constructor(message: string) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

function parseBlock(block: string): ServerSentEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0) return undefined;
  return {
    data: data.join('\n'),
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

function nextBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /(?:\r\n|\r|\n){2}/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

/** 增量解析 SSE，正确处理 CRLF、多行 data 和分块边界。 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: SseParserOptions = {},
): AsyncGenerator<ServerSentEvent> {
  const maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_MAX_BUFFER_CHARACTERS;
  if (!Number.isInteger(maxBufferCharacters) || maxBufferCharacters < 1) {
    throw new Error('SSE 缓冲区上限必须是正整数');
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      buffer += decoder.decode(value, { stream: !done });
      let boundary = nextBoundary(buffer);
      while (boundary !== undefined) {
        const event = parseBlock(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        if (event !== undefined) yield event;
        boundary = nextBoundary(buffer);
      }
      if (buffer.length > maxBufferCharacters) {
        throw new SseProtocolError('上游 SSE 单个事件超过大小上限');
      }
      if (done) {
        completed = true;
        break;
      }
    }
    if (buffer.trim() !== '') {
      const event = parseBlock(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
