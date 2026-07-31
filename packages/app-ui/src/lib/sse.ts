import type { StreamEvent } from '../types';

import { TransportError } from './transport';

const decoder = new TextDecoder();

function parseBlock(block: string): StreamEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') {
    return {
      type: 'done',
      requestId: 'unknown',
    };
  }

  try {
    return JSON.parse(payload) as StreamEvent;
  } catch {
    throw new TransportError('服务端返回了无法解析的流式数据。', {
      code: 'INVALID_STREAM_EVENT',
    });
  }
}

/**
 * 将 Fetch Response 的字节流解析为标准 SSE 事件。
 */
export async function* parseSseResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    throw new TransportError('当前环境不支持流式响应。', {
      code: 'STREAM_UNAVAILABLE',
    });
  }

  const reader = response.body.getReader();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('请求已取消', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseBlock(block);
        if (event) {
          yield event;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    const finalEvent = parseBlock(buffer);
    if (finalEvent) {
      yield finalEvent;
    }
  } finally {
    reader.releaseLock();
  }
}
