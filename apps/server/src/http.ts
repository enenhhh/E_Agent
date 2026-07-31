import { once } from 'node:events';

import type { ChatStreamEvent } from '@e-agent/contracts';
import type { FastifyReply } from 'fastify';

export function idParam(value: unknown, field = 'id'): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !(field in value) ||
    typeof (value as Record<string, unknown>)[field] !== 'string'
  ) {
    throw new TypeError(`缺少路径参数 ${field}`);
  }
  return (value as Record<string, string>)[field]!;
}

/** 将 JSON 事件编码成标准 SSE 帧，避免数据中的换行破坏协议。 */
export function encodeSseEvent(event: ChatStreamEvent): string {
  const id = event.type === 'start' ? `id: ${event.requestId}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function writeSse(reply: FastifyReply, frame: string): Promise<void> {
  if (!reply.raw.write(frame, 'utf8')) await once(reply.raw, 'drain');
}
