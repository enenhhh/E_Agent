import { Check, RefreshCw, Search, Settings2, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { StatusDot } from '../../components/ui/StatusDot';
import { useTransport } from '../../context/TransportContext';
import { formatDuration } from '../../lib/format';
import { useAuthStore } from '../../stores/auth-store';
import { modelProviderId, modelProviderName, useModelStore } from '../../stores/model-store';
import { useToastStore } from '../../stores/toast-store';

import { ModelComparisonPanel } from './ModelComparisonPanel';
import { ProviderModelSelectionModal } from './ProviderModelSelectionModal';

export function ModelsPage(): React.JSX.Element {
  const { transport } = useTransport();
  const models = useModelStore((state) => state.models);
  const loading = useModelStore((state) => state.loading);
  const discovering = useModelStore((state) => state.discovering);
  const error = useModelStore((state) => state.error);
  const load = useModelStore((state) => state.load);
  const discover = useModelStore((state) => state.discover);
  const selectionSavingProviderId = useModelStore((state) => state.selectionSavingProviderId);
  const updateProviderSelection = useModelStore((state) => state.updateProviderSelection);
  const compareModels = useModelStore((state) => state.compareModels);
  const toggleCompare = useModelStore((state) => state.toggleCompare);
  const role = useAuthStore((state) => state.session?.user.role);
  const pushToast = useToastStore((state) => state.push);
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState('all');
  const [configuringProviderId, setConfiguringProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (models.length === 0) {
      void load(transport);
    }
  }, [load, models.length, transport]);

  const providers = useMemo(
    () =>
      Array.from(
        new Map(
          models.map((model) => [
            modelProviderId(model),
            {
              id: modelProviderId(model),
              name: modelProviderName(model),
              type: model.provider,
            },
          ]),
        ).values(),
      ).sort((left, right) => left.name.localeCompare(right.name)),
    [models],
  );
  useEffect(() => {
    if (providerId !== 'all' && !providers.some((provider) => provider.id === providerId)) {
      setProviderId('all');
    }
  }, [providerId, providers]);
  const filtered = useMemo(
    () =>
      models.filter(
        (model) =>
          (providerId === 'all' || modelProviderId(model) === providerId) &&
          (!query ||
            `${model.displayName} ${model.remoteId ?? model.id} ${modelProviderName(model)}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [models, providerId, query],
  );
  const configuringProvider = providers.find((provider) => provider.id === configuringProviderId);
  const configuringModels = models.filter(
    (model) => modelProviderId(model) === configuringProviderId,
  );

  const handleDiscover = async (): Promise<void> => {
    try {
      await discover(transport);
      pushToast({ kind: 'success', title: '模型发现完成', description: '缓存已更新。' });
    } catch (discoverError) {
      pushToast({
        kind: 'error',
        title: '模型发现失败',
        description: discoverError instanceof Error ? discoverError.message : undefined,
      });
    }
  };

  const handleSaveSelection = async (enabledModelIds: string[]): Promise<void> => {
    if (configuringProviderId === null) return;
    try {
      await updateProviderSelection(transport, configuringProviderId, enabledModelIds);
      setConfiguringProviderId(null);
      pushToast({
        kind: 'success',
        title: '模型启用范围已保存',
        description: `已启用 ${enabledModelIds.length} 个模型。`,
      });
    } catch (saveError) {
      pushToast({
        kind: 'error',
        title: '模型启用范围保存失败',
        description: saveError instanceof Error ? saveError.message : undefined,
      });
    }
  };

  return (
    <div className="page page--models">
      <header className="page-header">
        <span>
          <h2>模型管理</h2>
          <p>自动发现已配置厂商的模型，并维护能力、上下文与价格标签。</p>
        </span>
        <span className="page-header__actions">
          <Button
            disabled={
              providerId === 'all' ||
              (role !== 'owner' && role !== 'admin') ||
              selectionSavingProviderId !== null
            }
            onClick={() => setConfiguringProviderId(providerId)}
          >
            <Settings2 size={15} />
            配置启用模型
          </Button>
          <Button
            disabled={role !== 'owner' && role !== 'admin'}
            loading={discovering}
            onClick={() => void handleDiscover()}
          >
            <RefreshCw size={15} />
            重新发现
          </Button>
        </span>
      </header>
      <div className="filter-bar">
        <label>
          <Search size={15} />
          <input
            aria-label="搜索模型"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型 ID 或名称"
            value={query}
          />
        </label>
        <span className="filter-tabs">
          <button
            className={providerId === 'all' ? 'is-active' : ''}
            onClick={() => setProviderId('all')}
            type="button"
          >
            全部服务商
          </button>
          {providers.map((provider) => (
            <button
              className={providerId === provider.id ? 'is-active' : ''}
              key={provider.id}
              onClick={() => setProviderId(provider.id)}
              type="button"
            >
              {provider.name}
            </button>
          ))}
        </span>
        <span className="filter-bar__count">
          <SlidersHorizontal size={14} />
          {filtered.length} 个模型
        </span>
      </div>
      {loading ? <LoadingState label="正在读取模型缓存…" /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load(transport)} /> : null}
      {!loading && !error ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="data-table__check">对比</th>
                <th>模型</th>
                <th>厂商</th>
                <th>能力</th>
                <th>上下文</th>
                <th>输入 / 输出价格</th>
                <th>延迟</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((model) => {
                const selected = compareModels.includes(model.id);
                return (
                  <tr className={selected ? 'is-selected' : ''} key={model.id}>
                    <td className="data-table__check">
                      <button
                        aria-label={`${selected ? '取消' : '选择'} ${model.displayName} 进行对比`}
                        className={`comparison-check${selected ? ' is-selected' : ''}`}
                        disabled={!model.available || (!selected && compareModels.length >= 4)}
                        onClick={() => toggleCompare(model.id)}
                        type="button"
                      >
                        {selected ? <Check size={13} /> : null}
                      </button>
                    </td>
                    <td>
                      <span className="model-name">
                        <strong>{model.displayName}</strong>
                        <code>{model.remoteId ?? model.id}</code>
                      </span>
                    </td>
                    <td>
                      {modelProviderName(model)}
                      {modelProviderName(model).toLowerCase() ===
                      model.provider.toLowerCase() ? null : (
                        <small> · {model.provider}</small>
                      )}
                    </td>
                    <td>
                      <span className="capability-list">
                        {model.capabilities.map((capability) => (
                          <span key={capability}>{capability}</span>
                        ))}
                      </span>
                    </td>
                    <td>{model.contextWindow.toLocaleString()}</td>
                    <td>
                      {model.inputPricePerMillion == null
                        ? '未知'
                        : `$${model.inputPricePerMillion} / $${model.outputPricePerMillion ?? 0}`}
                    </td>
                    <td>{model.latencyMs ? formatDuration(model.latencyMs) : '—'}</td>
                    <td>
                      <StatusDot
                        label={
                          model.stale
                            ? '已下线'
                            : model.available
                              ? '已启用'
                              : '已停用或服务商不可用'
                        }
                        status={model.available ? 'healthy' : 'unknown'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <ModelComparisonPanel />
      <ProviderModelSelectionModal
        models={configuringModels}
        onClose={() => setConfiguringProviderId(null)}
        onSave={handleSaveSelection}
        open={configuringProvider !== undefined}
        providerName={configuringProvider?.name ?? ''}
        saving={selectionSavingProviderId === configuringProviderId}
      />
    </div>
  );
}
