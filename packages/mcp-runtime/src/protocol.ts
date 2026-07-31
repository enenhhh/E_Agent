import { z } from 'zod';

export const supportedMcpProtocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export type SupportedMcpProtocolVersion = (typeof supportedMcpProtocolVersions)[number];
export const preferredMcpProtocolVersion: SupportedMcpProtocolVersion = '2025-11-25';

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

const jsonRpcIdSchema = z.union([z.string(), z.number().finite()]);
const jsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([jsonRpcIdSchema, z.null()]).optional(),
    method: z.string().min(1).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const requestLike = value.method !== undefined;
    const responseLike = value.result !== undefined || value.error !== undefined;
    if (requestLike === responseLike) {
      context.addIssue({ code: 'custom', message: 'JSON-RPC 消息结构冲突' });
    }
    if (requestLike && value.id === null) {
      context.addIssue({ code: 'custom', message: 'JSON-RPC 请求 ID 不能为 null' });
    }
    if (responseLike && value.id === undefined) {
      context.addIssue({ code: 'custom', message: 'JSON-RPC 响应缺少 ID' });
    }
  });

const jsonSchemaSchema = z.record(z.string(), z.unknown());
export const mcpToolSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().min(1).max(256).optional(),
    description: z.string().max(8_192).optional(),
    inputSchema: jsonSchemaSchema,
    outputSchema: jsonSchemaSchema.optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const mcpContentSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

export const mcpToolResultSchema = z
  .object({
    content: z.array(mcpContentSchema).default([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().default(false),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const initializeResultSchema = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    serverInfo: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        title: z.string().optional(),
      })
      .passthrough(),
    instructions: z.string().optional(),
  })
  .passthrough();

export const listToolsResultSchema = z
  .object({
    tools: z.array(mcpToolSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .passthrough();

export type McpTool = z.infer<typeof mcpToolSchema>;
export type McpToolResult = z.infer<typeof mcpToolResultSchema>;
export type McpInitializeResult = z.infer<typeof initializeResultSchema>;

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  return jsonRpcMessageSchema.parse(value) as JsonRpcMessage;
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && ('result' in message || 'error' in message);
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}
