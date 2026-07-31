import { Bell, PanelLeftOpen, RefreshCw, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useTransport } from '../../context/TransportContext';
import { useConversationStore } from '../../stores/conversation-store';
import {
  isConversationModel,
  modelProviderId,
  modelProviderName,
  useModelStore,
} from '../../stores/model-store';
import { useToastStore } from '../../stores/toast-store';
import { IconButton } from '../ui/IconButton';
import { Select } from '../ui/Select';
import { StatusDot } from '../ui/StatusDot';

const routeTitles: Record<string, string> = {
  '/workspace': 'E Agent',
  '/models': '模型管理',
  '/credentials': 'API Key 管理',
  '/costs': '成本中心',
  '/skills': 'Skill 技能',
  '/plugins': '插件管理',
  '/tutorial': '使用教程',
  '/settings': '设置',
  '/admin': '团队与审计',
};
const automaticModelValue = '__e_agent_scene_default__';

export function TopBar({
  onOpenSidebar,
  sidebarCollapsed,
}: {
  onOpenSidebar: () => void;
  sidebarCollapsed: boolean;
}): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { transport } = useTransport();
  const models = useModelStore((state) => state.models);
  const modelsForSelectedProvider = useModelStore((state) => state.modelsForSelectedProvider);
  const selectedProviderId = useModelStore((state) => state.selectedProviderId);
  const selectedModel = useModelStore((state) => state.selectedModel);
  const routingMode = useModelStore((state) => state.routingMode);
  const selectProvider = useModelStore((state) => state.selectProvider);
  const select = useModelStore((state) => state.select);
  const enableAutomaticRouting = useModelStore((state) => state.enableAutomaticRouting);
  const loadModels = useModelStore((state) => state.load);
  const loadConversations = useConversationStore((state) => state.loadConversations);
  const refreshQueue = useConversationStore((state) => state.refreshQueue);
  const streaming = useConversationStore((state) => state.streaming);
  const messageMutationId = useConversationStore((state) => state.messageMutationId);
  const pushToast = useToastStore((state) => state.push);
  const [refreshing, setRefreshing] = useState(false);
  const selected = models.find((model) => model.id === selectedModel);
  const hasAvailableModel = modelsForSelectedProvider.some((model) => model.available);
  const providers = Array.from(
    new Map(
      models
        .filter((model) => model.available && isConversationModel(model))
        .map((model) => [
          modelProviderId(model),
          {
            id: modelProviderId(model),
            name: modelProviderName(model),
            type: model.provider,
          },
        ]),
    ).values(),
  ).sort((left, right) => left.name.localeCompare(right.name));
  const isWorkspace = location.pathname === '/workspace';
  const refreshBlocked = refreshing || (isWorkspace && (streaming || messageMutationId !== null));

  const refresh = async (): Promise<void> => {
    if (refreshBlocked) return;
    setRefreshing(true);
    try {
      await Promise.all([
        loadModels(transport),
        ...(isWorkspace ? [loadConversations(transport), refreshQueue(transport)] : []),
      ]);
      const refreshError =
        useModelStore.getState().error ??
        (isWorkspace ? useConversationStore.getState().error : null);
      if (refreshError) {
        throw new Error(refreshError);
      }
      pushToast({ kind: 'success', title: '数据已刷新' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '刷新失败',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <header className="top-bar">
      <span className="top-bar__title">
        {sidebarCollapsed ? (
          <IconButton label="展开会话栏" onClick={onOpenSidebar}>
            <PanelLeftOpen size={17} />
          </IconButton>
        ) : null}
        <h1>{routeTitles[location.pathname] ?? 'E Agent'}</h1>
      </span>
      {isWorkspace ? (
        <span className="top-bar__model">
          <span className="top-bar__selector">
            <small>服务商</small>
            <Select
              aria-label="当前服务商"
              onChange={(event) => selectProvider(event.target.value)}
              value={selectedProviderId}
            >
              {providers.length === 0 ? <option value="">暂无可用服务商</option> : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                  {provider.name.toLowerCase() === provider.type.toLowerCase()
                    ? ''
                    : ` · ${provider.type}`}
                </option>
              ))}
            </Select>
          </span>
          <span className="top-bar__selector">
            <small>模型</small>
            <Select
              aria-label="当前模型"
              disabled={!hasAvailableModel}
              onChange={(event) =>
                event.target.value === automaticModelValue
                  ? enableAutomaticRouting()
                  : select(event.target.value)
              }
              value={
                hasAvailableModel && routingMode === 'automatic'
                  ? automaticModelValue
                  : selectedModel
              }
            >
              {!hasAvailableModel ? <option value="">暂无可用模型</option> : null}
              {hasAvailableModel ? (
                <option value={automaticModelValue}>自动（按 @code / @chat）</option>
              ) : null}
              {modelsForSelectedProvider.map((model) => (
                <option disabled={!model.available} key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </Select>
          </span>
          <StatusDot
            label={selected?.available ? 'API 正常' : '模型不可用'}
            status={selected?.available ? 'healthy' : 'unknown'}
          />
        </span>
      ) : null}
      <span className="top-bar__actions">
        <IconButton disabled={refreshBlocked} label="刷新模型与会话" onClick={() => void refresh()}>
          <RefreshCw className={refreshing ? 'is-spinning' : undefined} size={16} />
        </IconButton>
        <IconButton disabled label="通知中心即将开放">
          <Bell size={17} />
        </IconButton>
        <IconButton label="页面设置" onClick={() => navigate('/settings')}>
          <Settings2 size={17} />
        </IconButton>
      </span>
    </header>
  );
}
