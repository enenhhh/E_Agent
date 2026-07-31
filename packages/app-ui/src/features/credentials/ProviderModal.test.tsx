import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfig } from '../../types';

import { ProviderModal } from './ProviderModal';

const provider: ProviderConfig = {
  id: 'provider-1',
  type: 'custom',
  name: 'LCAPI',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
  keyStrategy: 'round-robin',
};

afterEach(cleanup);

describe('ProviderModal', () => {
  it('独立创建服务商，并提交类型、地址和调度策略', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProviderModal onClose={vi.fn()} onSubmit={onSubmit} open />);

    fireEvent.change(screen.getByRole('textbox', { name: '服务商名称' }), {
      target: { value: 'LCAPI' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'API Base URL' }), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Key 调度策略' }), {
      target: { value: 'priority' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存服务商' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        type: 'custom',
        name: 'LCAPI',
        baseUrl: 'https://api.example.com/v1',
        keyStrategy: 'priority',
        enabled: true,
      });
    });
  });

  it('编辑服务商时预填非敏感配置并允许停用', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProviderModal onClose={vi.fn()} onSubmit={onSubmit} open provider={provider} />);

    expect(screen.getByRole('textbox', { name: '服务商名称' })).toHaveValue('LCAPI');
    expect(screen.getByRole('textbox', { name: 'API Base URL' })).toHaveValue(provider.baseUrl);
    fireEvent.click(screen.getByRole('checkbox', { name: /^启用服务商/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
  });
});
