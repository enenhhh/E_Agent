import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentToolDefinitions,
  agentToolNames,
  executeAutomaticWorkspaceTool,
  isAutomaticWorkspaceTool,
  parseAgentToolInvocation,
  parseToolEnvelope,
  serializeToolEnvelope,
  type ToolEnvelopeStatus,
} from './agent-tool-registry.js';
import { WorkspaceService } from './workspace.js';

const directories: string[] = [];
const sessionId = '00000000-0000-4000-8000-000000000001';

async function createWorkspace(): Promise<{ root: string; workspace: WorkspaceService }> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-tool-registry-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  await Promise.all([
    mkdir(join(root, '.ssh'), { recursive: true }),
    mkdir(join(root, '.aws'), { recursive: true }),
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(root, 'node_modules', 'dependency'), { recursive: true }),
    mkdir(join(root, 'src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, '.ssh', 'id_rsa'), 'private key'),
    writeFile(join(root, '.aws', 'credentials'), 'aws_secret_access_key=value'),
    writeFile(join(root, '.env.local'), 'API_KEY=not-a-real-key'),
    writeFile(join(root, 'dist', 'generated.js'), 'generated'),
    writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'dependency'),
    writeFile(
      join(root, 'src', 'index.ts'),
      'export const safe = true;\nexport const count = 2;\n',
    ),
    writeFile(join(root, 'src', 'index.test.ts'), 'expect(true).toBe(true);\n'),
    writeFile(
      join(root, 'src', 'search-a.ts'),
      'const value = "Needle"; // token=not-a-real-secret-value\n',
    ),
    writeFile(join(root, 'src', 'search-b.ts'), 'const second = "needle";\n'),
    writeFile(join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 2, 3])),
    writeFile(join(root, 'src', 'control-heavy.dat'), '\u0001'.repeat(100)),
    writeFile(join(root, 'src', 'a-binary-needle.dat'), Buffer.from('needle\0binary', 'utf8')),
  ]);
  const workspace = new WorkspaceService({
    stateFile: join(directory, 'workspace-binding.json'),
  });
  await workspace.bind(root);
  return { root, workspace };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('parseAgentToolInvocation', () => {
  it('解析全部内置工具并应用各自的默认值与规范化', () => {
    const uppercaseHash = 'A'.repeat(64);
    const cases = [
      {
        name: 'workspace_read_file',
        raw: { path: 'src/index.ts' },
        expected: { path: 'src/index.ts', startLine: 1 },
      },
      {
        name: 'workspace_list_files',
        raw: {},
        expected: { path: '', depth: 2, maxEntries: 300 },
      },
      {
        name: 'workspace_find_files',
        raw: { query: 'index' },
        expected: { query: 'index', path: '', maxResults: 100 },
      },
      {
        name: 'workspace_search_text',
        raw: { query: 'export' },
        expected: {
          query: 'export',
          path: '',
          caseSensitive: false,
          maxResults: 100,
        },
      },
      {
        name: 'workspace_propose_write',
        raw: { path: 'src/new.ts', content: 'export {};\n', expectedHash: uppercaseHash },
        expected: {
          path: 'src/new.ts',
          content: 'export {};\n',
          expectedHash: uppercaseHash.toLowerCase(),
        },
      },
      {
        name: 'workspace_run_command',
        raw: { executable: 'pnpm' },
        expected: { executable: 'pnpm', args: [], cwd: '' },
      },
      {
        name: 'computer_system_info',
        raw: {},
        expected: {},
      },
      {
        name: 'computer_list_processes',
        raw: {},
        expected: { query: '', maxResults: 50 },
      },
      {
        name: 'browser_open',
        raw: { url: 'https://example.com/docs' },
        expected: { url: 'https://example.com/docs' },
      },
      {
        name: 'browser_navigate',
        raw: { sessionId, url: 'https://example.com/next' },
        expected: { sessionId, url: 'https://example.com/next' },
      },
      {
        name: 'browser_extract',
        raw: { sessionId },
        expected: { sessionId, format: 'text' },
      },
      {
        name: 'browser_screenshot',
        raw: { sessionId },
        expected: { sessionId, fullPage: false },
      },
    ] as const;

    expect(agentToolDefinitions).toHaveLength(agentToolNames.length);
    expect(new Set(agentToolDefinitions.map((tool) => tool.function.name))).toEqual(
      new Set(agentToolNames),
    );
    for (const testCase of cases) {
      expect(parseAgentToolInvocation(testCase.name, JSON.stringify(testCase.raw))).toEqual({
        name: testCase.name,
        input: testCase.expected,
      });
    }
  });

  it('拒绝未注册名称和无效 JSON，且不尝试执行参数', () => {
    expect(() => parseAgentToolInvocation('workspace_delete_file', '{}')).toThrow(
      expect.objectContaining({ code: 'TOOL_NOT_REGISTERED' }),
    );
    expect(() => parseAgentToolInvocation('workspace_read_file', '{"path":')).toThrow(
      expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }),
    );
  });

  it('拒绝每一种内置工具的无效 schema 参数', () => {
    const invalidCases = [
      ['workspace_read_file', { path: '../secret.txt' }],
      ['workspace_list_files', { depth: 5 }],
      ['workspace_find_files', { query: '' }],
      ['workspace_search_text', { query: 'needle', unexpected: true }],
      ['workspace_propose_write', { path: '', content: 'content' }],
      ['workspace_run_command', { executable: 'node /c' }],
      ['computer_system_info', { verbose: true }],
      ['computer_list_processes', { maxResults: 0 }],
      ['browser_open', { url: 'not a url' }],
      ['browser_navigate', { sessionId: 'not-a-uuid', url: 'https://example.com' }],
      ['browser_extract', { sessionId, format: 'markdown' }],
      ['browser_screenshot', { sessionId, fullPage: 'yes' }],
    ] as const;

    for (const [name, input] of invalidCases) {
      expect(() => parseAgentToolInvocation(name, JSON.stringify(input)), name).toThrow(
        expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }),
      );
    }
  });

  it('仅将四个只读工作区工具识别为自动执行工具', () => {
    const automaticNames = new Set([
      'workspace_find_files',
      'workspace_list_files',
      'workspace_read_file',
      'workspace_search_text',
    ]);

    for (const definition of agentToolDefinitions) {
      const name = definition.function.name;
      const raw =
        name === 'workspace_read_file'
          ? { path: 'src/index.ts' }
          : name === 'workspace_list_files'
            ? {}
            : name === 'workspace_find_files'
              ? { query: 'index' }
              : name === 'workspace_search_text'
                ? { query: 'export' }
                : name === 'workspace_propose_write'
                  ? { path: 'src/new.ts', content: 'new' }
                  : name === 'workspace_run_command'
                    ? { executable: 'pnpm' }
                    : name === 'computer_list_processes' || name === 'computer_system_info'
                      ? {}
                      : name === 'browser_open'
                        ? { url: 'https://example.com' }
                        : {
                            sessionId,
                            ...(name === 'browser_navigate' ? { url: 'https://example.com' } : {}),
                          };
      const invocation = parseAgentToolInvocation(name, JSON.stringify(raw));
      expect(isAutomaticWorkspaceTool(invocation), name).toBe(automaticNames.has(name));
    }
  });
});

describe('executeAutomaticWorkspaceTool', () => {
  it('按行读取普通文本，拒绝敏感凭据与二进制文件', async () => {
    const { workspace } = await createWorkspace();
    const rangeInvocation = parseAgentToolInvocation(
      'workspace_read_file',
      JSON.stringify({ path: 'src/index.ts', startLine: 2, endLine: 2 }),
    );
    if (rangeInvocation.name !== 'workspace_read_file') throw new Error('unexpected tool');
    await expect(
      executeAutomaticWorkspaceTool(workspace, rangeInvocation, 32_768),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'read-file',
        path: 'src/index.ts',
        content: 'export const count = 2;',
        startLine: 2,
        endLine: 2,
        truncated: true,
        redacted: false,
      }),
    );

    for (const path of ['.ssh/id_rsa', '.aws/credentials', '.env.local']) {
      const invocation = parseAgentToolInvocation('workspace_read_file', JSON.stringify({ path }));
      if (invocation.name !== 'workspace_read_file') throw new Error('unexpected tool');
      await expect(
        executeAutomaticWorkspaceTool(workspace, invocation, 32_768),
      ).rejects.toMatchObject({ code: 'SENSITIVE_FILE_DENIED' });
    }

    for (const path of ['src/binary.dat', 'src/control-heavy.dat']) {
      const binaryInvocation = parseAgentToolInvocation(
        'workspace_read_file',
        JSON.stringify({ path }),
      );
      if (binaryInvocation.name !== 'workspace_read_file') throw new Error('unexpected tool');
      await expect(
        executeAutomaticWorkspaceTool(workspace, binaryInvocation, 32_768),
      ).rejects.toMatchObject({ code: 'BINARY_FILE_DENIED' });
    }
  });

  it('脱敏读取结果，并按 UTF-8 字节而非字符数限制输出', async () => {
    const { root, workspace } = await createWorkspace();
    const secret = 'sk-testonly1234567890';
    await writeFile(join(root, 'src', 'redaction.txt'), `key=${secret}\n`);
    const redactionInvocation = parseAgentToolInvocation(
      'workspace_read_file',
      JSON.stringify({ path: 'src/redaction.txt' }),
    );
    if (redactionInvocation.name !== 'workspace_read_file') throw new Error('unexpected tool');
    const redacted = await executeAutomaticWorkspaceTool(workspace, redactionInvocation, 32_768);
    expect(redacted).toEqual(expect.objectContaining({ redacted: true }));
    expect(JSON.stringify(redacted)).not.toContain(secret);

    await writeFile(join(root, 'src', 'large.txt'), `${'界'.repeat(5_000)}\n`);
    const largeInvocation = parseAgentToolInvocation(
      'workspace_read_file',
      JSON.stringify({ path: 'src/large.txt' }),
    );
    if (largeInvocation.name !== 'workspace_read_file') throw new Error('unexpected tool');
    const limited = (await executeAutomaticWorkspaceTool(workspace, largeInvocation, 1)) as {
      content: string;
      truncated: boolean;
    };
    expect(limited.truncated).toBe(true);
    expect(Buffer.byteLength(limited.content, 'utf8')).toBeLessThanOrEqual(3_072);
  });

  it('列出文件时跳过生成目录，并同时遵守条目数和输出字节上限', async () => {
    const { root, workspace } = await createWorkspace();
    const invocation = parseAgentToolInvocation(
      'workspace_list_files',
      JSON.stringify({ path: '', depth: 4, maxEntries: 2 }),
    );
    if (invocation.name !== 'workspace_list_files') throw new Error('unexpected tool');
    const countLimited = (await executeAutomaticWorkspaceTool(workspace, invocation, 32_768)) as {
      entries: Array<{ path: string }>;
      truncated: boolean;
    };
    expect(countLimited.entries).toHaveLength(2);
    expect(countLimited.truncated).toBe(true);
    expect(countLimited.entries.map((entry) => entry.path)).not.toContain(
      expect.stringMatching(/(?:^|\/)(?:dist|node_modules)(?:\/|$)/u),
    );

    await Promise.all(
      Array.from({ length: 45 }, (_, index) =>
        writeFile(
          join(root, 'src', `long-${String(index).padStart(2, '0')}-${'x'.repeat(80)}.txt`),
          '',
        ),
      ),
    );
    const byteInvocation = parseAgentToolInvocation(
      'workspace_list_files',
      JSON.stringify({ path: 'src', depth: 1, maxEntries: 1_000 }),
    );
    if (byteInvocation.name !== 'workspace_list_files') throw new Error('unexpected tool');
    const byteLimited = (await executeAutomaticWorkspaceTool(workspace, byteInvocation, 1)) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(byteLimited.entries.length).toBeGreaterThan(0);
    expect(byteLimited.entries.length).toBeLessThan(45);
    expect(byteLimited.truncated).toBe(true);
  });

  it('按名称不区分大小写查找，隐藏敏感文件并报告结果截断', async () => {
    const { workspace } = await createWorkspace();
    const invocation = parseAgentToolInvocation(
      'workspace_find_files',
      JSON.stringify({ query: 'INDEX', path: '', maxResults: 1 }),
    );
    if (invocation.name !== 'workspace_find_files') throw new Error('unexpected tool');
    await expect(executeAutomaticWorkspaceTool(workspace, invocation, 32_768)).resolves.toEqual(
      expect.objectContaining({
        kind: 'file-find',
        matches: [expect.objectContaining({ path: 'src/index.test.ts' })],
        truncated: true,
      }),
    );

    const sensitiveInvocation = parseAgentToolInvocation(
      'workspace_find_files',
      JSON.stringify({ query: 'id_rsa', path: '' }),
    );
    if (sensitiveInvocation.name !== 'workspace_find_files') {
      throw new Error('unexpected tool');
    }
    const sensitive = (await executeAutomaticWorkspaceTool(
      workspace,
      sensitiveInvocation,
      32_768,
    )) as { matches: unknown[] };
    expect(sensitive.matches).toEqual([]);
  });

  it('搜索文本时跳过二进制与敏感文件，脱敏预览并遵守大小限制', async () => {
    const { root, workspace } = await createWorkspace();
    const secret = 'not-a-real-secret-value';
    const invocation = parseAgentToolInvocation(
      'workspace_search_text',
      JSON.stringify({ query: 'needle', path: 'src', maxResults: 1 }),
    );
    if (invocation.name !== 'workspace_search_text') throw new Error('unexpected tool');
    const result = (await executeAutomaticWorkspaceTool(workspace, invocation, 32_768)) as {
      matches: Array<{ preview: string }>;
      scannedFiles: number;
      truncated: boolean;
    };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.preview).toContain('[REDACTED]');
    expect(result.matches[0]?.preview).not.toContain(secret);
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);

    const caseSensitiveInvocation = parseAgentToolInvocation(
      'workspace_search_text',
      JSON.stringify({ query: 'NEEDLE', path: 'src', caseSensitive: true }),
    );
    if (caseSensitiveInvocation.name !== 'workspace_search_text') {
      throw new Error('unexpected tool');
    }
    const caseSensitive = (await executeAutomaticWorkspaceTool(
      workspace,
      caseSensitiveInvocation,
      32_768,
    )) as { matches: unknown[] };
    expect(caseSensitive.matches).toEqual([]);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(
          join(root, 'src', `bulk-${String(index).padStart(2, '0')}.txt`),
          `bulk ${'x'.repeat(350)}\n`,
        ),
      ),
    );
    const byteInvocation = parseAgentToolInvocation(
      'workspace_search_text',
      JSON.stringify({ query: 'bulk', path: 'src', maxResults: 100 }),
    );
    if (byteInvocation.name !== 'workspace_search_text') throw new Error('unexpected tool');
    const byteLimited = (await executeAutomaticWorkspaceTool(workspace, byteInvocation, 1)) as {
      matches: unknown[];
      truncated: boolean;
    };
    expect(byteLimited.matches.length).toBeGreaterThan(0);
    expect(byteLimited.matches.length).toBeLessThan(20);
    expect(byteLimited.truncated).toBe(true);
  }, 15_000);
});

describe('tool result envelope', () => {
  it('序列化并解析完整信封，同时保留权限、时间和 JSON 结果', () => {
    const envelope = {
      schemaVersion: 1 as const,
      toolCallId: 'permission-call',
      toolName: 'browser_extract',
      modelId: sessionId,
      continuationStateId: '00000000-0000-4000-8000-000000000002',
      status: 'completed' as const,
      bindingId: sessionId,
      input: { selector: 'main' },
      result: { kind: 'browser-extract', content: 'safe' },
      startedAt: '2026-07-29T08:00:00.000Z',
      finishedAt: '2026-07-29T08:00:01.250Z',
      durationMs: 1_250,
      permission: {
        capability: 'browser.network.public-read.best-effort' as const,
        risk: 'high' as const,
        approval: 'required' as const,
        scope: 'conversation:test',
        workspaceBound: false,
        networkAccess: 'public-read' as const,
        sideEffect: 'browser-session' as const,
        timeoutMs: 10_000,
        outputLimitBytes: 32_768,
      },
    };

    const serialized = serializeToolEnvelope(envelope);
    expect(parseToolEnvelope(serialized)).toEqual(envelope);
  });

  it('接受全部状态并拒绝损坏 JSON、越界字段、额外字段和非法日期', () => {
    const statuses: ToolEnvelopeStatus[] = [
      'approval-required',
      'cancelled',
      'completed',
      'failed',
      'rejected',
      'running',
      'timed-out',
    ];
    for (const status of statuses) {
      const content = serializeToolEnvelope({
        schemaVersion: 1,
        toolCallId: `call-${status}`,
        toolName: 'workspace_read_file',
        status,
        bindingId: null,
      });
      expect(parseToolEnvelope(content)?.status).toBe(status);
    }
    expect(
      parseToolEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          toolCallId: 'legacy-call',
          toolName: 'workspace_read_file',
          status: 'completed',
          bindingId: null,
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      toolCallId: 'legacy-call',
      toolName: 'workspace_read_file',
      status: 'completed',
      bindingId: null,
    });

    expect(parseToolEnvelope('{')).toBeUndefined();
    expect(parseToolEnvelope('null')).toBeUndefined();
    expect(
      parseToolEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          toolCallId: 'call',
          toolName: 'x'.repeat(129),
          status: 'completed',
          bindingId: null,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseToolEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          toolCallId: 'call',
          toolName: 'tool',
          modelId: 'remote-model-name-is-not-an-internal-id',
          status: 'completed',
          bindingId: null,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseToolEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          toolCallId: 'call',
          toolName: 'tool',
          status: 'completed',
          bindingId: null,
          finishedAt: 'not-a-date',
        }),
      ),
    ).toBeUndefined();
    expect(
      parseToolEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          toolCallId: 'call',
          toolName: 'tool',
          status: 'completed',
          bindingId: null,
          unexpected: true,
        }),
      ),
    ).toBeUndefined();
  });

  it('在序列化入口拒绝不合法信封，而不是持久化部分数据', () => {
    expect(() =>
      serializeToolEnvelope({
        schemaVersion: 1,
        toolCallId: '',
        toolName: 'workspace_read_file',
        status: 'completed',
        bindingId: null,
      }),
    ).toThrow();
    expect(() =>
      serializeToolEnvelope({
        schemaVersion: 1,
        toolCallId: 'call',
        toolName: 'workspace_read_file',
        status: 'failed',
        bindingId: null,
        error: {
          code: 'FAILED',
          message: 'x'.repeat(2_001),
        },
      }),
    ).toThrow();
  });
});
