import { describe, expect, it } from 'vitest';

import { scanCode } from '../src/scanner.js';

describe('scanCode', () => {
  it('发现密钥但不在证据中复述敏感值', () => {
    const result = scanCode('const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";', {
      language: 'typescript',
    });
    expect(result.issues[0]).toMatchObject({
      ruleId: 'security.hardcoded-secret',
      severity: 'critical',
      evidence: '[敏感内容已隐藏]',
    });
    expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('只扫描 diff 新增行并保留新文件行号', () => {
    const diff = [
      '@@ -8,2 +8,3 @@',
      '-const safe = true;',
      '+const safe = true;',
      '+eval(userInput);',
      ' return safe;',
    ].join('\n');
    const result = scanCode(diff, { diff: true, language: 'javascript' });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        ruleId: 'security.dynamic-eval',
        line: 9,
      }),
    );
    expect(result.changedLines).toBe(2);
  });

  it('按语言过滤不适用规则', () => {
    const source = 'value: any';
    expect(scanCode(source, { language: 'typescript' }).issues).toHaveLength(1);
    expect(scanCode(source, { language: 'python' }).issues).toHaveLength(0);
  });

  it('对无问题代码返回零风险', () => {
    const result = scanCode('export const add = (a: number, b: number) => a + b;', {
      language: 'typescript',
    });
    expect(result).toMatchObject({ riskScore: 0, issues: [] });
  });
});
