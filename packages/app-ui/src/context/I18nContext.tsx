import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import type { Locale } from '../types';

const messages = {
  'zh-CN': {
    workspace: '工作台',
    models: '模型',
    credentials: '密钥',
    costs: '成本',
    skills: 'Skills',
    plugins: '插件',
    tutorial: '教程',
    settings: '设置',
    admin: '团队',
    newConversation: '新建会话',
    searchConversations: '搜索会话…',
    today: '今天',
    earlier: '更早',
    connected: '已连接',
    disconnected: '未连接',
    queue: '请求队列',
    sendPlaceholder: '发送消息，输入 @ 添加上下文',
    loading: '正在加载…',
    retry: '重试',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    enable: '启用',
    disable: '禁用',
  },
  'en-US': {
    workspace: 'Workspace',
    models: 'Models',
    credentials: 'API keys',
    costs: 'Costs',
    skills: 'Skills',
    plugins: 'Plugins',
    tutorial: 'Tutorial',
    settings: 'Settings',
    admin: 'Team',
    newConversation: 'New conversation',
    searchConversations: 'Search conversations…',
    today: 'Today',
    earlier: 'Earlier',
    connected: 'Connected',
    disconnected: 'Disconnected',
    queue: 'Request queue',
    sendPlaceholder: 'Send a message, type @ to add context',
    loading: 'Loading…',
    retry: 'Retry',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    enable: 'Enable',
    disable: 'Disable',
  },
} as const;

export type MessageKey = keyof (typeof messages)['zh-CN'];

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getInitialLocale(): Locale {
  const saved = window.localStorage.getItem('e-agent-locale');
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved;
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function I18nProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);
  const setLocale = useCallback((nextLocale: Locale) => {
    window.localStorage.setItem('e-agent-locale', nextLocale);
    document.documentElement.lang = nextLocale;
    setLocaleState(nextLocale);
  }, []);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => messages[locale][key],
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n 必须在 I18nProvider 内使用。');
  }
  return value;
}
