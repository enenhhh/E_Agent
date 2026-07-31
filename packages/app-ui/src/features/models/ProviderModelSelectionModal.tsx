import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { Model } from '../../types';

const maximumVisibleModels = 200;

interface ProviderModelSelectionModalProps {
  models: Model[];
  open: boolean;
  providerName: string;
  saving: boolean;
  onClose: () => void;
  onSave: (enabledModelIds: string[]) => Promise<void>;
}

/**
 * 为单个服务商批量配置可用于路由的模型。
 * 搜索结果只渲染前 200 项以控制超大模型列表的 DOM 开销，批量操作仍作用于全部匹配项。
 */
export function ProviderModelSelectionModal({
  models,
  onClose,
  onSave,
  open,
  providerName,
  saving,
}: ProviderModelSelectionModalProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setEnabledIds(
      new Set(
        models
          .filter((model) => model.configuredEnabled ?? model.available)
          .map((model) => model.id),
      ),
    );
  }, [models, open]);

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === '') return models;
    return models.filter((model) =>
      `${model.displayName} ${model.remoteId ?? model.id}`.toLowerCase().includes(normalizedQuery),
    );
  }, [models, query]);
  const visibleModels = filteredModels.slice(0, maximumVisibleModels);

  const setFilteredEnabled = (enabled: boolean): void => {
    setEnabledIds((current) => {
      const next = new Set(current);
      for (const model of filteredModels) {
        if (enabled) {
          next.add(model.id);
        } else {
          next.delete(model.id);
        }
      }
      return next;
    });
  };

  const toggleModel = (modelId: string): void => {
    setEnabledIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  return (
    <Modal
      description={`已启用 ${enabledIds.size} / ${models.length} 个；停用模型不会出现在对话模型路由中。`}
      footer={
        <>
          <Button disabled={saving} onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button loading={saving} onClick={() => void onSave([...enabledIds])} variant="primary">
            保存启用范围
          </Button>
        </>
      }
      onClose={saving ? () => undefined : onClose}
      open={open}
      title={`配置 ${providerName} 的模型`}
    >
      <div className="provider-model-selection">
        <label className="provider-model-selection__search">
          <Search aria-hidden size={15} />
          <input
            aria-label="搜索服务商模型"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按模型名称或 ID 搜索"
            value={query}
          />
        </label>
        <div className="provider-model-selection__toolbar">
          <span>
            匹配 {filteredModels.length} 个模型
            {filteredModels.length > maximumVisibleModels
              ? `，当前显示前 ${maximumVisibleModels} 个`
              : ''}
          </span>
          <span>
            <Button
              disabled={filteredModels.length === 0 || saving}
              onClick={() => setFilteredEnabled(true)}
              size="small"
              variant="ghost"
            >
              启用匹配项
            </Button>
            <Button
              disabled={filteredModels.length === 0 || saving}
              onClick={() => setFilteredEnabled(false)}
              size="small"
              variant="ghost"
            >
              停用匹配项
            </Button>
          </span>
        </div>
        <div className="provider-model-selection__list">
          {visibleModels.length === 0 ? (
            <p className="provider-model-selection__empty">没有匹配的模型。</p>
          ) : (
            visibleModels.map((model) => (
              <label className="provider-model-selection__item" key={model.id}>
                <input
                  checked={enabledIds.has(model.id)}
                  disabled={saving}
                  onChange={() => toggleModel(model.id)}
                  type="checkbox"
                />
                <span>
                  <strong>{model.displayName}</strong>
                  <code>
                    {model.remoteId ?? model.id}
                    {model.stale ? ' · 当前已下线，重新出现后按此选择恢复' : ''}
                  </code>
                </span>
              </label>
            ))
          )}
        </div>
        {enabledIds.size === 0 ? (
          <p className="provider-model-selection__warning">
            当前未启用任何模型，保存后该服务商将暂时无法用于对话。
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
