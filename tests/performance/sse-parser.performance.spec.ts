import { performance } from 'node:perf_hooks';

import { parseSseStream } from '@e-agent/ai-runtime';
import { describe, expect, it } from 'vitest';

function createChunkedStream(payload: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  let chunkIndex = 0;
  const chunkSizes = [1, 3, 7, 31, 127, 1024];

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      const chunkSize = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
      const end = Math.min(payload.byteLength, offset + chunkSize);
      controller.enqueue(payload.slice(offset, end));
      offset = end;
      chunkIndex += 1;
    },
  });
}

describe('SSE parser performance budget', () => {
  it('parses 10,000 fragmented events without losing order', async () => {
    const eventCount = 10_000;
    const source = Array.from(
      { length: eventCount },
      (_, index) => `id: ${index}\ndata: {"index":${index},"text":"增量"}\n\n`,
    ).join('');
    const stream = createChunkedStream(new TextEncoder().encode(source));
    const startedAt = performance.now();
    let parsedCount = 0;
    let lastId = -1;

    for await (const event of parseSseStream(stream)) {
      parsedCount += 1;
      lastId = Number(event.id);
      if (parsedCount === 1) {
        expect(event.data).toContain('"index":0');
      }
    }

    const durationMilliseconds = performance.now() - startedAt;
    expect(parsedCount).toBe(eventCount);
    expect(lastId).toBe(eventCount - 1);
    // 这是算法退化门禁，不是精确基准；阈值为共享 CI 留出充足抖动空间。
    expect(durationMilliseconds).toBeLessThan(5_000);
  });

  it('honors cancellation instead of buffering the rest of an unbounded stream', async () => {
    const controller = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulls += 1;
        streamController.enqueue(new TextEncoder().encode(`data: ${pulls}\n\n`));
      },
    });
    const events = parseSseStream(stream, controller.signal);

    await expect(events.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ data: '1' }),
      }),
    );
    controller.abort(new Error('performance test cancellation'));
    await expect(events.next()).rejects.toThrow('performance test cancellation');
    expect(pulls).toBeLessThan(10);
  });
});
