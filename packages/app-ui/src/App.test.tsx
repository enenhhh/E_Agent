import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EAgentApp } from './App';
import type { EAgentTransport } from './lib/transport';
import { useAuthStore } from './stores/auth-store';
import { useConversationStore } from './stores/conversation-store';
import { useSettingsStore } from './stores/settings-store';
import type { AppSettings } from './types';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function settings(tutorialCompletedVersion: number): AppSettings {
  return {
    ...useSettingsStore.getState().settings,
    tutorialCompletedVersion,
  };
}

function transport(appSettings: AppSettings): EAgentTransport {
  return {
    kind: 'mock',
    getSettings: async () => appSettings,
    listModels: async () => [],
    listSkills: async () => [],
    listConversations: async () => [],
    getQueueStatus: async () => ({ running: 0, queued: 0 }),
    getUsageSummary: async () => ({
      range: 'day',
      totalCost: 0,
      totalTokens: 0,
      requests: 0,
      cacheHitRate: 0,
      budget: 5,
      trend: [],
      byModel: [],
    }),
  } as unknown as EAgentTransport;
}

describe('EAgentApp tutorial entry', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    window.localStorage.clear();
    window.history.replaceState(null, '', '/workspace');
    useAuthStore.setState({
      status: 'authenticated',
      error: null,
      session: {
        user: {
          id: 'owner',
          name: 'Owner',
          email: 'owner@example.test',
          role: 'owner',
          active: true,
        },
        expiresAt: '2026-07-30T00:00:00.000Z',
      },
    });
    useConversationStore.setState({
      conversations: [],
      selectedId: null,
      messages: [],
      loading: false,
    });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, tutorialCompletedVersion: 0 },
      loading: false,
      error: null,
    }));
  });

  it('设置加载完成后将首次用户引导到教程', async () => {
    render(<EAgentApp mode="web" transport={transport(settings(0))} />);

    // 此处只验证 App 的首次使用路由职责；教程页面内容由 TutorialPage 单测
    // 与 E2E 覆盖，避免把动态分包加载时序耦合进路由测试。
    await waitFor(
      () => {
        expect(window.location.pathname).toBe('/tutorial');
      },
      { timeout: 10_000 },
    );
  }, 15_000);

  it('已完成当前版本教程的用户直接进入工作台', async () => {
    render(<EAgentApp mode="web" transport={transport(settings(1))} />);

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.tutorialCompletedVersion).toBe(1);
      expect(window.location.pathname).toBe('/workspace');
    });
    expect(screen.queryByText('E Agent 快速上手')).not.toBeInTheDocument();
  });
});
