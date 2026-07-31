import type {
  ChatMessageInput,
  ChatTool,
  ChatUsage,
  ModelCapability,
  ToolCall,
} from '@e-agent/contracts';

export interface RuntimeModel {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  contextWindow: number | null;
  metadata: Record<string, unknown>;
}

export interface RuntimeChatRequest {
  model: string;
  messages: ChatMessageInput[];
  tools?: ChatTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
      /** 兼容部分厂商在结束帧返回完整 tool call，而不是继续发送增量。 */
      snapshot?: boolean;
    }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; finishReason: string | null };

export interface RuntimeChatResponse {
  model: string;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: ChatUsage;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs: number;
  status: number | null;
  error: string | null;
}
