import { z } from 'zod';

/**
 * 工具权限元数据会随每一次工具结果持久化，供审计、界面提示和后续策略判断使用。
 * 这里记录的是本次调用的实际权限决定，而不是模型自行声明的权限。
 */
export const toolPermissionMetadataSchema = z
  .object({
    capability: z.string().min(1).max(128),
    risk: z.enum(['low', 'medium', 'high']),
    approval: z.enum(['automatic', 'required']),
    scope: z.string().min(1).max(512),
    workspaceBound: z.boolean(),
    networkAccess: z.enum(['none', 'public-read', 'server-defined', 'user-session']),
    sideEffect: z.enum([
      'none',
      'browser-session',
      'process-inspection',
      'process-execution',
      'external-tool',
      'workspace-proposal',
    ]),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    outputLimitBytes: z.number().int().min(4_096).max(1_048_576),
  })
  .strict();

export type ToolPermissionMetadata = z.infer<typeof toolPermissionMetadataSchema>;

const workspaceReadTools = new Set([
  'workspace_find_files',
  'workspace_list_files',
  'workspace_read_file',
  'workspace_search_text',
]);
const browserTools = new Set([
  'browser_extract',
  'browser_navigate',
  'browser_open',
  'browser_screenshot',
]);

export function isWorkspaceBoundTool(name: string): boolean {
  return (
    workspaceReadTools.has(name) ||
    name === 'workspace_propose_write' ||
    name === 'workspace_run_command'
  );
}

export function isBrowserTool(name: string): boolean {
  return browserTools.has(name);
}

export function createToolPermissionMetadata(
  name: string,
  options: {
    bindingId?: string | null;
    conversationId: string;
    outputLimitBytes: number;
    timeoutMs: number;
    mcpApproval?: 'automatic' | 'required';
  },
): ToolPermissionMetadata {
  const outputLimitBytes = Math.max(4_096, Math.min(options.outputLimitBytes, 1_048_576));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs, 300_000));
  const workspaceScope =
    options.bindingId === undefined || options.bindingId === null
      ? 'workspace:unbound'
      : `workspace:${options.bindingId}`;
  let metadata: Omit<ToolPermissionMetadata, 'outputLimitBytes' | 'timeoutMs'>;

  if (workspaceReadTools.has(name)) {
    metadata = {
      capability: 'workspace.read',
      risk: 'low',
      approval: 'automatic',
      scope: workspaceScope,
      workspaceBound: true,
      networkAccess: 'none',
      sideEffect: 'none',
    };
  } else if (name === 'workspace_propose_write') {
    metadata = {
      capability: 'workspace.write.proposal',
      risk: 'high',
      approval: 'required',
      scope: workspaceScope,
      workspaceBound: true,
      networkAccess: 'none',
      sideEffect: 'workspace-proposal',
    };
  } else if (name === 'workspace_run_command') {
    metadata = {
      capability: 'workspace.process.execute.unsandboxed',
      risk: 'high',
      approval: 'required',
      scope: `${workspaceScope};execution:os-user-unsandboxed`,
      workspaceBound: true,
      networkAccess: 'user-session',
      sideEffect: 'process-execution',
    };
  } else if (browserTools.has(name)) {
    metadata = {
      capability: 'browser.network.public-read.best-effort',
      risk: 'high',
      approval: 'required',
      scope: `conversation:${options.conversationId}`,
      workspaceBound: false,
      networkAccess: 'public-read',
      sideEffect: 'browser-session',
    };
  } else if (name === 'computer_list_processes') {
    metadata = {
      capability: 'computer.process.inspect',
      risk: 'high',
      approval: 'required',
      scope: 'computer:local-process-metadata',
      workspaceBound: false,
      networkAccess: 'none',
      sideEffect: 'process-inspection',
    };
  } else if (name === 'computer_system_info') {
    metadata = {
      capability: 'computer.system.read',
      risk: 'low',
      approval: 'automatic',
      scope: 'computer:non-identifying-system-info',
      workspaceBound: false,
      networkAccess: 'none',
      sideEffect: 'none',
    };
  } else if (name.startsWith('mcp_')) {
    metadata = {
      capability: 'mcp.tool.invoke',
      risk: options.mcpApproval === 'automatic' ? 'medium' : 'high',
      approval: options.mcpApproval ?? 'required',
      scope: `mcp-tool:${name}`.slice(0, 512),
      workspaceBound: false,
      networkAccess: 'server-defined',
      sideEffect: 'external-tool',
    };
  } else {
    metadata = {
      capability: 'tool.unknown',
      risk: 'high',
      approval: 'required',
      scope: 'tool:unknown',
      workspaceBound: false,
      networkAccess: 'none',
      sideEffect: 'none',
    };
  }

  return toolPermissionMetadataSchema.parse({
    ...metadata,
    timeoutMs,
    outputLimitBytes,
  });
}
