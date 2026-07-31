import { describe, expect, it } from 'vitest';

import {
  createToolPermissionMetadata,
  isBrowserTool,
  isWorkspaceBoundTool,
} from './tool-permissions.js';

const defaults = {
  bindingId: '2533aa55-37ca-4c67-88db-70ff00fa1881',
  conversationId: 'conversation-a',
  outputLimitBytes: 131_072,
  timeoutMs: 60_000,
};

describe('tool permission metadata', () => {
  it('把工作区写入、命令和进程检查标记为必须审批', () => {
    for (const name of [
      'workspace_propose_write',
      'workspace_run_command',
      'computer_list_processes',
    ]) {
      expect(createToolPermissionMetadata(name, defaults)).toEqual(
        expect.objectContaining({
          approval: 'required',
          risk: 'high',
        }),
      );
    }
  });

  it('明确命令仅绑定 cwd、并非 OS 或网络沙箱', () => {
    expect(createToolPermissionMetadata('workspace_run_command', defaults)).toEqual(
      expect.objectContaining({
        capability: 'workspace.process.execute.unsandboxed',
        approval: 'required',
        risk: 'high',
        scope: `workspace:${defaults.bindingId};execution:os-user-unsandboxed`,
        workspaceBound: true,
        networkAccess: 'user-session',
        sideEffect: 'process-execution',
      }),
    );
  });

  it('把只读工作区和匿名系统信息标记为自动能力', () => {
    expect(createToolPermissionMetadata('workspace_find_files', defaults)).toEqual(
      expect.objectContaining({
        capability: 'workspace.read',
        approval: 'automatic',
        workspaceBound: true,
      }),
    );
    expect(createToolPermissionMetadata('computer_system_info', defaults)).toEqual(
      expect.objectContaining({
        capability: 'computer.system.read',
        approval: 'automatic',
        networkAccess: 'none',
      }),
    );
  });

  it.each(['browser_open', 'browser_navigate', 'browser_extract', 'browser_screenshot'])(
    '把浏览器工具 %s 标记为高风险且必须审批',
    (name) => {
      expect(createToolPermissionMetadata(name, defaults)).toEqual(
        expect.objectContaining({
          capability: 'browser.network.public-read.best-effort',
          approval: 'required',
          risk: 'high',
          networkAccess: 'public-read',
          scope: 'conversation:conversation-a',
        }),
      );
    },
  );

  it('未知工具 fail closed，且正确识别浏览器与工作区边界', () => {
    expect(createToolPermissionMetadata('unknown_tool', defaults)).toEqual(
      expect.objectContaining({
        capability: 'tool.unknown',
        approval: 'required',
        risk: 'high',
      }),
    );
    expect(isBrowserTool('browser_open')).toBe(true);
    expect(isBrowserTool('workspace_read_file')).toBe(false);
    expect(isWorkspaceBoundTool('workspace_run_command')).toBe(true);
    expect(isWorkspaceBoundTool('browser_open')).toBe(false);
  });
});
