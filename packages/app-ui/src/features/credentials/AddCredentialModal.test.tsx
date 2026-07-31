import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credential, ProviderConfig } from '../../types';

import { AddCredentialModal } from './AddCredentialModal';

const provider: ProviderConfig = {
  id: 'provider-1',
  type: 'custom',
  name: 'LCAPI',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
  keyStrategy: 'round-robin',
};

const credential: Credential = {
  id: 'key-1',
  name: 'LCAPI 主账号',
  providerId: provider.id,
  providerName: provider.name,
  providerType: provider.type,
  provider: provider.name,
  lastFour: '1234',
  status: 'healthy',
  strategy: 'round-robin',
  priority: 10,
  dailyUsed: 0,
  dailyLimit: 5,
  monthlyUsed: 0,
  monthlyLimit: 50,
  quotaUnit: 'usd',
  proxyMode: 'http',
  enabled: true,
};

afterEach(cleanup);

function fillRequiredFields(): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Key 名称' }), {
    target: { value: 'LCAPI 主账号' },
  });
  fireEvent.change(screen.getByLabelText('API Key'), {
    target: { value: 'sk-test-secret' },
  });
}

describe('AddCredentialModal', () => {
  it('提交失败时在模态框内展示错误、保持打开并允许重试', async () => {
    const onClose = vi.fn();
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('服务商拒绝了这个 Key'))
      .mockResolvedValueOnce(undefined);
    render(<AddCredentialModal onClose={onClose} onSubmit={onSubmit} open provider={provider} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: '加密并保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('服务商拒绝了这个 Key');
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '加密并保存' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: '加密并保存' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('非 Error 失败使用友好兜底文案，重新打开时清除旧错误和明文 Key', async () => {
    const onSubmit = vi.fn().mockRejectedValue('unknown failure');
    const onClose = vi.fn();
    const { rerender } = render(
      <AddCredentialModal onClose={onClose} onSubmit={onSubmit} open provider={provider} />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '加密并保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法保存 API Key，请检查配置后重试。',
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <AddCredentialModal onClose={onClose} onSubmit={onSubmit} open={false} provider={provider} />,
    );
    rerender(<AddCredentialModal onClose={onClose} onSubmit={onSubmit} open provider={provider} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toHaveValue('');
  });

  it('成功时提交所选服务商 ID 和规范化 Key 配置', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AddCredentialModal onClose={onClose} onSubmit={onSubmit} open provider={provider} />);
    fillRequiredFields();

    fireEvent.click(screen.getByRole('button', { name: '加密并保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'LCAPI 主账号',
          providerId: provider.id,
          provider: provider.name,
          apiKey: 'sk-test-secret',
          strategy: 'round-robin',
          priority: 100,
          quotaUnit: 'usd',
        }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('编辑时不回显敏感值，Key 和代理留空表示保留原值', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AddCredentialModal
        credential={credential}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        open
        provider={provider}
      />,
    );

    const secretInput = screen.getByLabelText('新 API Key（可选）');
    expect(secretInput).toHaveValue('');
    expect(secretInput).not.toHaveValue(credential.lastFour);
    expect(screen.getByRole('textbox', { name: 'HTTP 代理（可选）' })).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: '',
          proxyUrl: undefined,
          dailyLimit: 5,
          monthlyLimit: 50,
        }),
      );
    });
  });
});
