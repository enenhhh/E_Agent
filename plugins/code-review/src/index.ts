import type { JsonValue, PluginContext, PluginModule } from '@e-agent/plugin-sdk';

import { scanCode, type StaticReviewResult } from './scanner.js';

interface ReviewInput {
  code: string;
  diff: string;
  language: string;
  filePath: string;
  projectContext: string;
}

interface ReviewOutput {
  staticAnalysis: StaticReviewResult;
  recommendedVerdict: 'approve' | 'comment' | 'request-changes';
  llmPromptVariables: ReviewInput;
  markdown: string;
}

const plugin: PluginModule = {
  /**
   * 注册确定性静态扫描命令。深度语义审查由 Skill Prompt 交给用户选择的模型。
   */
  activate(context: PluginContext): void {
    context.registerCommand('eagent.code-review', (input) => {
      const parsed = parseReviewInput(input);
      const source = parsed.diff.length > 0 ? parsed.diff : parsed.code;
      const staticAnalysis = scanCode(source, {
        language: parsed.language,
        diff: parsed.diff.length > 0,
      });
      const output: ReviewOutput = {
        staticAnalysis,
        recommendedVerdict: verdictFor(staticAnalysis),
        llmPromptVariables: parsed,
        markdown: formatMarkdown(staticAnalysis, parsed.filePath),
      };
      context.log('info', '代码静态审查完成', {
        issueCount: staticAnalysis.issues.length,
        riskScore: staticAnalysis.riskScore,
      });
      return output as unknown as JsonValue;
    });
  },
};

export default plugin;
export { scanCode } from './scanner.js';
export type { ReviewInput, ReviewOutput };
export type { StaticReviewIssue, StaticReviewResult } from './scanner.js';

function parseReviewInput(input: JsonValue): ReviewInput {
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('代码审查输入必须是对象');
  }
  const record = input as Readonly<Record<string, JsonValue>>;
  const code = optionalString(record['code'], 'code', 1_000_000);
  const diff = optionalString(record['diff'], 'diff', 1_000_000);
  if (code.length === 0 && diff.length === 0) {
    throw new Error('code 和 diff 至少提供一项');
  }
  return {
    code,
    diff,
    language: optionalString(record['language'], 'language', 64),
    filePath: optionalString(record['filePath'], 'filePath', 1_024),
    projectContext: optionalString(record['projectContext'], 'projectContext', 20_000),
  };
}

function optionalString(
  value: JsonValue | undefined,
  field: string,
  maximumLength: number,
): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} 必须是字符串`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${field} 超过 ${maximumLength} 字符限制`);
  }
  return value;
}

function verdictFor(result: StaticReviewResult): ReviewOutput['recommendedVerdict'] {
  if (result.counts.critical > 0 || result.counts.high > 0) {
    return 'request-changes';
  }
  if (result.counts.medium > 0 || result.counts.low > 0) {
    return 'comment';
  }
  return 'approve';
}

function formatMarkdown(result: StaticReviewResult, filePath: string): string {
  const title = filePath.length > 0 ? `代码审查：${filePath}` : '代码审查';
  const lines = [
    `# ${title}`,
    '',
    `风险评分：${result.riskScore}/100；扫描 ${result.changedLines} 行；发现 ${result.issues.length} 项。`,
  ];
  if (result.issues.length === 0) {
    lines.push('', '未发现确定性的静态问题。仍建议运行测试并执行语义审查。');
    return lines.join('\n');
  }
  for (const issue of result.issues) {
    lines.push(
      '',
      `## [${issue.severity.toUpperCase()}] ${issue.title}`,
      '',
      `- 位置：${filePath || '输入代码'}:${issue.line}:${issue.column}`,
      `- 规则：${issue.ruleId}${issue.cwe === undefined ? '' : ` / ${issue.cwe}`}`,
      `- 证据：${issue.evidence}`,
      `- 影响：${issue.message}`,
      `- 建议：${issue.suggestion}`,
    );
  }
  return lines.join('\n');
}
