import { describe, expect, it, vi } from 'vitest';

import { parseSseStream, SseProtocolError } from '../src/index.js';

function textStream(chunks: string[], cancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
    cancel,
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  return events;
}

describe('SSE parser', () => {
  it('parses metadata, comments, field whitespace and multiline data', async () => {
    const events = await collect(
      textStream([
        ': keepalive\n',
        'event: message\nid: 42\nretry: 1500\n',
        'data:first\ndata: second\nunknown: ignored\n\n',
      ]),
    );

    expect(events).toEqual([
      {
        event: 'message',
        id: '42',
        retry: 1500,
        data: 'first\nsecond',
      },
    ]);
  });

  it('ignores empty blocks, invalid retry values and null-containing IDs', async () => {
    const events = await collect(
      textStream(['event: ping\n\n', 'id: bad\0id\nretry: no\ndata: ok\r\r']),
    );

    expect(events).toEqual([{ data: 'ok' }]);
  });

  it('emits a final unterminated event at EOF', async () => {
    await expect(collect(textStream(['data: final']))).resolves.toEqual([{ data: 'final' }]);
  });

  it.each([0, -1, 1.2, Number.NaN])('rejects invalid buffer limit %s', async (limit) => {
    await expect(
      (async () => {
        for await (const _event of parseSseStream(textStream([]), undefined, {
          maxBufferCharacters: limit,
        })) {
          // The invalid configuration must fail before consumption.
        }
      })(),
    ).rejects.toBeInstanceOf(Error);
  });

  it('uses the dedicated protocol error for an oversized event', async () => {
    await expect(
      (async () => {
        for await (const _event of parseSseStream(textStream(['data: 123456']), undefined, {
          maxBufferCharacters: 4,
        })) {
          // No event is expected.
        }
      })(),
    ).rejects.toBeInstanceOf(SseProtocolError);
  });

  it('throws an already-aborted signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);

    await expect(
      (async () => {
        for await (const _event of parseSseStream(textStream([]), controller.signal)) {
          // No event is expected.
        }
      })(),
    ).rejects.toBe(reason);
  });

  it('cancels a pending read when the signal aborts', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const iterator = parseSseStream(stream, controller.signal);
    const pending = iterator.next();

    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
  });
});
