export type ReviewSeverity = 'critical' | 'high' | 'low' | 'medium';

export interface StaticReviewIssue {
  ruleId: string;
  severity: ReviewSeverity;
  title: string;
  message: string;
  line: number;
  column: number;
  evidence: string;
  suggestion: string;
  cwe?: string;
}

export interface StaticReviewResult {
  issues: readonly StaticReviewIssue[];
  scannedLines: number;
  changedLines: number;
  riskScore: number;
  counts: Readonly<Record<ReviewSeverity, number>>;
}

interface Rule {
  id: string;
  severity: ReviewSeverity;
  title: string;
  pattern: RegExp;
  message: string;
  suggestion: string;
  cwe?: string;
  redactEvidence?: boolean;
  languages?: readonly string[];
}

const rules: readonly Rule[] = [
  {
    id: 'security.hardcoded-secret',
    severity: 'critical',
    title: '疑似硬编码密钥',
    pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"`][A-Za-z0-9_./+=-]{16,}['"`]/i,
    message: '源码中出现高熵凭据，提交后可能导致账户或数据泄漏。',
    suggestion: '立即轮换该凭据，并改从加密密钥库或运行时环境变量读取。',
    cwe: 'CWE-798',
    redactEvidence: true,
  },
  {
    id: 'security.private-key',
    severity: 'critical',
    title: '私钥内容进入源码',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    message: '源码包含私钥头，私钥一旦进入版本历史即应视为泄漏。',
    suggestion: '删除并轮换私钥，使用密钥管理服务注入。',
    cwe: 'CWE-321',
    redactEvidence: true,
  },
  {
    id: 'security.dynamic-eval',
    severity: 'high',
    title: '动态代码执行',
    pattern: /\b(?:eval|new\s+Function)\s*\(/,
    message: '动态执行字符串会扩大代码注入面，并绕过静态检查。',
    suggestion: '改用结构化解析器或明确的操作映射表。',
    cwe: 'CWE-95',
    languages: ['javascript', 'typescript', 'js', 'ts', 'tsx', 'jsx'],
  },
  {
    id: 'security.shell-injection',
    severity: 'high',
    title: '潜在命令注入',
    pattern: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[^)]*\+|[^)]*\binput\b)/,
    message: '将动态输入拼接进 shell 命令可能允许执行任意命令。',
    suggestion: '使用参数数组和 shell:false 的进程 API，并校验每个参数。',
    cwe: 'CWE-78',
  },
  {
    id: 'security.sql-interpolation',
    severity: 'high',
    title: '潜在 SQL 注入',
    pattern:
      /\b(?:query|execute)\s*\(\s*(?:`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{|[^)]*(?:SELECT|INSERT|UPDATE|DELETE)[^)]*\+)/i,
    message: '动态值直接进入 SQL 文本，攻击者可能改变查询语义。',
    suggestion: '使用参数化查询或 ORM 参数绑定。',
    cwe: 'CWE-89',
  },
  {
    id: 'security.tls-disabled',
    severity: 'high',
    title: 'TLS 证书校验被禁用',
    pattern: /rejectUnauthorized\s*:\s*false/,
    message: '禁用证书校验会使请求暴露于中间人攻击。',
    suggestion: '恢复证书校验；开发证书应使用受控 CA 配置。',
    cwe: 'CWE-295',
  },
  {
    id: 'security.unsafe-html',
    severity: 'medium',
    title: '未经说明的原始 HTML 注入',
    pattern: /\b(?:innerHTML\s*=|dangerouslySetInnerHTML\s*=)/,
    message: '原始 HTML 若包含外部输入会导致跨站脚本执行。',
    suggestion: '优先使用文本节点；确需 HTML 时使用可信消毒器并限定来源。',
    cwe: 'CWE-79',
  },
  {
    id: 'security.weak-hash',
    severity: 'medium',
    title: '使用弱哈希算法',
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i,
    message: 'MD5/SHA-1 不适用于安全完整性或密码用途。',
    suggestion: '完整性使用 SHA-256 以上算法，密码使用 Argon2id/scrypt。',
    cwe: 'CWE-328',
  },
  {
    id: 'reliability.empty-catch',
    severity: 'medium',
    title: '异常被静默吞掉',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    message: '空 catch 会隐藏失败并让状态看似成功。',
    suggestion: '记录去敏后的上下文，恢复状态或将错误传播给调用方。',
  },
  {
    id: 'reliability.floating-promise',
    severity: 'medium',
    title: '疑似未等待异步操作',
    pattern:
      /^\s*(?!await\b|return\b|void\b)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^;]*\)\s*;\s*$/,
    message: '独立调用可能返回 Promise，其拒绝将绕过当前错误处理。',
    suggestion: '使用 await/return，或用 void 明确后台任务并附加错误处理。',
    languages: ['javascript', 'typescript', 'js', 'ts', 'tsx', 'jsx'],
  },
  {
    id: 'maintainability.explicit-any',
    severity: 'low',
    title: '显式 any 削弱类型契约',
    pattern: /:\s*any\b|<any>/,
    message: 'any 会让输入边界和重构错误逃过编译期检查。',
    suggestion: '使用 unknown 并在边界处校验，或定义精确接口。',
    languages: ['typescript', 'ts', 'tsx'],
  },
];

/**
 * 对完整代码或 unified diff 的新增行执行确定性静态扫描。
 */
export function scanCode(
  source: string,
  options: { language?: string; diff?: boolean } = {},
): StaticReviewResult {
  const language = options.language?.toLowerCase();
  const candidates = options.diff === true ? extractAddedLines(source) : allLines(source);
  const issues: StaticReviewIssue[] = [];
  const deduplication = new Set<string>();

  for (const candidate of candidates) {
    for (const rule of rules) {
      if (
        language !== undefined &&
        rule.languages !== undefined &&
        !rule.languages.includes(language)
      ) {
        continue;
      }
      const match = candidate.text.match(rule.pattern);
      if (match === null) {
        continue;
      }
      const key = `${rule.id}:${candidate.line}`;
      if (deduplication.has(key)) {
        continue;
      }
      deduplication.add(key);
      const rawEvidence = candidate.text.trim().slice(0, 240);
      issues.push({
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        message: rule.message,
        line: candidate.line,
        column: Math.max(1, (match.index ?? 0) + 1),
        evidence: rule.redactEvidence ? '[敏感内容已隐藏]' : rawEvidence,
        suggestion: rule.suggestion,
        ...(rule.cwe === undefined ? {} : { cwe: rule.cwe }),
      });
    }
  }

  issues.push(...detectComplexFunctions(candidates));
  issues.sort(
    (left, right) =>
      severityWeight(right.severity) - severityWeight(left.severity) ||
      left.line - right.line ||
      left.ruleId.localeCompare(right.ruleId),
  );

  const counts: Record<ReviewSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const issue of issues) {
    counts[issue.severity] += 1;
  }
  const rawScore = issues.reduce((sum, issue) => sum + severityWeight(issue.severity), 0);
  return {
    issues,
    scannedLines: source.split(/\r?\n/).length,
    changedLines: candidates.length,
    riskScore: Math.min(100, rawScore),
    counts,
  };
}

interface SourceLine {
  line: number;
  text: string;
}

function allLines(source: string): readonly SourceLine[] {
  return source.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text,
  }));
}

function extractAddedLines(diff: string): readonly SourceLine[] {
  const result: SourceLine[] = [];
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header !== null) {
      newLine = Number(header[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      result.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (!line.startsWith('-')) {
      newLine += 1;
    }
  }
  return result;
}

function detectComplexFunctions(lines: readonly SourceLine[]): readonly StaticReviewIssue[] {
  const issues: StaticReviewIssue[] = [];
  let startLine = 0;
  let braceDepth = 0;
  let branchCount = 0;
  let lineCount = 0;
  let inFunction = false;
  for (const candidate of lines) {
    if (
      !inFunction &&
      /(?:\bfunction\b|=>\s*\{|^\s*(?:public |private |protected )?(?:async )?[A-Za-z_$][\w$]*\([^)]*\)\s*\{)/.test(
        candidate.text,
      )
    ) {
      inFunction = true;
      startLine = candidate.line;
      braceDepth = 0;
      branchCount = 1;
      lineCount = 0;
    }
    if (!inFunction) {
      continue;
    }
    lineCount += 1;
    braceDepth += count(candidate.text, '{') - count(candidate.text, '}');
    branchCount += (candidate.text.match(/\b(?:if|for|while|case|catch)\b|&&|\|\||\?/g) ?? [])
      .length;
    if (braceDepth <= 0 && lineCount > 1) {
      if (branchCount > 15 || lineCount > 120) {
        issues.push({
          ruleId: 'maintainability.complex-function',
          severity: 'medium',
          title: '函数复杂度过高',
          message: `该函数约 ${lineCount} 行、圈复杂度估计 ${branchCount}，失败路径难以验证。`,
          line: startLine,
          column: 1,
          evidence: `函数从第 ${startLine} 行开始`,
          suggestion: '按职责拆分纯函数，并为每个分支补充边界测试。',
        });
      }
      inFunction = false;
    }
  }
  return issues;
}

function count(value: string, character: string): number {
  return [...value].filter((entry) => entry === character).length;
}

function severityWeight(severity: ReviewSeverity): number {
  return { critical: 25, high: 15, medium: 7, low: 2 }[severity];
}
