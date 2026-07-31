import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EAgentTransport } from '../lib/transport';
import type { AppSettings } from '../types';

import { useSettingsStore } from './settings-store';

function currentSettings(): AppSettings {
  return { ...useSettingsStore.getState().settings };
}

describe('settings store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('lang');
    useSettingsStore.setState({
      settings: {
        ...currentSettings(),
        theme: 'dark',
        locale: 'zh-CN',
      },
      loading: false,
      error: null,
    });
  });

  it('加载设置后同步主题、语言和本地缓存', async () => {
    const settings = {
      ...currentSettings(),
      theme: 'light',
      locale: 'en-US',
    };
    await useSettingsStore
      .getState()
      .load({ getSettings: vi.fn().mockResolvedValue(settings) } as unknown as EAgentTransport);

    expect(useSettingsStore.getState()).toMatchObject({
      settings,
      loading: false,
      error: null,
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.lang).toBe('en-US');
    expect(window.localStorage.getItem('e-agent-theme')).toBe('light');
    expect(window.localStorage.getItem('e-agent-locale')).toBe('en-US');
  });

  it('加载失败时保留现有设置并区分标准与未知错误', async () => {
    const before = currentSettings();
    await useSettingsStore.getState().load({
      getSettings: vi.fn().mockRejectedValue(new Error('settings offline')),
    } as unknown as EAgentTransport);
    expect(useSettingsStore.getState()).toMatchObject({
      settings: before,
      loading: false,
      error: 'settings offline',
    });
    expect(document.documentElement.dataset.theme).toBe(before.theme);

    await useSettingsStore.getState().load({
      getSettings: vi.fn().mockRejectedValue('offline'),
    } as unknown as EAgentTransport);
    expect(useSettingsStore.getState().error).toEqual(expect.any(String));
    expect(useSettingsStore.getState().error).not.toBe('');
  });

  it('乐观保存设置，并用服务端规范化后的结果覆盖', async () => {
    const response = {
      ...currentSettings(),
      theme: 'light',
      maxConcurrency: 8,
    };
    const updateSettings = vi.fn().mockResolvedValue(response);

    await useSettingsStore.getState().update({ updateSettings } as unknown as EAgentTransport, {
      theme: 'light',
      maxConcurrency: 99,
    });

    expect(updateSettings).toHaveBeenCalledWith({ theme: 'light', maxConcurrency: 99 });
    expect(useSettingsStore.getState().settings).toEqual(response);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('并发保存响应乱序时保留最后一次选择，不让旧响应覆盖新值', async () => {
    const before = currentSettings();
    let resolveFirst!: (settings: AppSettings) => void;
    let resolveSecond!: (settings: AppSettings) => void;
    const firstResponse = new Promise<AppSettings>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<AppSettings>((resolve) => {
      resolveSecond = resolve;
    });
    const updateSettings = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse);
    const transport = { updateSettings } as unknown as EAgentTransport;

    const first = useSettingsStore.getState().update(transport, { theme: 'light' });
    const second = useSettingsStore.getState().update(transport, { theme: 'sunrise' });

    resolveSecond({ ...before, theme: 'sunrise' });
    await second;
    resolveFirst({ ...before, theme: 'light' });
    await first;

    expect(useSettingsStore.getState().settings.theme).toBe('sunrise');
    expect(document.documentElement.dataset.theme).toBe('sunrise');
    expect(window.localStorage.getItem('e-agent-theme')).toBe('sunrise');
  });

  it('保存失败时完整回滚视觉和状态，并继续抛出错误', async () => {
    const before = currentSettings();
    const expected = new Error('save failed');

    await expect(
      useSettingsStore.getState().update(
        {
          updateSettings: vi.fn().mockRejectedValue(expected),
        } as unknown as EAgentTransport,
        { theme: 'light', locale: 'en-US' },
      ),
    ).rejects.toBe(expected);

    expect(useSettingsStore.getState()).toMatchObject({
      settings: before,
      error: 'save failed',
    });
    expect(document.documentElement.dataset.theme).toBe(before.theme);
    expect(document.documentElement.lang).toBe(before.locale);

    await expect(
      useSettingsStore.getState().update(
        {
          updateSettings: vi.fn().mockRejectedValue(null),
        } as unknown as EAgentTransport,
        { theme: 'light' },
      ),
    ).rejects.toBeNull();
    expect(useSettingsStore.getState().error).toEqual(expect.any(String));
  });

  it('立即应用主题并更新本地偏好', () => {
    useSettingsStore.getState().applyTheme('warm-sun');

    expect(useSettingsStore.getState().settings.theme).toBe('warm-sun');
    expect(document.documentElement.dataset.theme).toBe('warm-sun');
    expect(window.localStorage.getItem('e-agent-theme')).toBe('warm-sun');
  });
});
