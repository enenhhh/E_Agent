import type { JsonValue, PluginContext, PluginModule } from '@e-agent/plugin-sdk';

import {
  analyzeArchitectureInput,
  analyzeBrowserResearchInput,
  analyzeBugFixInput,
  analyzeComputerOperatorInput,
  analyzeDatabaseInput,
  analyzeDeployInput,
  analyzeDocumentationInput,
  analyzeExplainInput,
  analyzeRefactorInput,
  analyzeSecurityAuditInput,
  analyzeTestInput,
  type BuiltinSkillResult,
} from './analyzers.js';

const commands = {
  'eagent.architect': analyzeArchitectureInput,
  'eagent.browser-research': analyzeBrowserResearchInput,
  'eagent.bug-fix': analyzeBugFixInput,
  'eagent.computer-operator': analyzeComputerOperatorInput,
  'eagent.doc-gen': analyzeDocumentationInput,
  'eagent.test-gen': analyzeTestInput,
  'eagent.db-helper': analyzeDatabaseInput,
  'eagent.deploy': analyzeDeployInput,
  'eagent.explain': analyzeExplainInput,
  'eagent.refactor': analyzeRefactorInput,
  'eagent.security-audit': analyzeSecurityAuditInput,
} as const;

const plugin: PluginModule = {
  /**
   * 注册全部内置 Skill 的无外部权限确定性预分析命令；语义生成由用户选择的模型完成。
   */
  activate(context: PluginContext): void {
    for (const [commandId, analyze] of Object.entries(commands)) {
      context.registerCommand(commandId, (input) => {
        const result = analyze(input);
        context.log('info', '内置 Skill 预分析完成', {
          commandId,
          kind: result.staticAnalysis['kind'] ?? 'unknown',
        });
        return result as unknown as JsonValue;
      });
    }
  },
};

export default plugin;
export {
  analyzeArchitectureInput,
  analyzeBrowserResearchInput,
  analyzeBugFixInput,
  analyzeComputerOperatorInput,
  analyzeDatabaseInput,
  analyzeDeployInput,
  analyzeDocumentationInput,
  analyzeExplainInput,
  analyzeRefactorInput,
  analyzeSecurityAuditInput,
  analyzeTestInput,
};
export type { BuiltinSkillResult };
