import { create } from 'zustand';

import { clientConfig, type ThemeId } from '../config';
import type { EAgentTransport } from '../lib/transport';
import type { AppSettings } from '../types';

const defaults: AppSettings = {
  locale: 'zh-CN',
  theme: clientConfig.defaultTheme,
  defaultModels: {
    code: clientConfig.defaultModel,
    chat: clientConfig.defaultModel,
    summarize: clientConfig.defaultModel,
  },
  maxConcurrency: 5,
  costAlertThreshold: 5,
  autoCompressContext: true,
  autoUpdate: true,
  telemetryEnabled: false,
  ollamaFallback: false,
  reasoningDisplay: 'collapsed',
  toolExecutionPolicy: 'always-ask',
  toolCommandTimeoutMs: 60_000,
  toolOutputLimitBytes: 131_072,
  tutorialCompletedVersion: 0,
  autoExpandRunningTools: true,
};

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  error: string | null;
  load: (transport: EAgentTransport) => Promise<void>;
  update: (transport: EAgentTransport, input: Partial<AppSettings>) => Promise<void>;
  applyTheme: (theme: string) => void;
}

let settingsUpdateRevision = 0;

function persistVisualSettings(settings: AppSettings): void {
  window.localStorage.setItem('e-agent-theme', settings.theme);
  window.localStorage.setItem('e-agent-locale', settings.locale);
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.lang = settings.locale;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {
    ...defaults,
    theme: window.localStorage.getItem('e-agent-theme') ?? defaults.theme,
  },
  loading: false,
  error: null,

  load: async (transport) => {
    set({ loading: true, error: null });
    try {
      const settings = await transport.getSettings();
      persistVisualSettings(settings);
      set({ settings, loading: false });
    } catch (error) {
      persistVisualSettings(get().settings);
      set({
        loading: false,
        error: error instanceof Error ? error.message : '设置加载失败。',
      });
    }
  },

  update: async (transport, input) => {
    const revision = ++settingsUpdateRevision;
    const previous = get().settings;
    const optimistic = { ...previous, ...input };
    persistVisualSettings(optimistic);
    set({ settings: optimistic, error: null });
    try {
      const settings = await transport.updateSettings(input);
      if (revision !== settingsUpdateRevision) {
        return;
      }
      persistVisualSettings(settings);
      set({ settings });
    } catch (error) {
      if (revision !== settingsUpdateRevision) {
        return;
      }
      persistVisualSettings(previous);
      set({
        settings: previous,
        error: error instanceof Error ? error.message : '设置保存失败。',
      });
      throw error;
    }
  },

  applyTheme: (theme) => {
    document.documentElement.dataset.theme = theme as ThemeId;
    window.localStorage.setItem('e-agent-theme', theme);
    set((state) => ({ settings: { ...state.settings, theme } }));
  },
}));
