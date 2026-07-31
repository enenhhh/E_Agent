import { create } from 'zustand';

import type { EAgentTransport } from '../lib/transport';
import type { Model } from '../types';

const selectionStorageKey = 'e-agent-model-selection-v1';
export type ModelRoutingMode = 'automatic' | 'explicit';

interface PersistedSelection {
  version: 1;
  selectedProviderId: string;
  selectedModelByProvider: Record<string, string>;
  routingMode: ModelRoutingMode;
}

interface ModelState {
  models: Model[];
  modelsForSelectedProvider: Model[];
  selectedProviderId: string;
  selectedModel: string;
  selectedModelByProvider: Record<string, string>;
  routingMode: ModelRoutingMode;
  compareModels: string[];
  loading: boolean;
  discovering: boolean;
  selectionSavingProviderId: string | null;
  error: string | null;
  load: (transport: EAgentTransport) => Promise<void>;
  discover: (transport: EAgentTransport, providerId?: string) => Promise<void>;
  updateProviderSelection: (
    transport: EAgentTransport,
    providerId: string,
    enabledModelIds: string[],
  ) => Promise<void>;
  selectProvider: (providerId: string) => void;
  select: (modelId: string) => void;
  enableAutomaticRouting: () => void;
  toggleCompare: (modelId: string) => void;
}

/** 为旧版模型响应生成兼容身份；新版响应始终使用真实 providerId。 */
export function modelProviderId(model: Model): string {
  const providerId = model.providerId?.trim();
  return providerId || `legacy:${model.provider.trim().toLowerCase()}`;
}

/** 返回适合界面展示的服务商名称，并兼容旧版只返回 provider 类型的响应。 */
export function modelProviderName(model: Model): string {
  return model.providerName?.trim() || model.provider;
}

/** 嵌入专用模型不能用于对话；未知能力的旧版模型保持兼容。 */
export function isConversationModel(model: Model): boolean {
  return (
    model.capabilities.length === 0 ||
    model.capabilities.some((capability) => capability !== 'embedding')
  );
}

function readPersistedSelection(): PersistedSelection {
  try {
    const raw = window.localStorage.getItem(selectionStorageKey);
    if (!raw) {
      return {
        version: 1,
        selectedProviderId: '',
        selectedModelByProvider: {},
        routingMode: 'automatic',
      };
    }
    if (raw.length > 65_536) {
      throw new Error('selection cache is too large');
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSelection>;
    if (
      parsed.version !== 1 ||
      typeof parsed.selectedProviderId !== 'string' ||
      parsed.selectedProviderId.length > 256 ||
      typeof parsed.selectedModelByProvider !== 'object' ||
      parsed.selectedModelByProvider === null
    ) {
      throw new Error('invalid selection cache');
    }
    const selectedModelByProvider = Object.fromEntries(
      Object.entries(parsed.selectedModelByProvider)
        .filter(
          (entry): entry is [string, string] =>
            entry[0].length > 0 &&
            entry[0].length <= 256 &&
            typeof entry[1] === 'string' &&
            entry[1].length > 0 &&
            entry[1].length <= 256,
        )
        .slice(0, 256),
    );
    return {
      version: 1,
      selectedProviderId: parsed.selectedProviderId,
      selectedModelByProvider,
      routingMode: parsed.routingMode === 'explicit' ? 'explicit' : 'automatic',
    };
  } catch {
    return {
      version: 1,
      selectedProviderId: '',
      selectedModelByProvider: {},
      routingMode: 'automatic',
    };
  }
}

function persistSelection(
  selectedProviderId: string,
  selectedModelByProvider: Record<string, string>,
  routingMode: ModelRoutingMode,
): void {
  try {
    window.localStorage.setItem(
      selectionStorageKey,
      JSON.stringify({
        version: 1,
        selectedProviderId,
        selectedModelByProvider,
        routingMode,
      } satisfies PersistedSelection),
    );
  } catch {
    // 选择状态写入失败不应阻断模型调用；当前会话仍保留内存状态。
  }
}

function normalizeModels(models: Model[]): Model[] {
  return models.map((model) => ({
    ...model,
    providerId: modelProviderId(model),
    providerName: modelProviderName(model),
  }));
}

function modelsForProvider(models: Model[], providerId: string): Model[] {
  return providerId === ''
    ? []
    : models.filter(
        (model) =>
          modelProviderId(model) === providerId && model.available && isConversationModel(model),
      );
}

function isSelectable(model: Model | undefined): model is Model {
  return model !== undefined && model.available && isConversationModel(model);
}

function reconcileModels(
  models: Model[],
  current: Pick<
    ModelState,
    | 'selectedProviderId'
    | 'selectedModel'
    | 'selectedModelByProvider'
    | 'routingMode'
    | 'compareModels'
  >,
): Pick<
  ModelState,
  | 'models'
  | 'modelsForSelectedProvider'
  | 'selectedProviderId'
  | 'selectedModel'
  | 'selectedModelByProvider'
  | 'routingMode'
  | 'compareModels'
> {
  const normalizedModels = normalizeModels(models);
  const modelById = new Map(normalizedModels.map((model) => [model.id, model]));
  const providerIds = Array.from(
    new Set(
      normalizedModels
        .filter((model) => isSelectable(model))
        .map((model) => modelProviderId(model)),
    ),
  );
  const selectedModelByProvider: Record<string, string> = {};

  for (const [providerId, modelId] of Object.entries(current.selectedModelByProvider)) {
    const model = modelById.get(modelId);
    if (isSelectable(model) && modelProviderId(model) === providerId) {
      selectedModelByProvider[providerId] = modelId;
    }
  }

  const currentModel = modelById.get(current.selectedModel);
  if (isSelectable(currentModel)) {
    selectedModelByProvider[modelProviderId(currentModel)] = currentModel.id;
  }

  const firstAvailableModel = normalizedModels.find((model) => isSelectable(model));
  const selectedProviderId = providerIds.includes(current.selectedProviderId)
    ? current.selectedProviderId
    : isSelectable(currentModel)
      ? modelProviderId(currentModel)
      : firstAvailableModel
        ? modelProviderId(firstAvailableModel)
        : (providerIds[0] ?? '');
  const selectedProviderModels = modelsForProvider(normalizedModels, selectedProviderId);
  const rememberedModel = modelById.get(selectedModelByProvider[selectedProviderId] ?? '');
  const selectedModel = isSelectable(rememberedModel)
    ? rememberedModel.id
    : (selectedProviderModels.find((model) => model.available)?.id ?? '');

  if (selectedModel !== '') {
    selectedModelByProvider[selectedProviderId] = selectedModel;
  }
  const routingMode =
    current.routingMode === 'explicit' && isSelectable(rememberedModel) ? 'explicit' : 'automatic';

  const compareModels = current.compareModels.filter((modelId) =>
    isSelectable(modelById.get(modelId)),
  );
  persistSelection(selectedProviderId, selectedModelByProvider, routingMode);

  return {
    models: normalizedModels,
    modelsForSelectedProvider: selectedProviderModels,
    selectedProviderId,
    selectedModel,
    selectedModelByProvider,
    routingMode,
    compareModels,
  };
}

const persistedSelection = readPersistedSelection();

export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  modelsForSelectedProvider: [],
  selectedProviderId: persistedSelection.selectedProviderId,
  selectedModel: '',
  selectedModelByProvider: persistedSelection.selectedModelByProvider,
  routingMode: persistedSelection.routingMode,
  compareModels: [],
  loading: false,
  discovering: false,
  selectionSavingProviderId: null,
  error: null,

  load: async (transport) => {
    set({ loading: true, error: null });
    try {
      const models = await transport.listModels();
      set({
        ...reconcileModels(models, get()),
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '模型列表加载失败。',
      });
    }
  },

  discover: async (transport, providerId) => {
    set({ discovering: true, error: null });
    try {
      const models = await transport.discoverModels(providerId);
      set({
        ...reconcileModels(models, get()),
        discovering: false,
      });
    } catch (error) {
      set({
        discovering: false,
        error: error instanceof Error ? error.message : '模型发现失败。',
      });
      throw error;
    }
  },

  updateProviderSelection: async (transport, providerId, enabledModelIds) => {
    set({ selectionSavingProviderId: providerId, error: null });
    try {
      const models = await transport.updateProviderModelSelection(providerId, enabledModelIds);
      set({
        ...reconcileModels(models, get()),
        selectionSavingProviderId: null,
      });
    } catch (error) {
      set({
        selectionSavingProviderId: null,
      });
      throw error;
    }
  },

  selectProvider: (selectedProviderId) => {
    const state = get();
    const providerModels = modelsForProvider(state.models, selectedProviderId);
    if (providerModels.length === 0) return;

    const rememberedModel = state.models.find(
      (model) =>
        model.id === state.selectedModelByProvider[selectedProviderId] &&
        modelProviderId(model) === selectedProviderId &&
        model.available,
    );
    const selectedModel =
      rememberedModel?.id ?? providerModels.find((model) => model.available)?.id ?? '';
    const selectedModelByProvider =
      selectedModel === ''
        ? state.selectedModelByProvider
        : { ...state.selectedModelByProvider, [selectedProviderId]: selectedModel };

    persistSelection(selectedProviderId, selectedModelByProvider, 'explicit');
    set({
      selectedProviderId,
      selectedModel,
      selectedModelByProvider,
      routingMode: 'explicit',
      modelsForSelectedProvider: providerModels,
    });
  },

  select: (selectedModel) => {
    const state = get();
    const model = state.models.find((candidate) => candidate.id === selectedModel);
    if (!isSelectable(model)) return;

    const selectedProviderId = modelProviderId(model);
    const selectedModelByProvider = {
      ...state.selectedModelByProvider,
      [selectedProviderId]: selectedModel,
    };
    persistSelection(selectedProviderId, selectedModelByProvider, 'explicit');
    set({
      selectedProviderId,
      selectedModel,
      selectedModelByProvider,
      routingMode: 'explicit',
      modelsForSelectedProvider: modelsForProvider(state.models, selectedProviderId),
    });
  },

  enableAutomaticRouting: () => {
    const state = get();
    persistSelection(state.selectedProviderId, state.selectedModelByProvider, 'automatic');
    set({ routingMode: 'automatic' });
  },

  toggleCompare: (modelId) =>
    set((state) => {
      if (state.compareModels.includes(modelId)) {
        return { compareModels: state.compareModels.filter((id) => id !== modelId) };
      }
      const model = state.models.find((candidate) => candidate.id === modelId);
      if (!isSelectable(model) || state.compareModels.length >= 4) {
        return state;
      }
      return { compareModels: [...state.compareModels, modelId] };
    }),
}));
