import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useConversationStore } from '../../stores/conversation-store';
import { useModelStore } from '../../stores/model-store';
import { useToastStore } from '../../stores/toast-store';
import type { Model } from '../../types';

import { TopBar } from './TopBar';

const originalLoadModels = useModelStore.getState().load;
const originalLoadConversations = useConversationStore.getState().loadConversations;
const originalRefreshQueue = useConversationStore.getState().refreshQueue;

function model(
  id: string,
  providerId: string,
  providerName: string,
  available = true,
  provider = 'custom',
): Model {
  return {
    id,
    remoteId: id,
    providerId,
    providerName,
    provider,
    displayName: id.toUpperCase(),
    contextWindow: 32_000,
    capabilities: ['chat'],
    available,
  };
}

function renderTopBar(
  route = '/workspace',
  transport = {} as EAgentTransport,
  props: Partial<React.ComponentProps<typeof TopBar>> = {},
): void {
  render(
    <TransportProvider mode="web" transport={transport}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route
            element={
              <TopBar
                onOpenSidebar={props.onOpenSidebar ?? (() => undefined)}
                sidebarCollapsed={props.sidebarCollapsed ?? false}
              />
            }
            path="*"
          />
          <Route element={<div>设置页已打开</div>} path="/settings" />
        </Routes>
      </MemoryRouter>
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('TopBar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    const models = [
      model('model-a', 'provider-a', 'Gateway A'),
      model('model-b', 'provider-b', 'Gateway B'),
    ];
    useModelStore.setState({
      models,
      modelsForSelectedProvider: [models[0]!],
      selectedProviderId: 'provider-a',
      selectedModel: 'model-a',
      selectedModelByProvider: { 'provider-a': 'model-a' },
      routingMode: 'explicit',
      compareModels: [],
      loading: false,
      discovering: false,
      error: null,
      load: originalLoadModels,
    });
    useConversationStore.setState({
      conversations: [],
      selectedId: null,
      messages: [],
      loading: false,
      streaming: false,
      messageMutationId: null,
      queue: { running: 0, queued: 0 },
      loadConversations: originalLoadConversations,
      refreshQueue: originalRefreshQueue,
    });
    useToastStore.setState({ messages: [] });
  });

  it('切换服务商后，模型下拉框只展示该服务商的模型', () => {
    renderTopBar();

    const providerSelect = screen.getByLabelText('当前服务商');
    const modelSelect = screen.getByLabelText('当前模型');
    expect(
      within(modelSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['自动（按 @code / @chat）', 'MODEL-A']);

    fireEvent.change(providerSelect, { target: { value: 'provider-b' } });

    expect(useModelStore.getState()).toMatchObject({
      selectedProviderId: 'provider-b',
      selectedModel: 'model-b',
    });
    expect(
      within(modelSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['自动（按 @code / @chat）', 'MODEL-B']);
  });

  it('可以切回按场景默认模型自动路由', () => {
    renderTopBar();

    fireEvent.change(screen.getByLabelText('当前模型'), {
      target: { value: '__e_agent_scene_default__' },
    });

    expect(useModelStore.getState().routingMode).toBe('automatic');
  });

  it('只向路由展示至少有一个可用对话模型的服务商', () => {
    const models = [
      model('model-z', 'provider-z', 'Zulu Gateway', false),
      model('model-a', 'provider-a', 'Alpha Gateway', true),
    ];
    useModelStore.setState({
      models,
      modelsForSelectedProvider: [models[1]!],
      selectedProviderId: 'provider-a',
      selectedModel: 'model-a',
      selectedModelByProvider: { 'provider-a': 'model-a' },
    });

    renderTopBar();

    expect(
      within(screen.getByLabelText('当前服务商'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Alpha Gateway · custom']);
    const modelSelect = screen.getByLabelText('当前模型');
    expect(modelSelect).not.toBeDisabled();
    expect(within(modelSelect).queryByRole('option', { name: 'MODEL-Z' })).not.toBeInTheDocument();
    expect(screen.getByText('API 正常')).toBeInTheDocument();
  });

  it('没有模型时展示空状态，且折叠时可以展开会话栏', () => {
    const onOpenSidebar = vi.fn();
    useModelStore.setState({
      models: [],
      modelsForSelectedProvider: [],
      selectedProviderId: '',
      selectedModel: '',
      selectedModelByProvider: {},
    });

    renderTopBar('/workspace', {} as EAgentTransport, {
      onOpenSidebar,
      sidebarCollapsed: true,
    });

    expect(screen.getByRole('option', { name: '暂无可用服务商' })).toBeInTheDocument();
    expect(screen.getByLabelText('当前模型')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '展开会话栏' }));
    expect(onOpenSidebar).toHaveBeenCalledOnce();
  });

  it('在工作台刷新模型、会话和队列，并阻止刷新期间重复触发', async () => {
    let resolveModels: ((models: Model[]) => void) | undefined;
    const listModels = vi.fn(
      () =>
        new Promise<Model[]>((resolve) => {
          resolveModels = resolve;
        }),
    );
    const listConversations = vi.fn(async () => []);
    const getQueueStatus = vi.fn(async () => ({ running: 1, queued: 2 }));
    const transport = {
      listModels,
      listConversations,
      getQueueStatus,
    } as unknown as EAgentTransport;

    renderTopBar('/workspace', transport);
    const refreshButton = screen.getByRole('button', { name: '刷新模型与会话' });
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);

    expect(refreshButton).toBeDisabled();
    expect(listModels).toHaveBeenCalledOnce();
    expect(listConversations).toHaveBeenCalledOnce();
    expect(getQueueStatus).toHaveBeenCalledOnce();

    resolveModels?.([model('model-c', 'provider-c', 'Gateway C')]);
    await waitFor(() => expect(refreshButton).not.toBeDisabled());
    expect(useToastStore.getState().messages.at(-1)).toMatchObject({
      kind: 'success',
      title: '数据已刷新',
    });
  });

  it('在非工作台只刷新模型，并显示对应页面标题', async () => {
    const listModels = vi.fn(async () => [model('model-a', 'provider-a', 'Gateway A')]);
    const listConversations = vi.fn(async () => []);
    const getQueueStatus = vi.fn(async () => ({ running: 0, queued: 0 }));

    renderTopBar('/models', {
      listModels,
      listConversations,
      getQueueStatus,
    } as unknown as EAgentTransport);
    expect(screen.getByRole('heading', { name: '模型管理' })).toBeInTheDocument();
    expect(screen.queryByLabelText('当前服务商')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '刷新模型与会话' }));
    await waitFor(() => expect(listModels).toHaveBeenCalledOnce());
    expect(listConversations).not.toHaveBeenCalled();
    expect(getQueueStatus).not.toHaveBeenCalled();
  });

  it('刷新失败时给出错误提示并恢复按钮', async () => {
    useModelStore.setState({
      load: vi.fn(async () => {
        throw new Error('模型服务暂不可用');
      }),
    });

    renderTopBar();
    const refreshButton = screen.getByRole('button', { name: '刷新模型与会话' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(useToastStore.getState().messages.at(-1)).toMatchObject({
        kind: 'error',
        title: '刷新失败',
        description: '模型服务暂不可用',
      });
    });
    expect(refreshButton).not.toBeDisabled();
  });

  it('模型 Store 捕获真实传输失败时仍显示刷新失败，不能误报成功', async () => {
    const listModels = vi.fn(async () => {
      throw new Error('模型列表请求失败');
    });
    renderTopBar('/models', { listModels } as unknown as EAgentTransport);

    fireEvent.click(screen.getByRole('button', { name: '刷新模型与会话' }));

    await waitFor(() => {
      expect(useToastStore.getState().messages.at(-1)).toMatchObject({
        kind: 'error',
        title: '刷新失败',
        description: '模型列表请求失败',
      });
    });
    expect(useToastStore.getState().messages).not.toContainEqual(
      expect.objectContaining({ kind: 'success', title: '数据已刷新' }),
    );
  });

  it('未知路由回退到产品标题，设置按钮可以导航', () => {
    renderTopBar('/unknown');

    expect(screen.getByRole('heading', { name: 'E Agent' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '页面设置' }));
    expect(screen.getByText('设置页已打开')).toBeInTheDocument();
  });

  it('消息生成或消息变更期间禁用工作台全局刷新', () => {
    useConversationStore.setState({ streaming: true });
    const { rerender } = render(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter initialEntries={['/workspace']}>
          <TopBar onOpenSidebar={() => undefined} sidebarCollapsed={false} />
        </MemoryRouter>
      </TransportProvider>,
    );
    expect(screen.getByRole('button', { name: '刷新模型与会话' })).toBeDisabled();

    useConversationStore.setState({
      streaming: false,
      messageMutationId: 'message-mutation',
    });
    rerender(
      <TransportProvider mode="web" transport={{} as EAgentTransport}>
        <MemoryRouter initialEntries={['/workspace']}>
          <TopBar onOpenSidebar={() => undefined} sidebarCollapsed={false} />
        </MemoryRouter>
      </TransportProvider>,
    );
    expect(screen.getByRole('button', { name: '刷新模型与会话' })).toBeDisabled();
  });
});
