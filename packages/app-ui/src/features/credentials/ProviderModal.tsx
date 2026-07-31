import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import type { ProviderInput } from '../../lib/transport';
import type { ProviderConfig, ProviderType } from '../../types';

const providerOptions: Array<{
  type: ProviderType;
  label: string;
  defaultBaseUrl: string;
}> = [
  { type: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  { type: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1' },
  { type: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { type: 'groq', label: 'Groq', defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  {
    type: 'google',
    label: 'Google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { type: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
  { type: 'custom', label: 'OpenAI 兼容 / 自定义', defaultBaseUrl: 'https://api.example.com/v1' },
];

function optionFor(type: ProviderType) {
  return providerOptions.find((option) => option.type === type) ?? providerOptions.at(-1)!;
}

export function ProviderModal({
  onClose,
  onSubmit,
  open,
  provider,
}: {
  open: boolean;
  provider?: ProviderConfig;
  onClose: () => void;
  onSubmit: (input: ProviderInput) => Promise<void>;
}): React.JSX.Element {
  const editing = provider !== undefined;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [type, setType] = useState<ProviderType>('custom');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(optionFor('custom').defaultBaseUrl);
  const [keyStrategy, setKeyStrategy] = useState<ProviderConfig['keyStrategy']>('round-robin');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    const nextType = provider?.type ?? 'custom';
    setSubmitError(null);
    setType(nextType);
    setName(provider?.name ?? '');
    setBaseUrl(provider?.baseUrl ?? optionFor(nextType).defaultBaseUrl);
    setKeyStrategy(provider?.keyStrategy ?? 'round-robin');
    setEnabled(provider?.enabled ?? true);
  }, [open, provider]);

  const changeType = (nextType: ProviderType): void => {
    const previousDefault = optionFor(type).defaultBaseUrl;
    setType(nextType);
    if (!editing && (baseUrl === previousDefault || baseUrl.trim() === '')) {
      setBaseUrl(optionFor(nextType).defaultBaseUrl);
    }
    if (!editing && name.trim() === '') {
      const option = optionFor(nextType);
      setName(option.type === 'custom' ? '' : option.label);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        type,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        keyStrategy,
        enabled,
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '无法保存服务商，请检查配置后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      description="服务商保存模型接口地址和调度策略；保存后可在服务商下添加多个 API Key。"
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button form="provider-form" loading={submitting} type="submit" variant="primary">
            {editing ? '保存修改' : '保存服务商'}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={editing ? '编辑服务商' : '添加服务商'}
    >
      <form className="form-grid" id="provider-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">服务商类型</span>
          <Select onChange={(event) => changeType(event.target.value as ProviderType)} value={type}>
            {providerOptions.map((option) => (
              <option key={option.type} value={option.type}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Key 调度策略</span>
          <Select
            onChange={(event) =>
              setKeyStrategy(event.target.value as ProviderConfig['keyStrategy'])
            }
            value={keyStrategy}
          >
            <option value="round-robin">轮询</option>
            <option value="priority">按优先级 / 主备</option>
          </Select>
        </label>
        <Field
          className="form-grid__wide"
          description="用于在模型选择、统计和 Key 分组中识别该服务商。"
          label="服务商名称"
          onChange={(event) => setName(event.target.value)}
          placeholder={type === 'custom' ? '例如：LCAPI' : optionFor(type).label}
          required
          value={name}
        />
        <Field
          className="form-grid__wide"
          description="云端服务商必须使用 HTTPS；本机 HTTP 仅允许 Ollama 回环地址。"
          label="API Base URL"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={optionFor(type).defaultBaseUrl}
          required
          type="url"
          value={baseUrl}
        />
        <div className="form-grid__wide">
          <Switch
            checked={enabled}
            description="停用后该服务商及其模型不会参与请求，Key 与历史数据仍会保留。"
            label="启用服务商"
            onChange={setEnabled}
          />
        </div>
        {submitError ? (
          <p className="form-grid__wide credential-form__error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
