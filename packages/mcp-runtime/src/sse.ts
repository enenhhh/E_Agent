import { McpRuntimeError } from './errors.js';

export interface SseConsumeOptions {
  maxEventBytes: number;
  signal?: AbortSignal;
  onData: (data: string, eventId?: string) => boolean | Promise<boolean>;
}

/** 增量解析 SSE，避免将长生命周期响应整体读入内存。返回 true 表示调用方主动停止。 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  options: SseConsumeOptions,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventId: string | undefined;
  let eventBytes = 0;
  const abort = (): void => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    let finished = false;
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        buffer += decoder.decode();
        if (buffer.length > 0) buffer += '\n';
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      let newline = findNewline(buffer);
      while (newline !== undefined) {
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline.length);
        if (line === '') {
          if (dataLines.length > 0) {
            const data = dataLines.join('\n');
            const shouldStop = await options.onData(data, eventId);
            dataLines = [];
            eventId = undefined;
            eventBytes = 0;
            if (shouldStop) {
              await reader.cancel();
              return true;
            }
          }
        } else if (!line.startsWith(':')) {
          const separator = line.indexOf(':');
          const field = separator < 0 ? line : line.slice(0, separator);
          let value = separator < 0 ? '' : line.slice(separator + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') {
            eventBytes += Buffer.byteLength(value, 'utf8');
            if (eventBytes > options.maxEventBytes) {
              throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP SSE 事件超过大小限制。');
            }
            dataLines.push(value);
          } else if (field === 'id' && !value.includes('\0')) {
            eventId = value;
          }
        }
        newline = findNewline(buffer);
      }
      if (Buffer.byteLength(buffer, 'utf8') > options.maxEventBytes) {
        throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP SSE 行超过大小限制。');
      }
      if (chunk.done) {
        if (dataLines.length > 0) {
          return await options.onData(dataLines.join('\n'), eventId);
        }
        return false;
      }
    }
    return false;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function findNewline(value: string): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\n') return { index, length: 1 };
    if (character === '\r') {
      return { index, length: value[index + 1] === '\n' ? 2 : 1 };
    }
  }
  return undefined;
}
