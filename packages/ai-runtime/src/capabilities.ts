import type { ModelCapability, ProviderType } from '@e-agent/contracts';

export interface DiscoveredModel {
  remoteId: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow: number | null;
  metadata: Record<string, unknown>;
}

const KNOWN_CONTEXT_WINDOWS: ReadonlyArray<[RegExp, number]> = [
  [/gpt-4\.1|gpt-4o|o1|o3|o4/i, 128_000],
  [/gpt-3\.5-turbo/i, 16_385],
  [/claude-3|claude-4/i, 200_000],
  [/deepseek/i, 64_000],
  [/gemini-1\.5|gemini-2/i, 1_000_000],
  [/llama-3\.1|llama-3\.2|llama-3\.3/i, 128_000],
];

/** 基于模型名称和厂商元数据推断 UI 能力标签。 */
export function inferModelCapabilities(
  modelId: string,
  metadata: Record<string, unknown> = {},
): ModelCapability[] {
  const normalized = modelId.toLowerCase();
  const capabilities = new Set<ModelCapability>();
  const type = typeof metadata['type'] === 'string' ? metadata['type'].toLowerCase() : '';

  if (/embed|embedding|text-embedding|bge|e5/.test(normalized) || type === 'embedding') {
    capabilities.add('embedding');
    return [...capabilities];
  }
  capabilities.add('chat');
  if (/code|coder|codex|devstral|starcoder|deepseek/.test(normalized)) capabilities.add('code');
  if (/vision|gpt-4o|gpt-4\.1|gemini|claude-3|claude-4|llava|pixtral/.test(normalized)) {
    capabilities.add('vision');
  }
  if (!/instruct-only/.test(normalized)) capabilities.add('function-calling');
  if (/reason|o1|o3|o4|deepseek-r1|thinking/.test(normalized)) capabilities.add('reasoning');
  return [...capabilities];
}

export function inferContextWindow(
  modelId: string,
  metadata: Record<string, unknown> = {},
): number | null {
  const explicit =
    metadata['context_window'] ?? metadata['context_length'] ?? metadata['max_model_len'];
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) return explicit;
  return KNOWN_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(modelId))?.[1] ?? null;
}

export function normalizeProviderType(value: string): ProviderType {
  const normalized = value.toLowerCase();
  if (
    normalized === 'openai' ||
    normalized === 'anthropic' ||
    normalized === 'deepseek' ||
    normalized === 'groq' ||
    normalized === 'google' ||
    normalized === 'ollama'
  ) {
    return normalized;
  }
  return 'custom';
}
