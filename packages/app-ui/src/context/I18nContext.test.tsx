import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, useI18n } from './I18nContext';

function I18nProbe(): React.JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <output>{locale}</output>
      <span>{t('workspace')}</span>
      <button onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')} type="button">
        切换语言
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('I18nContext', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('lang');
  });

  it('优先恢复已保存语言并在切换后同步文案、存储和文档语言', () => {
    window.localStorage.setItem('e-agent-locale', 'en-US');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');

    render(
      <I18nProvider>
        <I18nProbe />
      </I18nProvider>,
    );

    expect(screen.getByText('en-US')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '切换语言' }));

    expect(screen.getByText('zh-CN')).toBeInTheDocument();
    expect(screen.getByText('工作台')).toBeInTheDocument();
    expect(window.localStorage.getItem('e-agent-locale')).toBe('zh-CN');
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
  });

  it('无有效偏好时根据中文系统语言初始化', () => {
    window.localStorage.setItem('e-agent-locale', 'invalid-locale');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-Hans-CN');

    render(
      <I18nProvider>
        <I18nProbe />
      </I18nProvider>,
    );

    expect(screen.getByText('zh-CN')).toBeInTheDocument();
    expect(screen.getByText('工作台')).toBeInTheDocument();
  });

  it('非中文系统语言默认使用英文', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');

    render(
      <I18nProvider>
        <I18nProbe />
      </I18nProvider>,
    );

    expect(screen.getByText('en-US')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('缺少 Provider 时立即给出可定位的开发错误', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<I18nProbe />)).toThrow('useI18n 必须在 I18nProvider 内使用。');
  });
});
