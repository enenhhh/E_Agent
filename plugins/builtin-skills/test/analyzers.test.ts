import { describe, expect, it } from 'vitest';

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
} from '../src/analyzers.js';

describe('built-in skill analyzers', () => {
  it('提取文档目标中的具名符号且不改写源码', () => {
    const result = analyzeDocumentationInput({
      code: 'export function add(a: number, b: number) { return a + b; }',
      language: 'TypeScript',
      filePath: 'src/add.ts',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'documentation',
      symbols: ['add'],
    });
    expect(result.llmPromptVariables['code']).toContain('return a + b');
  });

  it('根据项目上下文识别测试框架和测试文件', () => {
    const result = analyzeTestInput({
      code: 'export const add = (a: number, b: number) => a + b;',
      language: 'TypeScript',
      filePath: 'src/add.ts',
      projectContext: 'package.json devDependencies: vitest',
    });
    expect(result.staticAnalysis).toMatchObject({
      framework: 'Vitest',
      testFilePath: 'src/add.test.ts',
    });
  });

  it('识别数据库破坏性操作并约束方言', () => {
    expect(
      analyzeDatabaseInput({
        request: 'DROP TABLE users',
        dialect: 'postgresql',
      }).staticAnalysis,
    ).toMatchObject({
      dialect: 'PostgreSQL',
      operation: 'schema',
      risk: 'high',
      requiresTransaction: true,
    });
    expect(() => analyzeDatabaseInput({ request: '查询用户', dialect: 'oracle' })).toThrow(
      /dialect/,
    );
  });

  it('从项目描述识别部署运行时和端口', () => {
    const result = analyzeDeployInput({
      projectContext: 'Node.js service with package.json; port: 4318',
      target: 'kubernetes',
    });
    expect(result.staticAnalysis).toMatchObject({
      runtime: 'Node.js',
      target: 'kubernetes',
      ports: [4318],
      requiresNonRootUser: true,
    });
  });

  it('计算解释输入的分支、循环和递归候选', () => {
    const result = analyzeExplainInput({
      code: [
        'function walk(node) {',
        '  if (!node) return;',
        '  for (const child of node.children) walk(child);',
        '}',
      ].join('\n'),
      language: 'JavaScript',
    });
    expect(result.staticAnalysis).toMatchObject({
      estimatedCyclomaticComplexity: 3,
      loopCount: 1,
      recursionCandidates: ['walk'],
    });
  });

  it('拒绝非对象、非字符串和空必填输入', () => {
    expect(() => analyzeDocumentationInput(null)).toThrow(/对象/);
    expect(() => analyzeTestInput({ code: 42 })).toThrow(/字符串/);
    expect(() => analyzeExplainInput({ code: '   ' })).toThrow(/不能为空/);
  });

  it('提取故障错误、堆栈、复现和测试线索', () => {
    const result = analyzeBugFixInput({
      request: '复现：启动后抛出 TypeError，请补测试',
      code: 'TypeError: bad value\n    at start (src/main.ts:2:1)',
      filePath: 'src/main.ts',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'bug-fix',
      errorNames: ['TypeError'],
      stackFrames: 1,
      hasReproduction: true,
      hasTests: true,
      sourceProvided: true,
    });
  });

  it('提取架构质量属性与集成边界', () => {
    const result = analyzeArchitectureInput({
      request: '设计低延迟且可靠的 API',
      projectContext: 'REST API uses PostgreSQL and Redis',
      constraints: '安全优先，预算固定',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'architecture',
      qualityAttributes: ['security', 'reliability', 'performance', 'cost'],
      integrations: ['REST', 'PostgreSQL', 'Redis'],
      hasExplicitConstraints: true,
    });
  });

  it('计算重构规模、依赖、分支和可变状态', () => {
    const result = analyzeRefactorInput({
      request: '降低复杂度但保持行为',
      code: [
        "import value from './value.js';",
        'export function run(items) {',
        '  if (items) items.push(value);',
        '}',
      ].join('\n'),
      projectContext: 'vitest tests',
      filePath: 'src/run.ts',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'refactor',
      branchPoints: 1,
      dependencyCount: 1,
      mutationCount: 1,
      hasTestContext: true,
    });
  });

  it('安全预扫描只输出待验证模式及严重度', () => {
    const result = analyzeSecurityAuditInput({
      request: '审计用户输入路径',
      code: [
        'const password = "should-not-be-here";',
        'eval(userInput);',
        'fetch(url, { rejectUnauthorized: false });',
      ].join('\n'),
      filePath: 'src/unsafe.ts',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'security-audit',
      requiresManualVerification: true,
      findingCount: 3,
    });
    expect(result.staticAnalysis['findings']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'dynamic-code-execution', severity: 'high' }),
        expect.objectContaining({ rule: 'hard-coded-secret', severity: 'high' }),
        expect.objectContaining({ rule: 'disabled-tls-check', severity: 'high' }),
      ]),
    );
  });

  it('规范化浏览器研究时效和域名约束', () => {
    const result = analyzeBrowserResearchInput({
      query: '查找最新 TypeScript 发布说明',
      freshness: '30 days',
      allowedDomains: 'typescriptlang.org, github.com invalid localhost',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'browser-research',
      freshness: '30 days',
      allowedDomains: ['typescriptlang.org', 'github.com'],
      requiresDateVerification: true,
      requiresMultipleSources: true,
    });
  });

  it('识别电脑操作中的外部影响动作', () => {
    const result = analyzeComputerOperatorInput({
      request: '在邮件应用发送草稿，然后删除旧附件',
      appName: 'Mail',
      constraints: '不得读取其他邮件',
    });
    expect(result.staticAnalysis).toMatchObject({
      kind: 'computer-operator',
      appName: 'Mail',
      highImpactActions: ['submit-or-send', 'delete'],
      requiresFinalConfirmation: true,
      constraintsProvided: true,
    });
  });

  it('覆盖无路径文档、现有注释以及 Python/Go 符号提取', () => {
    const result = analyzeDocumentationInput({
      code: ['/** existing */', 'async def fetch_user():', '  pass', 'func Save() {}'].join('\n'),
    });
    expect(result.staticAnalysis).toMatchObject({
      hasExistingDocumentation: true,
      symbols: ['fetch_user', 'Save'],
    });
    expect(result.markdown).toContain('未指定');
    expect(result.markdown).toContain('自动识别');
    expect(analyzeDocumentationInput({ code: 'answer = 42' }).staticAnalysis['symbols']).toEqual(
      [],
    );
  });

  it.each([
    [{ testFramework: 'Mocha', language: '', projectContext: '' }, 'Mocha'],
    [{ testFramework: 'auto', language: '', projectContext: 'jest' }, 'Jest'],
    [{ testFramework: '', language: 'Python', projectContext: '' }, 'PyTest'],
    [{ testFramework: '', language: 'Go', projectContext: 'testing package' }, 'GoTest'],
    [{ testFramework: '', language: '', projectContext: 'go.mod' }, 'GoTest'],
    [{ testFramework: '', language: 'JavaScript', projectContext: '' }, 'Jest'],
    [{ testFramework: '', language: 'Rust', projectContext: '' }, '项目现有测试框架'],
  ])('识别测试框架 %#', (input, expected) => {
    expect(
      analyzeTestInput({
        code: 'export function value() { return 1; }',
        filePath: '',
        ...input,
      }).staticAnalysis['framework'],
    ).toBe(expected);
  });

  it('生成 PyTest、GoTest 和无扩展脚本的目标路径', () => {
    expect(
      analyzeTestInput({
        code: 'def value(): return 1',
        language: 'Python',
        filePath: 'src/value.py',
      }).staticAnalysis['testFilePath'],
    ).toBe('src/test_value.py');
    expect(
      analyzeTestInput({
        code: 'func Value() int { return 1 }',
        language: 'Go',
        filePath: 'value.go',
      }).staticAnalysis['testFilePath'],
    ).toBe('value_test.go');
    expect(
      analyzeTestInput({
        code: 'export const value = 1',
        language: 'TypeScript',
        filePath: 'scripts/value',
      }).staticAnalysis['testFilePath'],
    ).toBe('scripts/value.test.ts');
  });

  it.each([
    [{ request: 'SELECT id FROM users', dialect: 'mysql' }, 'MySQL', 'read', 'low'],
    [
      { request: 'UPDATE users SET active = false', dialect: 'pg' },
      'PostgreSQL',
      'write',
      'medium',
    ],
    [
      { request: 'create a report', dialect: 'auto', projectContext: 'mongoose' },
      'MongoDB',
      'schema',
      'low',
    ],
    [
      { request: '建表 audit', dialect: '', projectContext: 'sqlite database' },
      'SQLite',
      'schema',
      'low',
    ],
    [
      { request: '查询用户', dialect: '', projectContext: 'postgres client' },
      'PostgreSQL',
      'read',
      'low',
    ],
    [{ request: '查询用户', dialect: '', projectContext: 'mysql2 driver' }, 'MySQL', 'read', 'low'],
  ])('识别数据库请求 %#', (input, dialect, operation, risk) => {
    expect(analyzeDatabaseInput(input).staticAnalysis).toMatchObject({
      dialect,
      operation,
      risk,
    });
  });

  it.each([
    ['requirements.txt with FastAPI', 'Python'],
    ['go.mod module example', 'Go'],
    ['pom.xml Spring Boot', 'Java'],
    ['Cargo.toml Rust', 'Rust'],
    ['binary service without metadata', '需从项目文件确认'],
  ])('识别部署运行时 %s', (projectContext, runtime) => {
    expect(analyzeDeployInput({ projectContext }).staticAnalysis).toMatchObject({
      runtime,
      target: 'docker-compose+kubernetes',
      ports: [],
    });
  });

  it('忽略非法端口并限制端口收集数量', () => {
    const ports = Array.from({ length: 18 }, (_value, index) => `port: ${3000 + index}`).join('\n');
    const result = analyzeDeployInput({
      projectContext: `Node.js\nport: 99999\n${ports}`,
      target: 'docker',
    });
    expect(result.staticAnalysis['ports']).toHaveLength(16);
    expect(result.staticAnalysis['ports']).not.toContain(99999);
  });

  it('处理没有递归、路径和可选字段的解释输入', () => {
    const result = analyzeExplainInput({ code: 'const value = 1;' });
    expect(result.staticAnalysis).toMatchObject({
      recursionCandidates: [],
      loopCount: 0,
      estimatedCyclomaticComplexity: 1,
    });
    expect(result.markdown).toContain('未指定');
  });

  it('拒绝缺失字段、null、超长字段和无效类型', () => {
    expect(() => analyzeDeployInput({})).toThrow(/必填/);
    expect(analyzeDocumentationInput({ code: 'const value = 1;', language: null })).toMatchObject({
      llmPromptVariables: { language: '' },
    });
    expect(() =>
      analyzeDocumentationInput({
        code: 'const value = 1;',
        language: 'x'.repeat(65),
      }),
    ).toThrow(/字符限制/);
  });
});
