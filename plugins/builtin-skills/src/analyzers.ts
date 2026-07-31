import type { JsonValue } from '@e-agent/plugin-sdk';

export interface BuiltinSkillResult {
  staticAnalysis: Readonly<Record<string, JsonValue>>;
  llmPromptVariables: Readonly<Record<string, string>>;
  markdown: string;
}

const maximumSourceLength = 1_000_000;
const maximumContextLength = 100_000;

/**
 * 对文档生成输入执行确定性预分析，只提取源码中能够直接验证的符号。
 */
export function analyzeDocumentationInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const code = stringField(record, 'code', maximumSourceLength, true);
  const language = stringField(record, 'language', 64);
  const filePath = stringField(record, 'filePath', 1_024);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const docStyle = stringField(record, 'docStyle', 64);
  const symbols = extractSymbols(code);
  const variables = { code, language, filePath, projectContext, docStyle };
  return {
    staticAnalysis: {
      kind: 'documentation',
      lineCount: lineCount(code),
      symbols,
      hasExistingDocumentation: /\/\*\*|^\s*#\s+\S|^\s*"""|^\s*'''/mu.test(code),
    },
    llmPromptVariables: variables,
    markdown: [
      '# 文档生成预分析',
      '',
      `- 文件：${filePath || '未指定'}`,
      `- 语言：${language || '自动识别'}`,
      `- 可验证符号：${symbols.length > 0 ? symbols.join('、') : '未识别到具名符号'}`,
      `- 源码行数：${lineCount(code)}`,
    ].join('\n'),
  };
}

/**
 * 推断测试框架和目标测试文件，但不虚构项目中不存在的依赖。
 */
export function analyzeTestInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const code = stringField(record, 'code', maximumSourceLength, true);
  const language = stringField(record, 'language', 64);
  const filePath = stringField(record, 'filePath', 1_024);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const requestedFramework = stringField(record, 'testFramework', 64);
  const framework = inferTestFramework(language, projectContext, requestedFramework);
  const testFilePath = inferTestFilePath(filePath, language, framework);
  const variables = {
    code,
    language,
    filePath,
    projectContext,
    testFramework: requestedFramework,
  };
  return {
    staticAnalysis: {
      kind: 'test-generation',
      framework,
      testFilePath,
      symbols: extractSymbols(code),
      branchPoints: countMatches(code, /\b(?:if|else|case|catch|for|while)\b|\?\?|&&|\|\|/gu),
    },
    llmPromptVariables: variables,
    markdown: [
      '# 测试生成预分析',
      '',
      `- 推断框架：${framework}`,
      `- 建议测试文件：${testFilePath || '需根据项目结构确定'}`,
      '- 生成结果必须覆盖正常路径、边界条件和错误路径。',
    ].join('\n'),
  };
}

/**
 * 识别数据库方言和高风险操作，为后续 SQL/查询生成提供安全约束。
 */
export function analyzeDatabaseInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const request = stringField(record, 'request', 200_000, true);
  const dialectInput = stringField(record, 'dialect', 32).toLowerCase();
  const databaseSchema = stringField(record, 'databaseSchema', 500_000);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const dialect = normalizeDialect(dialectInput, projectContext);
  const risk = classifyDatabaseRisk(request);
  const variables = { request, dialect: dialectInput, databaseSchema, projectContext };
  return {
    staticAnalysis: {
      kind: 'database',
      dialect,
      operation: inferDatabaseOperation(request),
      risk,
      requiresTransaction: /\b(?:update|delete|insert|alter|drop|truncate|迁移|删除|更新)\b/iu.test(
        request,
      ),
      schemaProvided: databaseSchema.trim().length > 0,
    },
    llmPromptVariables: variables,
    markdown: [
      '# 数据库请求预分析',
      '',
      `- 方言：${dialect}`,
      `- 风险：${risk}`,
      '- 所有外部值必须使用该方言支持的参数绑定，不得拼接到查询文本。',
    ].join('\n'),
  };
}

/**
 * 从项目描述中识别部署运行时、端口和目标，输出可审查的生成约束。
 */
export function analyzeDeployInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const projectContext = stringField(record, 'projectContext', 500_000, true);
  const target = stringField(record, 'target', 64);
  const requirements = stringField(record, 'requirements', 100_000);
  const runtime = inferRuntime(`${projectContext}\n${requirements}`);
  const ports = extractPorts(`${projectContext}\n${requirements}`);
  const normalizedTarget = target.trim() || 'docker-compose+kubernetes';
  const variables = { projectContext, target, requirements };
  return {
    staticAnalysis: {
      kind: 'deployment',
      runtime,
      target: normalizedTarget,
      ports,
      requiresHealthCheck: true,
      requiresNonRootUser: true,
    },
    llmPromptVariables: variables,
    markdown: [
      '# 部署生成预分析',
      '',
      `- 运行时：${runtime}`,
      `- 目标：${normalizedTarget}`,
      `- 已识别端口：${ports.length > 0 ? ports.join('、') : '未明确'}`,
      '- 输出必须包含健康检查、非 root 用户、资源限制和 Secret 注入方式。',
    ].join('\n'),
  };
}

/**
 * 计算可重复的代码规模和控制流指标，为逐段解释和复杂度标注提供依据。
 */
export function analyzeExplainInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const code = stringField(record, 'code', maximumSourceLength, true);
  const language = stringField(record, 'language', 64);
  const filePath = stringField(record, 'filePath', 1_024);
  const detailLevel = stringField(record, 'detailLevel', 32);
  const branchPoints = countMatches(
    code,
    /\b(?:if|else\s+if|case|catch|for|while)\b|&&|\|\||\?\?/gu,
  );
  const loopCount = countMatches(code, /\b(?:for|while)\b/gu);
  const recursionCandidates = detectRecursionCandidates(code);
  const variables = { code, language, filePath, detailLevel };
  return {
    staticAnalysis: {
      kind: 'explanation',
      lineCount: lineCount(code),
      nonEmptyLines: code.split(/\r?\n/u).filter((line) => line.trim().length > 0).length,
      branchPoints,
      estimatedCyclomaticComplexity: branchPoints + 1,
      loopCount,
      recursionCandidates,
      symbols: extractSymbols(code),
    },
    llmPromptVariables: variables,
    markdown: [
      '# 代码解释预分析',
      '',
      `- 文件：${filePath || '未指定'}`,
      `- 估算圈复杂度：${branchPoints + 1}`,
      `- 循环数量：${loopCount}`,
      `- 递归候选：${recursionCandidates.length > 0 ? recursionCandidates.join('、') : '无'}`,
    ].join('\n'),
  };
}

/**
 * 提取故障证据、复现线索与回归测试线索，避免模型在没有证据时直接改代码。
 */
export function analyzeBugFixInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const request = stringField(record, 'request', 200_000, true);
  const code = stringField(record, 'code', maximumSourceLength);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const filePath = stringField(record, 'filePath', 1_024);
  const combined = `${request}\n${code}\n${projectContext}`;
  const errorNames = [
    ...new Set(
      [...combined.matchAll(/\b([A-Z][A-Za-z]+(?:Error|Exception))\b/gu)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined),
    ),
  ].slice(0, 20);
  const stackFrames = countMatches(combined, /^\s*at\s+\S+|^\s*File\s+"[^"]+",\s+line\s+\d+/gmu);
  const hasReproduction = /repro|steps to reproduce|复现|重现|触发条件/iu.test(request);
  const hasTests = /\b(?:test|spec|vitest|jest|pytest|go test)\b|测试/iu.test(combined);
  return {
    staticAnalysis: {
      kind: 'bug-fix',
      errorNames,
      stackFrames,
      hasReproduction,
      hasTests,
      sourceProvided: code.trim().length > 0,
      symbols: extractSymbols(code),
    },
    llmPromptVariables: { request, code, projectContext, filePath },
    markdown: [
      '# 故障修复预分析',
      '',
      `- 错误类型：${errorNames.length > 0 ? errorNames.join('、') : '未识别'}`,
      `- 堆栈帧：${stackFrames}`,
      `- 已提供复现线索：${hasReproduction ? '是' : '否'}`,
      `- 已发现测试线索：${hasTests ? '是' : '否'}`,
      '- 修复前必须用代码、日志或测试验证根因，修复后必须执行回归检查。',
    ].join('\n'),
  };
}

/**
 * 提取架构目标中的质量属性、集成边界与约束线索。
 */
export function analyzeArchitectureInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const request = stringField(record, 'request', 200_000, true);
  const projectContext = stringField(record, 'projectContext', 500_000);
  const constraints = stringField(record, 'constraints', maximumContextLength);
  const combined = `${request}\n${projectContext}\n${constraints}`;
  const qualityAttributes = [
    ['security', /security|安全|权限|加密/iu],
    ['reliability', /reliab|availability|可靠|可用性|容灾/iu],
    ['performance', /performance|latency|throughput|性能|延迟|吞吐/iu],
    ['scalability', /scalab|扩展|伸缩/iu],
    ['maintainability', /maintain|维护|演进|可测试/iu],
    ['cost', /cost|budget|成本|预算/iu],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(combined))
    .map(([name]) => name as string);
  const integrations = [
    ...new Set(
      [
        ...combined.matchAll(
          /\b(?:HTTP|REST|GraphQL|gRPC|Kafka|Redis|PostgreSQL|MySQL|SQLite|S3)\b/giu,
        ),
      ]
        .map((match) => match[0])
        .filter((value): value is string => value !== undefined),
    ),
  ].slice(0, 30);
  return {
    staticAnalysis: {
      kind: 'architecture',
      qualityAttributes,
      integrations,
      hasExplicitConstraints: constraints.trim().length > 0,
      projectContextProvided: projectContext.trim().length > 0,
    },
    llmPromptVariables: { request, projectContext, constraints },
    markdown: [
      '# 架构设计预分析',
      '',
      `- 质量属性：${qualityAttributes.length > 0 ? qualityAttributes.join('、') : '需进一步确认'}`,
      `- 集成线索：${integrations.length > 0 ? integrations.join('、') : '未识别'}`,
      `- 显式约束：${constraints.trim().length > 0 ? '已提供' : '未提供'}`,
      '- 方案必须包含边界、数据流、失败模式、迁移路径与可验证的取舍。',
    ].join('\n'),
  };
}

/**
 * 计算重构目标的规模、分支、符号和高耦合线索。
 */
export function analyzeRefactorInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const code = stringField(record, 'code', maximumSourceLength, true);
  const request = stringField(record, 'request', 200_000, true);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const filePath = stringField(record, 'filePath', 1_024);
  const branchPoints = countMatches(code, /\b(?:if|else|case|catch|for|while)\b|&&|\|\||\?\?/gu);
  const dependencyCount = countMatches(
    code,
    /^\s*(?:import\b|(?:const|let|var)\b[^\n=]*=\s*require\s*\(|using\s+|#include\s*[<"])/gmu,
  );
  const mutationCount = countMatches(code, /(?:\+\+|--|\+=|-=|\*=|\/=|\.push\(|\.splice\()/gu);
  return {
    staticAnalysis: {
      kind: 'refactor',
      lineCount: lineCount(code),
      symbols: extractSymbols(code),
      branchPoints,
      dependencyCount,
      mutationCount,
      hasTestContext: /\b(?:test|spec|vitest|jest|pytest|go test)\b|测试/iu.test(projectContext),
    },
    llmPromptVariables: { code, request, projectContext, filePath },
    markdown: [
      '# 重构预分析',
      '',
      `- 文件：${filePath || '未指定'}`,
      `- 行数：${lineCount(code)}`,
      `- 分支点：${branchPoints}`,
      `- 依赖线索：${dependencyCount}`,
      `- 可变状态线索：${mutationCount}`,
      '- 重构必须保持公共契约与可观察行为，并由测试保护。',
    ].join('\n'),
  };
}

/**
 * 执行保守的安全模式扫描；仅把命中项作为待人工验证的证据线索。
 */
export function analyzeSecurityAuditInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const code = stringField(record, 'code', maximumSourceLength, true);
  const request = stringField(record, 'request', 200_000, true);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const filePath = stringField(record, 'filePath', 1_024);
  const rules: ReadonlyArray<readonly [string, RegExp, 'high' | 'low' | 'medium']> = [
    ['dynamic-code-execution', /\b(?:eval|Function)\s*\(/gu, 'high'],
    ['shell-execution', /\b(?:exec|execSync|spawn|system)\s*\(/gu, 'high'],
    ['unsafe-html', /dangerouslySetInnerHTML|\.innerHTML\s*=/gu, 'medium'],
    ['weak-hash', /\b(?:md5|sha1)\b/giu, 'medium'],
    ['hard-coded-secret', /(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/giu, 'high'],
    ['sql-concatenation', /\b(?:select|insert|update|delete)\b[^;\n]*\$\{|[+]\s*\w+/giu, 'medium'],
    ['disabled-tls-check', /rejectUnauthorized\s*:\s*false|verify\s*=\s*False/gu, 'high'],
  ];
  const findings = rules.flatMap(([rule, pattern, severity]) => {
    const count = countMatches(code, pattern);
    return count === 0 ? [] : [{ rule, severity, count }];
  });
  return {
    staticAnalysis: {
      kind: 'security-audit',
      filePath,
      findings,
      findingCount: findings.reduce((total, finding) => total + finding.count, 0),
      requiresManualVerification: true,
      sourceLines: lineCount(code),
    },
    llmPromptVariables: { code, request, projectContext, filePath },
    markdown: [
      '# 安全审计预扫描',
      '',
      `- 文件：${filePath || '未指定'}`,
      `- 模式命中：${findings.length}`,
      '- 每个命中项都必须沿输入、校验、信任边界和敏感汇逐项验证，禁止直接按正则命中定性漏洞。',
    ].join('\n'),
  };
}

/**
 * 规范化浏览器研究问题、时效窗口和域名约束。
 */
export function analyzeBrowserResearchInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const query = stringField(record, 'query', 200_000, true);
  const freshness = stringField(record, 'freshness', 64);
  const allowedDomains = stringField(record, 'allowedDomains', 10_000);
  const projectContext = stringField(record, 'projectContext', maximumContextLength);
  const domains = [
    ...new Set(
      allowedDomains
        .split(/[\s,;]+/u)
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u.test(domain)),
    ),
  ].slice(0, 50);
  const looksCurrent = /latest|current|today|recent|最新|当前|今天|近期/iu.test(query);
  return {
    staticAnalysis: {
      kind: 'browser-research',
      freshness: freshness.trim() || (looksCurrent ? 'current' : 'not-specified'),
      allowedDomains: domains,
      requiresDateVerification: looksCurrent,
      requiresMultipleSources: true,
    },
    llmPromptVariables: { query, freshness, allowedDomains, projectContext },
    markdown: [
      '# 浏览器研究预分析',
      '',
      `- 时效要求：${freshness.trim() || (looksCurrent ? '当前信息' : '未指定')}`,
      `- 限定域名：${domains.length > 0 ? domains.join('、') : '无'}`,
      '- 搜索摘要只能用于发现来源，结论必须来自已打开并核验的页面。',
    ].join('\n'),
  };
}

/**
 * 提取电脑操作中的应用目标和高影响动作，供执行前确认。
 */
export function analyzeComputerOperatorInput(input: JsonValue): BuiltinSkillResult {
  const record = objectInput(input);
  const request = stringField(record, 'request', 200_000, true);
  const appName = stringField(record, 'appName', 256);
  const constraints = stringField(record, 'constraints', maximumContextLength);
  const highImpactActions = [
    ['submit-or-send', /submit|send|publish|提交|发送|发布/iu],
    ['delete', /delete|remove|erase|删除|移除|清空/iu],
    ['purchase', /buy|purchase|pay|购买|付款|支付/iu],
    ['permission-change', /permission|grant|admin|权限|授权|管理员/iu],
    ['account-change', /login|logout|password|登录|退出|密码/iu],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(request))
    .map(([action]) => action as string);
  return {
    staticAnalysis: {
      kind: 'computer-operator',
      appName: appName.trim() || '未指定',
      highImpactActions,
      requiresFinalConfirmation: highImpactActions.length > 0,
      constraintsProvided: constraints.trim().length > 0,
    },
    llmPromptVariables: { request, appName, constraints },
    markdown: [
      '# 电脑操作预分析',
      '',
      `- 目标应用：${appName.trim() || '未指定'}`,
      `- 高影响动作：${highImpactActions.length > 0 ? highImpactActions.join('、') : '未识别'}`,
      `- 最终确认：${highImpactActions.length > 0 ? '需要' : '按实际界面状态判断'}`,
      '- 每一步都必须根据当前可见界面定位，禁止盲目复用旧坐标。',
    ].join('\n'),
  };
}

function objectInput(input: JsonValue): Readonly<Record<string, JsonValue>> {
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Skill 输入必须是对象');
  }
  return input;
}

function stringField(
  record: Readonly<Record<string, JsonValue>>,
  field: string,
  maximumLength: number,
  required = false,
): string {
  const value = record[field];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} 为必填字段`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  if (value.length > maximumLength) throw new Error(`${field} 超过 ${maximumLength} 字符限制`);
  if (required && value.trim().length === 0) throw new Error(`${field} 不能为空`);
  return value;
}

function extractSymbols(code: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\b(?:class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/gu,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gu,
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gmu,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
      if (names.size >= 50) return [...names];
    }
  }
  return [...names];
}

function inferTestFramework(language: string, projectContext: string, requested: string): string {
  if (requested.trim().length > 0 && requested.toLowerCase() !== 'auto') return requested.trim();
  const context = projectContext.toLowerCase();
  const normalizedLanguage = language.toLowerCase();
  if (context.includes('vitest')) return 'Vitest';
  if (context.includes('jest')) return 'Jest';
  if (context.includes('pytest') || normalizedLanguage.includes('python')) return 'PyTest';
  if (context.includes('testing') && normalizedLanguage === 'go') return 'GoTest';
  if (normalizedLanguage === 'go' || context.includes('go.mod')) return 'GoTest';
  if (/typescript|javascript|\bts\b|\bjs\b/u.test(normalizedLanguage)) return 'Jest';
  return '项目现有测试框架';
}

function inferTestFilePath(filePath: string, language: string, framework: string): string {
  if (filePath.trim().length === 0) return '';
  const normalized = filePath.replaceAll('\\', '/');
  const dot = normalized.lastIndexOf('.');
  const base = dot >= 0 ? normalized.slice(0, dot) : normalized;
  if (framework === 'PyTest') {
    const segments = base.split('/');
    const name = segments.pop() ?? 'module';
    return [...segments, `test_${name}.py`].join('/');
  }
  if (framework === 'GoTest' || language.toLowerCase() === 'go') return `${base}_test.go`;
  const extension = dot >= 0 ? normalized.slice(dot) : '.ts';
  return `${base}.test${extension}`;
}

function normalizeDialect(input: string, context: string): string {
  const aliases: Readonly<Record<string, string>> = {
    pg: 'PostgreSQL',
    postgres: 'PostgreSQL',
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mongodb: 'MongoDB',
    mongo: 'MongoDB',
    sqlite: 'SQLite',
    auto: '自动识别',
    '': '自动识别',
  };
  const explicit = aliases[input];
  if (explicit !== undefined && explicit !== '自动识别') return explicit;
  const normalized = context.toLowerCase();
  if (normalized.includes('postgres')) return 'PostgreSQL';
  if (normalized.includes('mysql')) return 'MySQL';
  if (normalized.includes('mongodb') || normalized.includes('mongoose')) return 'MongoDB';
  if (normalized.includes('sqlite')) return 'SQLite';
  if (explicit !== undefined) return explicit;
  throw new Error('dialect 仅支持 auto、mysql、postgresql、mongodb 或 sqlite');
}

function classifyDatabaseRisk(request: string): 'high' | 'low' | 'medium' {
  if (/\b(?:drop|truncate)\b|删除(?:库|表)|清空/iu.test(request)) return 'high';
  if (/\b(?:delete|update|alter|grant|revoke)\b|删除|更新|迁移|授权/iu.test(request)) {
    return 'medium';
  }
  return 'low';
}

function inferDatabaseOperation(request: string): string {
  const normalized = request.toLowerCase();
  if (/\bselect\b|查询|统计|检索/u.test(normalized)) return 'read';
  if (/\b(?:insert|update|delete)\b|新增|写入|更新|删除/u.test(normalized)) return 'write';
  if (/\b(?:create|alter|drop|truncate)\b|建表|迁移/u.test(normalized)) return 'schema';
  return 'unspecified';
}

function inferRuntime(content: string): string {
  const normalized = content.toLowerCase();
  if (/package\.json|node(?:\.js)?|pnpm|npm|yarn/u.test(normalized)) return 'Node.js';
  if (/pyproject\.toml|requirements\.txt|python|django|fastapi/u.test(normalized)) {
    return 'Python';
  }
  if (/go\.mod|golang|\bgo\s+1\.\d+/u.test(normalized)) return 'Go';
  if (/pom\.xml|gradle|spring boot|java/u.test(normalized)) return 'Java';
  if (/cargo\.toml|\brust\b/u.test(normalized)) return 'Rust';
  return '需从项目文件确认';
}

function extractPorts(content: string): number[] {
  const ports = new Set<number>();
  for (const match of content.matchAll(/\b(?:port|端口)\s*[:=]?\s*(\d{2,5})\b/giu)) {
    const value = Number(match[1]);
    if (value >= 1 && value <= 65_535) ports.add(value);
    if (ports.size >= 16) break;
  }
  return [...ports].sort((left, right) => left - right);
}

function detectRecursionCandidates(code: string): string[] {
  const candidates: string[] = [];
  for (const name of extractSymbols(code)) {
    const occurrences = countMatches(code, new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'gu'));
    if (occurrences > 1) candidates.push(name);
  }
  return candidates.slice(0, 20);
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function lineCount(value: string): number {
  return value.split(/\r?\n/u).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
