import type { ModelRoutingMode } from '../../stores/model-store';
import type { Model } from '../../types';

export type PromptScene = 'code' | 'chat';

/**
 * 仅把提示词开头的独立 @code / @chat 识别为场景指令。
 * 这样不会把 @code-review 等 Skill 命令误判成代码场景。
 */
export function detectPromptScene(content: string): PromptScene {
  const match = /^\s*@(code|chat)(?=$|[\s:：])/iu.exec(content);
  return match?.[1]?.toLowerCase() === 'code' ? 'code' : 'chat';
}

/**
 * 模型选择优先级：
 * 1. 用户在顶部栏显式选择的可用模型；
 * 2. 当前 @code / @chat 场景的默认模型；
 * 3. 顶部栏当前可用模型；
 * 4. 模型列表中的首个可用模型。
 */
export function resolvePromptModel(input: {
  content: string;
  selectedModel: string;
  routingMode: ModelRoutingMode;
  defaultModels: Readonly<Record<string, string>>;
  models: readonly Model[];
}): string {
  const selectableIds = new Set(
    input.models.filter((model) => model.available).map((model) => model.id),
  );
  if (input.routingMode === 'explicit' && selectableIds.has(input.selectedModel)) {
    return input.selectedModel;
  }

  const sceneDefault = input.defaultModels[detectPromptScene(input.content)] ?? '';
  if (selectableIds.has(sceneDefault)) {
    return sceneDefault;
  }
  if (selectableIds.has(input.selectedModel)) {
    return input.selectedModel;
  }
  return input.models.find((model) => model.available)?.id ?? '';
}
