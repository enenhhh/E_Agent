import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from './toast-store';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000004')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000005');
    useToastStore.setState({ messages: [] });
  });

  it('仅保留最近四条消息，并在五秒后自动移除', () => {
    for (let index = 1; index <= 5; index += 1) {
      useToastStore.getState().push({
        title: `message-${index}`,
        kind: 'info',
      });
    }

    expect(useToastStore.getState().messages.map((message) => message.title)).toEqual([
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);

    vi.advanceTimersByTime(5_000);
    expect(useToastStore.getState().messages).toEqual([]);
    vi.useRealTimers();
  });

  it('支持用户主动关闭指定消息', () => {
    const id = useToastStore.getState().push({
      title: 'saved',
      description: 'settings saved',
      kind: 'success',
    });
    useToastStore.getState().remove(id);

    expect(useToastStore.getState().messages).toEqual([]);
    vi.useRealTimers();
  });
});
