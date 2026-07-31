import { Activity, Cloud, KeyRound, Pencil, Plus, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { Progress } from '../../components/ui/Progress';
import { StatusDot } from '../../components/ui/StatusDot';
import { useTransport } from '../../context/TransportContext';
import { formatCurrency, formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../stores/auth-store';
import { useCredentialStore } from '../../stores/credential-store';
import { useModelStore } from '../../stores/model-store';
import { useToastStore } from '../../stores/toast-store';
import type { Credential, ProviderConfig } from '../../types';

import { AddCredentialModal } from './AddCredentialModal';
import { CredentialInspector } from './CredentialInspector';
import { ProviderModal } from './ProviderModal';

const statusLabels = {
  healthy: '正常',
  warning: '接近额度',
  error: '不可用',
  unknown: '未知',
} as const;

const providerTypeLabels: Record<ProviderConfig['type'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  google: 'Google',
  ollama: 'Ollama',
  custom: 'OpenAI 兼容',
};

function quotaPercent(used: number, limit?: number): number {
  return limit && limit > 0 ? (used / limit) * 100 : 0;
}

interface KeyEditorState {
  provider: ProviderConfig;
  credential?: Credential;
}

export function CredentialsPage(): React.JSX.Element {
  const { transport } = useTransport();
  const role = useAuthStore((state) => state.session?.user.role);
  const providers = useCredentialStore((state) => state.providers);
  const credentials = useCredentialStore((state) => state.credentials);
  const loading = useCredentialStore((state) => state.loading);
  const checking = useCredentialStore((state) => state.checking);
  const error = useCredentialStore((state) => state.error);
  const load = useCredentialStore((state) => state.load);
  const createProvider = useCredentialStore((state) => state.createProvider);
  const updateProvider = useCredentialStore((state) => state.updateProvider);
  const createCredential = useCredentialStore((state) => state.create);
  const updateCredential = useCredentialStore((state) => state.update);
  const removeCredential = useCredentialStore((state) => state.remove);
  const check = useCredentialStore((state) => state.check);
  const pushToast = useToastStore((state) => state.push);
  const discoverModels = useModelStore((state) => state.discover);
  const reloadModels = useModelStore((state) => state.load);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig>();
  const [keyEditor, setKeyEditor] = useState<KeyEditorState>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canManageCredentials = role === 'owner';
  const canCheckCredentials = role === 'owner' || role === 'admin';

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  const selected = credentials.find((credential) => credential.id === selectedId);
  const summary = useMemo(
    () => ({
      available: credentials.filter(
        (credential) =>
          credential.enabled &&
          credential.status === 'healthy' &&
          providers.some((provider) => provider.id === credential.providerId && provider.enabled),
      ).length,
      total: credentials.length,
      enabledProviders: providers.filter((provider) => provider.enabled).length,
      dailyUsd: credentials
        .filter((credential) => credential.quotaUnit === 'usd')
        .reduce((total, credential) => total + credential.dailyUsed, 0),
      dailyTokens: credentials
        .filter((credential) => credential.quotaUnit === 'tokens')
        .reduce((total, credential) => total + credential.dailyUsed, 0),
      abnormal: credentials.filter((credential) => credential.status === 'error').length,
    }),
    [credentials, providers],
  );

  const handleCheck = async (): Promise<void> => {
    try {
      await check(transport);
      pushToast({ kind: 'success', title: '健康检查已完成' });
    } catch (checkError) {
      pushToast({
        kind: 'error',
        title: '健康检查失败',
        description: checkError instanceof Error ? checkError.message : undefined,
      });
    }
  };

  const handleDelete = async (credential: Credential): Promise<void> => {
    if (!window.confirm(`确认删除“${credential.name}”？此操作会写入审计日志。`)) {
      return;
    }
    try {
      await removeCredential(transport, credential.id);
      setSelectedId(null);
      pushToast({ kind: 'success', title: '密钥已删除' });
    } catch {
      // Store error 会在页面展示。
    }
  };

  const openProviderEditor = (provider?: ProviderConfig): void => {
    setEditingProvider(provider);
    setProviderModalOpen(true);
  };

  return (
    <div className={`page page--credentials${selected ? ' has-inspector' : ''}`}>
      <section className="credential-main">
        <header className="page-header">
          <span>
            <h2>服务商与 API Key</h2>
            <p>先配置服务商，再在其下添加一个或多个加密 Key；两者均可随时编辑。</p>
          </span>
          <span className="page-header__actions">
            <Button
              disabled={!canCheckCredentials || credentials.length === 0}
              loading={checking}
              onClick={() => void handleCheck()}
            >
              <Activity size={15} />
              健康检查
            </Button>
            <Button
              disabled={!canManageCredentials}
              onClick={() => openProviderEditor()}
              variant="primary"
            >
              <Plus size={15} />
              添加服务商
            </Button>
          </span>
        </header>
        <div className="metrics-band">
          <div>
            <small>启用服务商</small>
            <strong>
              {summary.enabledProviders} <span>/ {providers.length}</span>
            </strong>
          </div>
          <div>
            <small>可用 Key</small>
            <strong>
              {summary.available} <span>/ {summary.total}</span>
            </strong>
          </div>
          <div>
            <small>今日消耗</small>
            <strong>
              {formatCurrency(summary.dailyUsd)}
              {summary.dailyTokens > 0 ? (
                <span> · {summary.dailyTokens.toLocaleString()} tokens</span>
              ) : null}
            </strong>
          </div>
          <div>
            <small>异常</small>
            <strong className={summary.abnormal ? 'metric-danger' : ''}>{summary.abnormal}</strong>
          </div>
        </div>
        <div className="warning-strip">
          <ShieldAlert size={16} />
          Key 和代理凭据不会回显；编辑时留空即保留原值。部分厂商额度来自本地预算。
        </div>
        {loading ? <LoadingState label="正在加载服务商与加密 Key 索引…" /> : null}
        {error ? <ErrorState message={error} onRetry={() => void load(transport)} /> : null}
        {!loading && !error && providers.length === 0 ? (
          <EmptyState
            action={
              canManageCredentials ? (
                <Button onClick={() => openProviderEditor()} variant="primary">
                  添加第一个服务商
                </Button>
              ) : undefined
            }
            description="服务商保存接口地址和模型来源；随后可为它配置多个 Key。"
            icon={<Cloud size={28} />}
            title="还没有服务商"
          />
        ) : null}
        {providers.length > 0 ? (
          <div className="provider-list">
            {providers.map((provider) => {
              const keys = credentials.filter(
                (credential) => credential.providerId === provider.id,
              );
              return (
                <section className="provider-card" key={provider.id}>
                  <header className="provider-card__header">
                    <span className="provider-card__identity">
                      <span className="provider-card__icon">
                        <Cloud size={17} />
                      </span>
                      <span>
                        <span className="provider-card__title">
                          <strong>{provider.name}</strong>
                          <StatusDot
                            label={provider.enabled ? '已启用' : '已停用'}
                            status={provider.enabled ? 'healthy' : 'unknown'}
                          />
                        </span>
                        <small>
                          {providerTypeLabels[provider.type]} · {provider.baseUrl}
                        </small>
                      </span>
                    </span>
                    <span className="provider-card__actions">
                      <Button
                        disabled={!canManageCredentials}
                        onClick={() => openProviderEditor(provider)}
                        size="small"
                        variant="ghost"
                      >
                        <Pencil size={14} />
                        编辑服务商
                      </Button>
                      <Button
                        disabled={!canManageCredentials}
                        onClick={() => setKeyEditor({ provider })}
                        size="small"
                        variant="secondary"
                      >
                        <Plus size={14} />
                        添加 Key
                      </Button>
                    </span>
                  </header>
                  <div className="provider-card__meta">
                    <span>
                      调度：{provider.keyStrategy === 'round-robin' ? '轮询' : '按优先级 / 主备'}
                    </span>
                    <span>{keys.length} 个 Key</span>
                  </div>
                  {keys.length === 0 ? (
                    <div className="provider-card__empty">
                      <KeyRound size={18} />
                      <span>
                        <strong>尚未添加 Key</strong>
                        <small>服务商已保存；添加 Key 后即可发现模型并发起请求。</small>
                      </span>
                    </div>
                  ) : (
                    <div className="data-table-wrap credential-table">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>状态</th>
                            <th>Key 名称</th>
                            <th>末四位</th>
                            <th>优先级</th>
                            <th>今日额度</th>
                            <th>月度额度</th>
                            <th>代理</th>
                            <th>上次检查</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((credential) => {
                            const daily = quotaPercent(credential.dailyUsed, credential.dailyLimit);
                            const monthly = quotaPercent(
                              credential.monthlyUsed,
                              credential.monthlyLimit,
                            );
                            return (
                              <tr
                                className={selectedId === credential.id ? 'is-selected' : ''}
                                key={credential.id}
                                onClick={() => setSelectedId(credential.id)}
                              >
                                <td>
                                  <StatusDot
                                    label={
                                      credential.enabled
                                        ? statusLabels[credential.status]
                                        : '已停用'
                                    }
                                    status={credential.enabled ? credential.status : 'unknown'}
                                  />
                                </td>
                                <td>
                                  <strong>{credential.name}</strong>
                                </td>
                                <td>
                                  <code>•••• {credential.lastFour}</code>
                                </td>
                                <td>{credential.priority}</td>
                                <td>
                                  <span className="table-quota">
                                    <span>
                                      {credential.dailyLimit ? `${daily.toFixed(0)}%` : '未设置'}
                                    </span>
                                    <Progress
                                      tone={
                                        daily >= 100
                                          ? 'danger'
                                          : daily >= 80
                                            ? 'warning'
                                            : 'default'
                                      }
                                      value={daily}
                                    />
                                  </span>
                                </td>
                                <td>
                                  <span className="table-quota">
                                    <span>
                                      {credential.monthlyLimit
                                        ? `${monthly.toFixed(0)}%`
                                        : '未设置'}
                                    </span>
                                    <Progress
                                      tone={
                                        monthly >= 100
                                          ? 'danger'
                                          : monthly >= 80
                                            ? 'warning'
                                            : 'default'
                                      }
                                      value={monthly}
                                    />
                                  </span>
                                </td>
                                <td>
                                  {credential.proxyMode === 'direct'
                                    ? '直连'
                                    : credential.proxyMode === 'local'
                                      ? '本地'
                                      : 'HTTP 代理'}
                                </td>
                                <td>
                                  {credential.lastCheckedAt
                                    ? formatDateTime(credential.lastCheckedAt)
                                    : '从未'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
      </section>
      {selected ? (
        <CredentialInspector
          canManage={canManageCredentials}
          credential={selected}
          onClose={() => setSelectedId(null)}
          onDelete={() => void handleDelete(selected)}
          onEdit={() => {
            const provider = providers.find((item) => item.id === selected.providerId);
            if (provider !== undefined) {
              setKeyEditor({ provider, credential: selected });
            }
          }}
          onPause={() =>
            void updateCredential(transport, selected.id, {
              enabled: !selected.enabled,
            })
          }
        />
      ) : null}
      <ProviderModal
        onClose={() => {
          setProviderModalOpen(false);
          setEditingProvider(undefined);
        }}
        onSubmit={async (input) => {
          if (editingProvider === undefined) {
            await createProvider(transport, input);
            pushToast({
              kind: 'success',
              title: '服务商已添加',
              description: '现在可以在该服务商下添加 API Key。',
            });
          } else {
            const updatedProvider = await updateProvider(transport, editingProvider.id, input);
            await reloadModels(transport);
            if (updatedProvider.modelDiscoveryError !== undefined) {
              pushToast({
                kind: 'warning',
                title: '服务商已更新，模型同步失败',
                description: updatedProvider.modelDiscoveryError,
              });
            } else {
              pushToast({
                kind: 'success',
                title: '服务商配置已更新',
                description:
                  !editingProvider.enabled && updatedProvider.enabled
                    ? '已重新同步该服务商的可用模型。'
                    : undefined,
              });
            }
          }
        }}
        open={providerModalOpen && canManageCredentials}
        provider={editingProvider}
      />
      {keyEditor ? (
        <AddCredentialModal
          credential={keyEditor.credential}
          onClose={() => setKeyEditor(undefined)}
          onSubmit={async (input) => {
            if (keyEditor.credential !== undefined) {
              await updateCredential(transport, keyEditor.credential.id, {
                name: input.name,
                ...(input.apiKey === '' ? {} : { apiKey: input.apiKey }),
                priority: input.priority,
                ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
                ...(input.monthlyLimit === undefined ? {} : { monthlyLimit: input.monthlyLimit }),
                ...(input.quotaUnit === undefined ? {} : { quotaUnit: input.quotaUnit }),
                ...(input.proxyUrl === undefined ? {} : { proxyUrl: input.proxyUrl }),
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              });
              pushToast({
                kind: 'success',
                title: 'API Key 已更新',
                description: input.apiKey ? '新密钥已加密保存。' : '原密钥保持不变。',
              });
              return;
            }
            await createCredential(transport, input);
            try {
              await discoverModels(transport, keyEditor.provider.id);
              pushToast({
                kind: 'success',
                title: 'API Key 已安全保存',
                description: '已同步该服务商的可用模型。',
              });
            } catch (discoverError) {
              pushToast({
                kind: 'warning',
                title: 'API Key 已保存，模型同步失败',
                description:
                  discoverError instanceof Error
                    ? discoverError.message
                    : '可稍后在模型管理中重新发现。',
              });
            }
          }}
          open={canManageCredentials}
          provider={keyEditor.provider}
        />
      ) : null}
    </div>
  );
}
