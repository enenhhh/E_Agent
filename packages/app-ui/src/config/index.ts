export const clientConfig = {
  appName: 'E Agent',
  defaultLocale: 'zh-CN',
  defaultTheme: 'ink',
  defaultModel: 'deepseek-v4-flash',
  requestTimeoutMs: 30_000,
  streamIdleTimeoutMs: 90_000,
  maxAttachmentBytes: 2 * 1024 * 1024,
  contextWarningRatio: 0.7,
  sessionSnapshotInterval: 50,
} as const;

export const keyboardShortcuts = {
  send: 'Ctrl+Enter',
  inputHistory: 'Ctrl+R',
  stop: 'Esc',
  newConversation: 'Ctrl+Shift+N',
  search: 'Ctrl+P',
  toggleSidebar: 'Ctrl+B',
} as const;

export type ThemeId =
  | 'ink'
  | 'paper'
  | 'high-contrast'
  | 'cyber'
  | 'sunrise'
  | 'forest'
  | 'ocean'
  | 'rose'
  | 'slate'
  | 'nord'
  | 'dracula'
  | 'solarized';

export const themes: ReadonlyArray<{ id: ThemeId; labelZh: string; labelEn: string }> = [
  { id: 'ink', labelZh: '墨色', labelEn: 'Ink' },
  { id: 'paper', labelZh: '纸白', labelEn: 'Paper' },
  { id: 'high-contrast', labelZh: '高对比', labelEn: 'High contrast' },
  { id: 'cyber', labelZh: '赛博朋克', labelEn: 'Cyberpunk' },
  { id: 'sunrise', labelZh: '暖阳', labelEn: 'Sunrise' },
  { id: 'forest', labelZh: '森林', labelEn: 'Forest' },
  { id: 'ocean', labelZh: '深海', labelEn: 'Ocean' },
  { id: 'rose', labelZh: '玫瑰', labelEn: 'Rose' },
  { id: 'slate', labelZh: '石板', labelEn: 'Slate' },
  { id: 'nord', labelZh: '北境', labelEn: 'Nord' },
  { id: 'dracula', labelZh: '夜爵', labelEn: 'Dracula' },
  { id: 'solarized', labelZh: '日光', labelEn: 'Solarized' },
];
