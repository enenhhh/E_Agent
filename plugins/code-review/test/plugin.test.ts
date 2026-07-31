import type { JsonValue, PluginHandler } from '@e-agent/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import plugin from '../src/index.js';

function activatePlugin(): { handler: PluginHandler; log: ReturnType<typeof vi.fn> } {
  let handler: PluginHandler | undefined;
  const log = vi.fn();
  plugin.activate({
    registerCommand: (id, registered) => {
      expect(id).toBe('eagent.code-review');
      handler = registered;
      return { dispose: vi.fn() };
    },
    log,
  } as never);
  if (handler === undefined) {
    throw new Error('测试插件未注册命令');
  }
  return { handler, log };
}

describe('code-review plugin', () => {
  it('激活后为安全代码返回批准建议和 Markdown', async () => {
    const { handler, log } = activatePlugin();
    const output = (await handler({
      code: 'export const add = (left: number, right: number) => left + right;',
      language: 'typescript',
      filePath: 'src/add.ts',
      projectContext: 'TypeScript',
    })) as Record<string, JsonValue>;

    expect(output['recommendedVerdict']).toBe('approve');
    expect(output['markdown']).toContain('# 代码审查：src/add.ts');
    expect(output['markdown']).toContain('未发现确定性的静态问题');
    expect(log).toHaveBeenCalledWith(
      'info',
      '代码静态审查完成',
      expect.objectContaining({ issueCount: 0, riskScore: 0 }),
    );
  });

  it('优先扫描 diff 并区分评论与阻止合并', async () => {
    const { handler } = activatePlugin();
    const comment = (await handler({
      code: 'const ignored = true;',
      diff: '@@ -1,0 +1,1 @@\n+const value: any = input;',
      language: 'typescript',
    })) as Record<string, JsonValue>;
    expect(comment['recommendedVerdict']).toBe('comment');
    expect(comment['markdown']).toContain('[LOW]');

    const rejected = (await handler({
      diff: '@@ -1,0 +1,1 @@\n+eval(userInput);',
      language: 'javascript',
    })) as Record<string, JsonValue>;
    expect(rejected['recommendedVerdict']).toBe('request-changes');
    expect(rejected['markdown']).toContain('CWE-95');
    expect(rejected['markdown']).toContain('输入代码:1:1');
  });

  it('严格拒绝无效或过大的命令输入', async () => {
    const { handler } = activatePlugin();
    for (const input of [null, [], 'source', {}, { code: 42 }]) {
      await expect(Promise.resolve().then(() => handler(input as JsonValue))).rejects.toThrow();
    }
    await expect(
      Promise.resolve().then(() =>
        handler({
          code: 'x'.repeat(1_000_001),
        }),
      ),
    ).rejects.toThrow(/字符限制/);
  });
});
