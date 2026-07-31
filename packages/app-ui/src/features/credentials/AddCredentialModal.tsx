import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import type { CredentialInput } from '../../lib/transport';
import type { Credential, ProviderConfig } from '../../types';

function limitValue(value: string, editing: boolean): number | null | undefined {
  if (value !== '') return Number(value);
  return editing ? null : undefined;
}

export function AddCredentialModal({
  credential,
  onClose,
  onSubmit,
  open,
  provider,
}: {
  open: boolean;
  provider: ProviderConfig;
  credential?: Credential;
  onClose: () => void;
  onSubmit: (input: CredentialInput) => Promise<void>;
}): React.JSX.Element {
  const editing = credential !== undefined;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [priority, setPriority] = useState(100);
  const [dailyLimit, setDailyLimit] = useState('');
  const [monthlyLimit, setMonthlyLimit] = useState('');
  const [quotaUnit, setQuotaUnit] = useState<NonNullable<CredentialInput['quotaUnit']>>('usd');
  const [proxyUrl, setProxyUrl] = useState('');
  const [clearProxy, setClearProxy] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setName(credential?.name ?? '');
    setApiKey('');
    setPriority(credential?.priority ?? 100);
    setDailyLimit(credential?.dailyLimit?.toString() ?? '');
    setMonthlyLimit(credential?.monthlyLimit?.toString() ?? '');
    setQuotaUnit(credential?.quotaUnit ?? 'usd');
    setProxyUrl('');
    setClearProxy(false);
    setEnabled(credential?.enabled ?? true);
  }, [credential, open, provider.id]);

  const close = (): void => {
    setApiKey('');
    setProxyUrl('');
    setSubmitError(null);
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const normalizedProxy = proxyUrl.trim();
      await onSubmit({
        name: name.trim(),
        providerId: provider.id,
        provider: provider.name,
        apiKey: apiKey || (!editing && provider.type === 'ollama' ? 'ollama-local' : ''),
        strategy: provider.keyStrategy,
        priority,
        dailyLimit: limitValue(dailyLimit, editing),
        monthlyLimit: limitValue(monthlyLimit, editing),
        quotaUnit,
        proxyUrl: clearProxy ? null : normalizedProxy || undefined,
        enabled,
      });
      close();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '无法保存 API Key，请检查配置后重试。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      description={
        editing
          ? `正在编辑 ${provider.name} 下的 Key。敏感字段不会回显，留空即保留原值。`
          : `Key 将添加到 ${provider.name}，并在主进程或服务端立即加密。`
      }
      footer={
        <>
          <Button onClick={close} variant="ghost">
            取消
          </Button>
          <Button form="credential-form" loading={submitting} type="submit" variant="primary">
            {editing ? '保存修改' : '加密并保存'}
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title={editing ? '编辑 API Key' : '添加 API Key'}
    >
      <form className="form-grid" id="credential-form" onSubmit={(event) => void submit(event)}>
        <div className="form-grid__wide credential-provider-context">
          <span>
            <small>所属服务商</small>
            <strong>{provider.name}</strong>
          </span>
          <code>{provider.baseUrl}</code>
        </div>
        <Field
          label="Key 名称"
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：生产主账号"
          required
          value={name}
        />
        <Field
          label="优先级"
          min={0}
          onChange={(event) => setPriority(Number(event.target.value))}
          type="number"
          value={priority}
        />
        <Field
          autoComplete="new-password"
          className="form-grid__wide"
          description={
            editing
              ? `当前为 •••• ${credential.lastFour}；留空即保留，不会读取或回显原密钥。`
              : provider.type === 'ollama'
                ? '本地 Ollama 通常无需 Key，可直接留空。'
                : '密钥只在此处输入一次，保存后不再回显明文。'
          }
          label={editing ? '新 API Key（可选）' : 'API Key'}
          onChange={(event) => setApiKey(event.target.value)}
          required={!editing && provider.type !== 'ollama'}
          type="password"
          value={apiKey}
        />
        <Field
          label={`日限额（${quotaUnit === 'usd' ? 'USD' : 'Token'}）`}
          min={quotaUnit === 'usd' ? 0.01 : 1}
          onChange={(event) => setDailyLimit(event.target.value)}
          step={quotaUnit === 'usd' ? '0.01' : '1'}
          type="number"
          value={dailyLimit}
        />
        <Field
          label={`月限额（${quotaUnit === 'usd' ? 'USD' : 'Token'}）`}
          min={quotaUnit === 'usd' ? 0.01 : 1}
          onChange={(event) => setMonthlyLimit(event.target.value)}
          step={quotaUnit === 'usd' ? '0.01' : '1'}
          type="number"
          value={monthlyLimit}
        />
        <label className="field form-grid__wide">
          <span className="field__label">额度单位</span>
          <Select
            onChange={(event) =>
              setQuotaUnit(event.target.value as NonNullable<CredentialInput['quotaUnit']>)
            }
            value={quotaUnit}
          >
            <option value="usd">美元（USD）</option>
            <option value="tokens">Token 数</option>
          </Select>
        </label>
        <Field
          className="form-grid__wide"
          description={
            editing && credential.proxyMode === 'http'
              ? '已配置加密代理；留空保留原代理，输入新地址则替换。'
              : '代理认证信息同样进入加密密钥库。'
          }
          disabled={clearProxy}
          label="HTTP 代理（可选）"
          onChange={(event) => setProxyUrl(event.target.value)}
          placeholder="http://127.0.0.1:7890"
          type="url"
          value={proxyUrl}
        />
        {editing && credential.proxyMode === 'http' ? (
          <label className="credential-clear-secret form-grid__wide">
            <input
              checked={clearProxy}
              onChange={(event) => setClearProxy(event.target.checked)}
              type="checkbox"
            />
            清除已保存的代理
          </label>
        ) : null}
        {editing ? (
          <div className="form-grid__wide">
            <Switch
              checked={enabled}
              description="停用后该 Key 不参与请求调度，但配置和历史用量仍会保留。"
              label="启用 API Key"
              onChange={setEnabled}
            />
          </div>
        ) : null}
        {submitError ? (
          <p className="form-grid__wide credential-form__error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
