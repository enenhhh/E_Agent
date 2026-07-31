import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { DesktopError } from './errors.js';

export interface WorkspaceBinding {
  bindingId: string;
  root: string;
  name: string;
}

export interface WorkspaceTreeEntry {
  path: string;
  name: string;
  type: 'directory' | 'file';
  size?: number;
  children?: readonly WorkspaceTreeEntry[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
  hash: string;
  modifiedAt: string;
}

export interface ProposalChange {
  id: string;
  type: 'add' | 'delete';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface WorkspaceProposal {
  id: string;
  bindingId: string;
  path: string;
  createdAt: string;
  expiresAt: string;
  status: 'applied' | 'expired' | 'pending' | 'rejected';
  beforeHash: string;
  afterHash: string;
  diff: string;
  changes: readonly ProposalChange[];
}

interface LineOperation {
  type: 'add' | 'delete' | 'equal';
  content: string;
  changeId?: string;
  oldLine?: number;
  newLine?: number;
}

interface InternalProposal extends WorkspaceProposal {
  operations: readonly LineOperation[];
  beforeFinalNewline: boolean;
  finalNewline: boolean;
  lineEnding: '\n' | '\r\n';
  newlineChangeId?: string;
}

export interface WorkspaceServiceOptions {
  stateFile: string;
  maximumReadBytes?: number;
  proposalLifetimeMs?: number;
  onChanged?: (path: string) => void;
  cleanupFile?: (path: string) => Promise<void>;
}

/**
 * 约束所有文件操作位于用户绑定的工作区内，并通过变更提案执行写入。
 */
export class WorkspaceService {
  private binding: WorkspaceBinding | undefined;
  private readonly proposals = new Map<string, InternalProposal>();
  private readonly maximumReadBytes: number;
  private readonly proposalLifetimeMs: number;

  public constructor(private readonly options: WorkspaceServiceOptions) {
    this.maximumReadBytes = options.maximumReadBytes ?? 5_000_000;
    this.proposalLifetimeMs = options.proposalLifetimeMs ?? 30 * 60 * 1_000;
  }

  /**
   * 从磁盘恢复上次绑定；目录失效时安全地返回未绑定状态。
   */
  public async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as {
        version?: unknown;
        bindingId?: unknown;
        root?: unknown;
      };
      if (typeof parsed.root === 'string') {
        await this.restoreBinding(
          parsed.root,
          parsed.version === 2 &&
            typeof parsed.bindingId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              parsed.bindingId,
            )
            ? parsed.bindingId
            : randomUUID(),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.binding = undefined;
      }
    }
  }

  /**
   * 绑定并持久化一个真实存在的普通目录。
   */
  public async bind(root: string): Promise<WorkspaceBinding> {
    const canonicalRoot = await realpath(resolve(root));
    const metadata = await stat(canonicalRoot);
    if (!metadata.isDirectory()) {
      throw new DesktopError('WORKSPACE_INVALID', '所选路径不是文件夹');
    }
    const previous = this.binding;
    this.binding = {
      bindingId:
        previous !== undefined && previous.root === canonicalRoot
          ? previous.bindingId
          : randomUUID(),
      root: canonicalRoot,
      name: basename(canonicalRoot),
    };
    await this.persistBinding(this.binding);
    if (previous?.bindingId !== this.binding.bindingId) {
      this.proposals.clear();
    }
    return this.binding;
  }

  /**
   * 返回当前工作区绑定。
   */
  public getBinding(): WorkspaceBinding | undefined {
    return this.binding;
  }

  /**
   * 校验一个持久化操作仍属于当前工作区绑定。
   */
  public assertBinding(bindingId: string): WorkspaceBinding {
    const binding = this.requireBinding();
    if (binding.bindingId !== bindingId) {
      throw new DesktopError(
        'WORKSPACE_CHANGED',
        '工作区已在操作创建后发生切换，旧操作已失效且不会执行',
      );
    }
    return binding;
  }

  /**
   * 解析工作区内已存在的目录，供受控命令执行器设置 cwd。
   */
  public async resolveDirectory(relativePath = ''): Promise<string> {
    const target = await this.resolveExisting(relativePath);
    const metadata = await stat(target);
    if (!metadata.isDirectory()) {
      throw new DesktopError('NOT_DIRECTORY', '目标不是文件夹');
    }
    return target;
  }

  /**
   * 读取工作区目录树，限制深度和总条目数。
   */
  public async list(
    relativePath = '',
    depth = 2,
    options: { ignoreDirectories?: readonly string[] } = {},
  ): Promise<readonly WorkspaceTreeEntry[]> {
    const root = await this.resolveExisting(relativePath);
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new DesktopError('NOT_DIRECTORY', '目标不是文件夹');
    }
    const ignoredDirectories = new Set(
      (options.ignoreDirectories ?? []).map((name) => name.toLowerCase()),
    );
    let remaining = 5_000;
    const visit = async (
      directory: string,
      currentDepth: number,
    ): Promise<readonly WorkspaceTreeEntry[]> => {
      const entries = await readdir(directory, { withFileTypes: true });
      const result: WorkspaceTreeEntry[] = [];
      entries.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
      for (const entry of entries) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name.toLowerCase())) {
          continue;
        }
        if (remaining <= 0) {
          break;
        }
        remaining -= 1;
        const absolutePath = join(directory, entry.name);
        const canonicalPath = await realpath(absolutePath);
        this.assertInsideRoot(canonicalPath);
        const path = this.toRelative(canonicalPath);
        if (entry.isDirectory()) {
          result.push({
            path,
            name: entry.name,
            type: 'directory',
            ...(currentDepth < depth
              ? { children: await visit(canonicalPath, currentDepth + 1) }
              : {}),
          });
        } else if (entry.isFile()) {
          const metadata = await stat(canonicalPath);
          result.push({
            path,
            name: entry.name,
            type: 'file',
            size: metadata.size,
          });
        }
      }
      return result;
    };
    return visit(root, 0);
  }

  /**
   * 读取受大小限制的 UTF-8 文本文件。
   */
  public async read(
    relativePath: string,
    maximumBytes = this.maximumReadBytes,
  ): Promise<WorkspaceFile> {
    const target = await this.resolveExisting(relativePath);
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new DesktopError('NOT_FILE', '目标不是普通文件');
    }
    if (metadata.size > Math.min(maximumBytes, 10_000_000)) {
      throw new DesktopError('FILE_TOO_LARGE', '文件超过读取大小限制');
    }
    const content = await readFile(target, 'utf8');
    return {
      path: this.toRelative(target),
      content,
      size: metadata.size,
      hash: hash(content),
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  /**
   * 生成待审批的逐行变更，不立即写入文件。
   */
  public async proposeWrite(
    relativePath: string,
    content: string,
    expectedHash?: string,
  ): Promise<WorkspaceProposal> {
    if (Buffer.byteLength(content, 'utf8') > 10_000_000) {
      throw new DesktopError('FILE_TOO_LARGE', '写入内容超过 10 MB');
    }
    const target = await this.resolveForWrite(relativePath);
    let before = '';
    try {
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size > 10_000_000) {
        throw new DesktopError('NOT_FILE', '目标不是可修改的文本文件');
      }
      before = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const beforeHash = hash(before);
    if (expectedHash !== undefined && expectedHash !== beforeHash) {
      throw new DesktopError('FILE_CHANGED', '文件已被其他操作修改，请重新读取后再提交');
    }
    const lineEnding = preferredLineEnding(before, content);
    const normalizedContent = normalizeLineEndings(content, lineEnding);
    const beforeFinalNewline = hasFinalNewline(before);
    const finalNewline = hasFinalNewline(normalizedContent);
    const newlineChangeId = beforeFinalNewline === finalNewline ? undefined : randomUUID();
    const operations = createLineOperations(before, normalizedContent);
    const changes: ProposalChange[] = operations.flatMap((operation) =>
      operation.type === 'equal'
        ? []
        : [
            {
              id: operation.changeId as string,
              type: operation.type,
              content: operation.content,
              ...(operation.oldLine === undefined ? {} : { oldLine: operation.oldLine }),
              ...(operation.newLine === undefined ? {} : { newLine: operation.newLine }),
            },
          ],
    );
    if (newlineChangeId !== undefined) {
      changes.push({
        id: newlineChangeId,
        type: finalNewline ? 'add' : 'delete',
        content: '<EOF newline>',
      });
    }
    const id = randomUUID();
    const createdAt = new Date();
    const proposal: InternalProposal = {
      id,
      bindingId: this.requireBinding().bindingId,
      path: this.toRelative(target),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.proposalLifetimeMs).toISOString(),
      status: 'pending',
      beforeHash,
      afterHash: hash(normalizedContent),
      diff: formatUnifiedDiff(relativePath, operations, beforeFinalNewline, finalNewline),
      changes,
      operations,
      beforeFinalNewline,
      finalNewline,
      lineEnding,
      ...(newlineChangeId === undefined ? {} : { newlineChangeId }),
    };
    this.proposals.set(id, proposal);
    return publicProposal(proposal);
  }

  /**
   * 列出尚在内存中的变更提案，并标记已过期项目。
   */
  public listProposals(): readonly WorkspaceProposal[] {
    this.expireProposals();
    return [...this.proposals.values()].map(publicProposal);
  }

  /**
   * 返回安全写入目标的当前内容哈希；文件尚不存在时按空内容计算。
   */
  public async hashForWrite(relativePath: string): Promise<string> {
    const target = await this.resolveForWrite(relativePath);
    try {
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size > 10_000_000) {
        throw new DesktopError('NOT_FILE', '目标不是可修改的文本文件');
      }
      return hash(await readFile(target, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return hash('');
      }
      throw error;
    }
  }

  /**
   * 应用全部或选定的逐行变更；落盘前重新检查文件哈希。
   */
  public async applyProposal(
    proposalId: string,
    acceptedChangeIds?: readonly string[],
  ): Promise<WorkspaceFile> {
    this.expireProposals();
    const proposal = this.proposals.get(proposalId);
    if (proposal?.status !== 'pending') {
      throw new DesktopError('PROPOSAL_INVALID', '变更提案不存在或已失效');
    }
    this.assertBinding(proposal.bindingId);
    const target = await this.resolveForWrite(proposal.path);
    let current = '';
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (hash(current) !== proposal.beforeHash) {
      throw new DesktopError('FILE_CHANGED', '审批期间文件已发生变化，未执行覆盖');
    }
    const allChangeIds = new Set(proposal.changes.map((change) => change.id));
    const accepted = acceptedChangeIds === undefined ? allChangeIds : new Set(acceptedChangeIds);
    for (const id of accepted) {
      if (!allChangeIds.has(id)) {
        throw new DesktopError('PROPOSAL_INVALID', '包含未知的变更行标识');
      }
    }
    const acceptedFinalNewline =
      proposal.newlineChangeId === undefined || accepted.has(proposal.newlineChangeId)
        ? proposal.finalNewline
        : proposal.beforeFinalNewline;
    const finalContent = applyOperations(
      proposal.operations,
      accepted,
      acceptedFinalNewline,
      proposal.lineEnding,
    );
    await atomicWrite(target, finalContent, this.options.cleanupFile);
    const result = await this.read(proposal.path, 10_000_000);
    if (
      accepted.size === allChangeIds.size &&
      [...allChangeIds].every((id) => accepted.has(id)) &&
      result.hash !== proposal.afterHash
    ) {
      throw new DesktopError(
        'FILE_WRITE_VERIFY_FAILED',
        '文件已写入但完整性校验失败，请重新读取文件后处理',
      );
    }
    proposal.status = 'applied';
    this.options.onChanged?.(proposal.path);
    return result;
  }

  /**
   * 明确拒绝一个待审批提案。
   */
  public rejectProposal(proposalId: string): WorkspaceProposal {
    this.expireProposals();
    const proposal = this.proposals.get(proposalId);
    if (proposal?.status !== 'pending') {
      throw new DesktopError('PROPOSAL_INVALID', '变更提案不存在或已失效');
    }
    proposal.status = 'rejected';
    return publicProposal(proposal);
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.resolveCandidate(relativePath);
    const canonicalPath = await realpath(candidate);
    this.assertInsideRoot(canonicalPath);
    return canonicalPath;
  }

  private async resolveForWrite(relativePath: string): Promise<string> {
    const candidate = this.resolveCandidate(relativePath);
    let current = candidate;
    for (;;) {
      try {
        const canonicalParent = await realpath(current);
        this.assertInsideRoot(canonicalParent);
        return resolve(canonicalParent, relative(current, candidate));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw error;
        }
        current = parent;
      }
    }
  }

  private resolveCandidate(relativePath: string): string {
    const root = this.requireBinding().root;
    if (
      relativePath.includes('\0') ||
      isAbsolute(relativePath) ||
      /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(relativePath)
    ) {
      throw new DesktopError('PATH_DENIED', '仅允许工作区相对路径');
    }
    const candidate = resolve(root, relativePath);
    this.assertInsideRoot(candidate);
    return candidate;
  }

  private assertInsideRoot(path: string): void {
    const root = this.requireBinding().root;
    const relation = relative(root, path);
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new DesktopError('PATH_DENIED', '路径超出绑定的工作区');
    }
  }

  private toRelative(path: string): string {
    return relative(this.requireBinding().root, path).replaceAll('\\', '/');
  }

  private requireBinding(): WorkspaceBinding {
    if (this.binding === undefined) {
      throw new DesktopError('WORKSPACE_UNBOUND', '请先选择工作区');
    }
    return this.binding;
  }

  private async restoreBinding(root: string, bindingId: string): Promise<void> {
    const canonicalRoot = await realpath(resolve(root));
    const metadata = await stat(canonicalRoot);
    if (!metadata.isDirectory()) {
      throw new DesktopError('WORKSPACE_INVALID', '所选路径不是文件夹');
    }
    this.binding = {
      bindingId,
      root: canonicalRoot,
      name: basename(canonicalRoot),
    };
    this.proposals.clear();
    await this.persistBinding(this.binding);
  }

  private async persistBinding(binding: WorkspaceBinding): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    await atomicWrite(
      this.options.stateFile,
      JSON.stringify(
        {
          version: 2,
          bindingId: binding.bindingId,
          root: binding.root,
        },
        null,
        2,
      ),
      this.options.cleanupFile,
    );
  }

  private expireProposals(): void {
    const now = Date.now();
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'pending' && Date.parse(proposal.expiresAt) <= now) {
        proposal.status = 'expired';
      }
    }
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function publicProposal(proposal: InternalProposal): WorkspaceProposal {
  const {
    operations: _operations,
    beforeFinalNewline: _beforeFinalNewline,
    finalNewline: _finalNewline,
    lineEnding: _lineEnding,
    newlineChangeId: _newlineChangeId,
    ...visible
  } = proposal;
  return visible;
}

function createLineOperations(before: string, after: string): readonly LineOperation[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  if (oldLines.length * newLines.length > 4_000_000) {
    return [
      ...oldLines.map((content, index) => ({
        type: 'delete' as const,
        content,
        changeId: randomUUID(),
        oldLine: index + 1,
      })),
      ...newLines.map((content, index) => ({
        type: 'add' as const,
        content,
        changeId: randomUUID(),
        newLine: index + 1,
      })),
    ];
  }

  const columns = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * columns);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * columns + newIndex;
      table[index] =
        oldLines[oldIndex] === newLines[newIndex]
          ? (table[(oldIndex + 1) * columns + newIndex + 1] ?? 0) + 1
          : Math.max(
              table[(oldIndex + 1) * columns + newIndex] ?? 0,
              table[oldIndex * columns + newIndex + 1] ?? 0,
            );
    }
  }
  const operations: LineOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      operations.push({
        type: 'equal',
        content: oldLines[oldIndex] as string,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex >= oldLines.length ||
        (table[oldIndex * columns + newIndex + 1] ?? 0) >
          (table[(oldIndex + 1) * columns + newIndex] ?? 0))
    ) {
      operations.push({
        type: 'add',
        content: newLines[newIndex] as string,
        changeId: randomUUID(),
        newLine: newIndex + 1,
      });
      newIndex += 1;
    } else {
      operations.push({
        type: 'delete',
        content: oldLines[oldIndex] as string,
        changeId: randomUUID(),
        oldLine: oldIndex + 1,
      });
      oldIndex += 1;
    }
  }
  return operations;
}

function splitLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function applyOperations(
  operations: readonly LineOperation[],
  accepted: ReadonlySet<string>,
  finalNewline: boolean,
  lineEnding: '\n' | '\r\n',
): string {
  const result: string[] = [];
  for (const operation of operations) {
    if (
      operation.type === 'equal' ||
      (operation.type === 'add' &&
        operation.changeId !== undefined &&
        accepted.has(operation.changeId)) ||
      (operation.type === 'delete' &&
        (operation.changeId === undefined || !accepted.has(operation.changeId)))
    ) {
      result.push(operation.content);
    }
  }
  if (result.length === 0) {
    return '';
  }
  return `${result.join(lineEnding)}${finalNewline ? lineEnding : ''}`;
}

function formatUnifiedDiff(
  path: string,
  operations: readonly LineOperation[],
  beforeFinalNewline: boolean,
  finalNewline: boolean,
): string {
  const oldCount = operations.filter((operation) => operation.type !== 'add').length;
  const newCount = operations.filter((operation) => operation.type !== 'delete').length;
  return [
    `--- a/${path.replaceAll('\\', '/')}`,
    `+++ b/${path.replaceAll('\\', '/')}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...operations.map((operation) => {
      const prefix = operation.type === 'add' ? '+' : operation.type === 'delete' ? '-' : ' ';
      return `${prefix}${operation.content}`;
    }),
    ...(beforeFinalNewline === finalNewline
      ? []
      : [finalNewline ? '\\ Added newline at end of file' : '\\ No newline at end of file']),
  ].join('\n');
}

function preferredLineEnding(before: string, after: string): '\n' | '\r\n' {
  if (before.includes('\r\n')) {
    return '\r\n';
  }
  return before.length === 0 && after.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeLineEndings(content: string, lineEnding: '\n' | '\r\n'): string {
  return content.replace(/\r\n?|\n/gu, '\n').replaceAll('\n', lineEnding);
}

function hasFinalNewline(content: string): boolean {
  return content.endsWith('\n') || content.endsWith('\r');
}

async function atomicWrite(
  path: string,
  content: string,
  cleanupFile: (path: string) => Promise<void> = (target) => rm(target, { force: true }),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const backupPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.bak`);
  let originalMode: number | undefined;
  try {
    originalMode = (await lstat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await writeFile(temporaryPath, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: originalMode ?? 0o600,
  });
  try {
    if (originalMode !== undefined) {
      await chmod(temporaryPath, originalMode);
      await rename(path, backupPath);
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (originalMode !== undefined) {
        await rename(backupPath, path).catch(() => undefined);
      }
      throw error;
    }

    // rename 成功即为提交点，后续备份清理失败不能把已提交写入误报为失败。
    await cleanupFile(backupPath).catch(() => undefined);
  } finally {
    await cleanupFile(temporaryPath).catch(() => undefined);
  }
}
