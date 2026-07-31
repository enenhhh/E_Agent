import type { ChatTool } from '@e-agent/contracts';
import { redactText } from '@e-agent/security';
import { z } from 'zod';

import {
  browserExtractArgumentsSchema,
  browserNavigateArgumentsSchema,
  browserOpenArgumentsSchema,
  browserScreenshotArgumentsSchema,
  type BrowserToolArguments,
} from './browser-tool-service.js';
import {
  workspaceCommandArgumentsSchema,
  type WorkspaceCommandArguments,
} from './command-runner.js';
import { DesktopError } from './errors.js';
import { processListArgumentsSchema, type ProcessListArguments } from './process-inspector.js';
import { toolPermissionMetadataSchema } from './tool-permissions.js';
import type { WorkspaceService, WorkspaceTreeEntry } from './workspace.js';

const maximumWorkspaceToolBytes = 750_000;
const ignoredGeneratedDirectories = [
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'release',
] as const;
const relativePathSchema = z
  .string()
  .max(1_024)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value) &&
      !value.replaceAll('\\', '/').split('/').includes('..'),
    '必须使用工作区内的相对路径',
  );
const requiredRelativePathSchema = relativePathSchema.pipe(z.string().min(1));

const readFileArgumentsSchema = z
  .object({
    path: requiredRelativePathSchema,
    startLine: z.number().int().positive().default(1),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.endLine === undefined ||
      (value.endLine >= value.startLine && value.endLine - value.startLine <= 2_000),
    '读取行范围无效或超过 2,001 行',
  );
const listFilesArgumentsSchema = z
  .object({
    path: relativePathSchema.default(''),
    depth: z.number().int().min(0).max(4).default(2),
    maxEntries: z.number().int().min(1).max(1_000).default(300),
  })
  .strict();
const searchTextArgumentsSchema = z
  .object({
    query: z.string().min(1).max(512),
    path: relativePathSchema.default(''),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(200).default(100),
  })
  .strict();
const findFilesArgumentsSchema = z
  .object({
    query: z.string().min(1).max(256),
    path: relativePathSchema.default(''),
    maxResults: z.number().int().min(1).max(500).default(100),
  })
  .strict();
const proposeWriteArgumentsSchema = z
  .object({
    path: requiredRelativePathSchema,
    content: z.string().max(maximumWorkspaceToolBytes),
    expectedHash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/u)
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict();

export const agentToolNames = [
  'workspace_read_file',
  'workspace_list_files',
  'workspace_find_files',
  'workspace_search_text',
  'workspace_propose_write',
  'workspace_run_command',
  'computer_system_info',
  'computer_list_processes',
  'browser_open',
  'browser_navigate',
  'browser_extract',
  'browser_screenshot',
] as const;
export type AgentToolName = (typeof agentToolNames)[number];

const toolEnvelopeStatusSchema = z.enum([
  'approval-required',
  'cancelled',
  'completed',
  'failed',
  'rejected',
  'running',
  'timed-out',
]);
export type ToolEnvelopeStatus = z.infer<typeof toolEnvelopeStatusSchema>;

export const toolResultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: z.string().min(1).max(256),
    toolName: z.string().min(1).max(128),
    modelId: z.string().uuid().optional(),
    continuationStateId: z.string().uuid().optional(),
    status: toolEnvelopeStatusSchema,
    bindingId: z.string().uuid().nullable(),
    input: z.json().optional(),
    result: z.json().optional(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    finishedAt: z.string().datetime({ offset: true }).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    permission: toolPermissionMetadataSchema.optional(),
  })
  .strict();

export type ToolResultEnvelope = z.infer<typeof toolResultEnvelopeSchema>;

export type ParsedAgentToolInvocation =
  | BrowserToolArguments
  | { name: 'computer_list_processes'; input: ProcessListArguments }
  | { name: 'computer_system_info'; input: Record<string, never> }
  | { name: 'workspace_find_files'; input: z.infer<typeof findFilesArgumentsSchema> }
  | { name: 'workspace_list_files'; input: z.infer<typeof listFilesArgumentsSchema> }
  | { name: 'workspace_propose_write'; input: z.infer<typeof proposeWriteArgumentsSchema> }
  | { name: 'workspace_read_file'; input: z.infer<typeof readFileArgumentsSchema> }
  | { name: 'workspace_run_command'; input: WorkspaceCommandArguments }
  | { name: 'workspace_search_text'; input: z.infer<typeof searchTextArgumentsSchema> };

export const agentToolDefinitions: readonly ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'workspace_read_file',
      description:
        '读取当前工作区内的 UTF-8 文本文件，可指定行范围。禁止绝对路径、路径逃逸和敏感凭据文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', maxLength: 1_024, description: '工作区相对路径' },
          startLine: { type: 'integer', minimum: 1, description: '可选，起始行（从 1 开始）' },
          endLine: { type: 'integer', minimum: 1, description: '可选，结束行（包含）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_find_files',
      description:
        '按文件名在当前工作区内递归查找文件和目录。只返回相对路径，跳过依赖、构建产物和敏感凭据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: '文件名或路径片段，不是正则表达式',
          },
          path: { type: 'string', maxLength: 1_024, description: '工作区相对目录' },
          maxResults: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_list_files',
      description: '列出当前工作区内的文件和目录，结果有深度与条目上限。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', maxLength: 1_024, description: '工作区相对目录，默认根目录' },
          depth: { type: 'integer', minimum: 0, maximum: 4, description: '递归深度' },
          maxEntries: { type: 'integer', minimum: 1, maximum: 1_000 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_search_text',
      description:
        '在当前工作区的普通文本文件中执行受限的字面量搜索，跳过敏感文件、二进制文件和大型目录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 512 },
          path: { type: 'string', maxLength: 1_024, description: '工作区相对目录' },
          caseSensitive: { type: 'boolean' },
          maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_propose_write',
      description:
        '创建工作区文件修改提案。调用只生成 Diff，必须由用户批准后才会写盘；修改已有文件时应提供最近读取的 SHA-256。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', maxLength: 1_024, description: '工作区相对路径' },
          content: {
            type: 'string',
            maxLength: maximumWorkspaceToolBytes,
            description: '目标文件完整 UTF-8 内容',
          },
          expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_run_command',
      description:
        '申请在当前工作区运行结构化安全命令。模型调用只创建待批准请求，用户确认后才会执行；不支持 shell 字符串。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['executable'],
        properties: {
          executable: {
            type: 'string',
            maxLength: 128,
            pattern: '^[A-Za-z0-9._-]+$',
          },
          args: {
            type: 'array',
            maxItems: 64,
            items: { type: 'string', maxLength: 4_096 },
          },
          cwd: { type: 'string', maxLength: 1_024, description: '工作区相对目录' },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: 300_000 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_system_info',
      description:
        '读取不具识别性的本机系统概况：操作系统、CPU、内存和运行时版本；不返回用户名、主机名或环境变量。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_list_processes',
      description:
        '请求检查本机进程名称、PID、CPU 与内存统计。不会读取命令行、进程所有者或环境变量，执行前需要用户批准。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 128, description: '可选的进程名称过滤词' },
          maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description:
        '经逐次审批后，在隔离、无持久 Cookie 的会话中执行 best-effort public-only HTTP(S) 导航。DNS 预检不是严格 SSRF 隔离。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2_048 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        '经逐次审批完整 URL 后，让当前对话的隔离会话执行 best-effort public-only HTTP(S) 导航；DNS 预检不是严格 SSRF 隔离。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'url'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri', maxLength: 2_048 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description:
        '经审批后从当前对话的隔离浏览器页面提取可见文本或受限 HTML。可选 CSS 选择器，输出会脱敏和截断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          selector: { type: 'string', minLength: 1, maxLength: 512 },
          format: { type: 'string', enum: ['text', 'html'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        '经审批后截取当前对话的隔离浏览器页面，返回受工具输出上限约束的 JPEG；不写入文件系统。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          fullPage: { type: 'boolean' },
        },
      },
    },
  },
];

export function parseAgentToolInvocation(
  name: string,
  rawArguments: string,
): ParsedAgentToolInvocation {
  if (!agentToolNames.includes(name as AgentToolName)) {
    throw new DesktopError('TOOL_NOT_REGISTERED', '模型请求了未注册的工具，未执行任何操作。');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new DesktopError('TOOL_ARGUMENTS_INVALID', '工具参数不是有效的 JSON，未执行任何操作。');
  }
  try {
    switch (name) {
      case 'workspace_read_file':
        return { name, input: readFileArgumentsSchema.parse(decoded) };
      case 'workspace_list_files':
        return { name, input: listFilesArgumentsSchema.parse(decoded) };
      case 'workspace_find_files':
        return { name, input: findFilesArgumentsSchema.parse(decoded) };
      case 'workspace_search_text':
        return { name, input: searchTextArgumentsSchema.parse(decoded) };
      case 'workspace_propose_write':
        return { name, input: proposeWriteArgumentsSchema.parse(decoded) };
      case 'workspace_run_command':
        return { name, input: workspaceCommandArgumentsSchema.parse(decoded) };
      case 'computer_system_info':
        return {
          name,
          input: z.object({}).strict().parse(decoded) as Record<string, never>,
        };
      case 'computer_list_processes':
        return { name, input: processListArgumentsSchema.parse(decoded) };
      case 'browser_open':
        return { name, input: browserOpenArgumentsSchema.parse(decoded) };
      case 'browser_navigate':
        return { name, input: browserNavigateArgumentsSchema.parse(decoded) };
      case 'browser_extract':
        return { name, input: browserExtractArgumentsSchema.parse(decoded) };
      case 'browser_screenshot':
        return { name, input: browserScreenshotArgumentsSchema.parse(decoded) };
      default:
        throw new DesktopError('TOOL_NOT_REGISTERED', '模型请求了未注册的工具，未执行任何操作。');
    }
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('TOOL_ARGUMENTS_INVALID', '工具参数不符合要求，未执行任何操作。');
  }
}

export function serializeToolEnvelope(envelope: ToolResultEnvelope): string {
  return JSON.stringify(toolResultEnvelopeSchema.parse(envelope));
}

export function parseToolEnvelope(content: string): ToolResultEnvelope | undefined {
  try {
    const parsed = toolResultEnvelopeSchema.safeParse(JSON.parse(content) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function isAutomaticWorkspaceTool(
  invocation: ParsedAgentToolInvocation,
): invocation is Extract<
  ParsedAgentToolInvocation,
  {
    name:
      | 'workspace_find_files'
      | 'workspace_list_files'
      | 'workspace_read_file'
      | 'workspace_search_text';
  }
> {
  return (
    [
      'workspace_list_files',
      'workspace_read_file',
      'workspace_find_files',
      'workspace_search_text',
    ] as readonly AgentToolName[]
  ).includes(invocation.name);
}

export async function executeAutomaticWorkspaceTool(
  workspace: WorkspaceService,
  invocation: Extract<
    ParsedAgentToolInvocation,
    {
      name:
        | 'workspace_find_files'
        | 'workspace_list_files'
        | 'workspace_read_file'
        | 'workspace_search_text';
    }
  >,
  outputLimitBytes: number,
): Promise<unknown> {
  const safeLimit = Math.max(4_096, Math.min(outputLimitBytes, 1_048_576));
  if (invocation.name === 'workspace_read_file') {
    assertNonSensitivePath(invocation.input.path);
    const file = await workspace.read(
      invocation.input.path,
      Math.min(2_000_000, Math.max(262_144, safeLimit * 4)),
    );
    assertTextContent(file.content);
    const lines = file.content.replace(/\r\n?/gu, '\n').split('\n');
    const startIndex = invocation.input.startLine - 1;
    const endIndex =
      invocation.input.endLine === undefined
        ? lines.length
        : Math.min(lines.length, invocation.input.endLine);
    const selected = lines.slice(startIndex, endIndex).join('\n');
    const bounded = limitUtf8(selected, Math.max(1_024, safeLimit - 1_024));
    const redacted = redactText(bounded.value);
    return {
      kind: 'read-file',
      path: file.path,
      content: redacted,
      size: file.size,
      hash: file.hash,
      modifiedAt: file.modifiedAt,
      startLine: invocation.input.startLine,
      endLine: Math.max(invocation.input.startLine, startIndex + bounded.value.split('\n').length),
      truncated: bounded.truncated || endIndex < lines.length,
      redacted: redacted !== bounded.value,
    };
  }
  if (invocation.name === 'workspace_list_files') {
    const tree = await workspace.list(invocation.input.path, invocation.input.depth, {
      ignoreDirectories: ignoredGeneratedDirectories,
    });
    const allEntries = flattenTree(tree);
    const flattened = allEntries.slice(0, invocation.input.maxEntries);
    const entries = fitEntriesToLimit(flattened, safeLimit);
    return {
      kind: 'file-list',
      path: invocation.input.path,
      entries,
      truncated: flattened.length < allEntries.length || entries.length < flattened.length,
    };
  }

  if (invocation.name === 'workspace_find_files') {
    const tree = await workspace.list(invocation.input.path, 8, {
      ignoreDirectories: ignoredGeneratedDirectories,
    });
    const query = invocation.input.query.toLocaleLowerCase();
    const allMatches = flattenTree(tree).filter(
      (entry) =>
        !isSensitivePath(entry.path) &&
        (entry.name.toLocaleLowerCase().includes(query) ||
          entry.path.toLocaleLowerCase().includes(query)),
    );
    const limited = allMatches.slice(0, invocation.input.maxResults);
    const matches = fitEntriesToLimit(limited, safeLimit);
    return {
      kind: 'file-find',
      path: invocation.input.path,
      query: invocation.input.query,
      matches,
      truncated: matches.length < allMatches.length,
    };
  }

  const tree = await workspace.list(invocation.input.path, 8, {
    ignoreDirectories: ignoredGeneratedDirectories,
  });
  const files = flattenTree(tree)
    .filter((entry) => entry.type === 'file' && !isSensitivePath(entry.path))
    .slice(0, 1_000);
  const query = invocation.input.caseSensitive
    ? invocation.input.query
    : invocation.input.query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  for (const entry of files) {
    if (matches.length >= invocation.input.maxResults || scannedBytes >= 8_000_000) break;
    try {
      const file = await workspace.read(entry.path, 512_000);
      assertTextContent(file.content);
      scannedBytes += file.size;
      scannedFiles += 1;
      const lines = file.content.replace(/\r\n?/gu, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const comparable = invocation.input.caseSensitive ? line : line.toLocaleLowerCase();
        const column = comparable.indexOf(query);
        if (column < 0) continue;
        matches.push({
          path: file.path,
          line: index + 1,
          column: column + 1,
          preview: redactText(line.slice(Math.max(0, column - 120), column + query.length + 240)),
        });
        if (matches.length >= invocation.input.maxResults) break;
      }
    } catch {
      // 搜索遇到二进制、过大或瞬时变化文件时跳过，保持整个工具结果可用。
    }
  }
  const boundedMatches = fitEntriesToLimit(matches, safeLimit);
  return {
    kind: 'search-results',
    query: invocation.input.query,
    path: invocation.input.path,
    matches: boundedMatches,
    scannedFiles,
    scannedBytes,
    truncated:
      boundedMatches.length < matches.length ||
      matches.length >= invocation.input.maxResults ||
      scannedBytes >= 8_000_000,
  };
}

function flattenTree(
  entries: readonly WorkspaceTreeEntry[],
): Array<{ path: string; name: string; type: 'directory' | 'file'; size?: number }> {
  const result: Array<{
    path: string;
    name: string;
    type: 'directory' | 'file';
    size?: number;
  }> = [];
  for (const entry of entries) {
    result.push({
      path: entry.path,
      name: entry.name,
      type: entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    });
    if (entry.children !== undefined) result.push(...flattenTree(entry.children));
  }
  return result;
}

function fitEntriesToLimit<T>(entries: readonly T[], maximumBytes: number): T[] {
  const result: T[] = [];
  let usedBytes = 2;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (usedBytes + entryBytes + (result.length === 0 ? 0 : 1) > maximumBytes - 512) break;
    result.push(entry);
    usedBytes += entryBytes + (result.length === 1 ? 0 : 1);
  }
  return result;
}

function limitUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

function assertNonSensitivePath(path: string): void {
  if (isSensitivePath(path)) {
    throw new DesktopError('SENSITIVE_FILE_DENIED', '敏感凭据文件不能由模型工具自动读取');
  }
}

function assertTextContent(content: string): void {
  if (content.includes('\0')) {
    throw new DesktopError('BINARY_FILE_DENIED', '二进制文件不能由文本工具读取');
  }
  const sample = content.slice(0, 8_192);
  const suspiciousControls = [...sample].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
  }).length;
  if (sample.length > 0 && suspiciousControls / sample.length > 0.02) {
    throw new DesktopError('BINARY_FILE_DENIED', '文件不像普通 UTF-8 文本，已跳过读取');
  }
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? '';
  return (
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === 'credentials' ||
    name === 'credentials.json' ||
    name === 'id_rsa' ||
    name === 'id_ed25519' ||
    name.startsWith('.env') ||
    /\.(?:key|p12|pfx|pem)$/u.test(name) ||
    normalized.startsWith('.ssh/') ||
    normalized.includes('/.ssh/') ||
    normalized === '.aws/credentials' ||
    normalized.endsWith('/.aws/credentials') ||
    normalized === '.kube/config' ||
    normalized.endsWith('/.kube/config') ||
    normalized === '.docker/config.json' ||
    normalized.endsWith('/.docker/config.json') ||
    normalized.startsWith('.config/gcloud/') ||
    normalized.includes('/.config/gcloud/')
  );
}
