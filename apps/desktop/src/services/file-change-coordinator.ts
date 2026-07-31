import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { DesktopError } from './errors.js';
import type { DesktopFileHookName, DesktopFileHookPayloadMap } from './plugin-hook-runner.js';
import type { DesktopSecretStore } from './secret-store.js';
import type { WorkspaceFile, WorkspaceProposal, WorkspaceService } from './workspace.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const persistedEntrySchema = z
  .object({
    changeId: z.string().uuid(),
    conversationId: z.string().uuid(),
    proposalId: z.string().uuid(),
    bindingId: z.string().uuid(),
    path: z.string().min(1).max(1_024),
    requestedContent: z.string().max(750_000),
    beforeHash: hashSchema,
    afterHash: hashSchema,
  })
  .strict();
const persistedStateSchema = z
  .object({
    version: z.literal(2),
    entries: z.array(persistedEntrySchema).max(10_000),
  })
  .strict();
const legacyPersistedStateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(z.unknown()).max(10_000),
  })
  .strict();

type PersistedEntry = z.infer<typeof persistedEntrySchema>;

export interface DesktopFileChangeCoordinatorOptions {
  workspace: WorkspaceService;
  secrets: DesktopSecretStore;
  fileHookRunner?: {
    run<Name extends DesktopFileHookName>(
      name: Name,
      payload: DesktopFileHookPayloadMap[Name],
    ): Promise<void>;
  };
}

/**
 * 连接数据库中的文件变更记录与 WorkspaceService 的安全写入提案。
 *
 * 映射和目标内容使用主密钥加密持久化；应用重启后会以 beforeHash 重建提案，
 * 文件已被外部修改时保持 fail closed，绝不覆盖新内容。
 */
export class DesktopFileChangeCoordinator {
  private readonly entries = new Map<string, PersistedEntry>();
  private loaded = false;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DesktopFileChangeCoordinatorOptions) {}

  public initialize(): Promise<void> {
    return this.exclusive(async () => this.load());
  }

  public register(input: {
    changeId: string;
    conversationId: string;
    proposal: WorkspaceProposal;
    requestedContent: string;
  }): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const entry = persistedEntrySchema.parse({
        changeId: input.changeId,
        conversationId: input.conversationId,
        proposalId: input.proposal.id,
        bindingId: input.proposal.bindingId,
        path: input.proposal.path,
        requestedContent: input.requestedContent,
        beforeHash: input.proposal.beforeHash,
        afterHash: input.proposal.afterHash,
      });
      this.entries.set(entry.changeId, entry);
      try {
        await this.persist();
      } catch (error) {
        this.entries.delete(entry.changeId);
        throw error;
      }
    });
  }

  /**
   * 把完整提案安全写入磁盘，但保留持久映射，直到数据库状态提交成功。
   */
  public prepareAccept(
    changeId: string,
    conversationId: string,
    actor: { id: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null = null,
  ): Promise<WorkspaceFile> {
    return this.exclusive(async () => {
      const entry = await this.requireEntry(changeId, conversationId);
      this.options.workspace.assertBinding(entry.bindingId);
      const currentHash = await this.options.workspace.hashForWrite(entry.path);
      if (currentHash === entry.afterHash) {
        return this.options.workspace.read(entry.path, 10_000_000);
      }

      let proposal = this.options.workspace
        .listProposals()
        .find(
          (candidate) =>
            candidate.id === entry.proposalId &&
            candidate.status === 'pending' &&
            candidate.bindingId === entry.bindingId &&
            candidate.path === entry.path &&
            candidate.beforeHash === entry.beforeHash &&
            candidate.afterHash === entry.afterHash,
        );
      if (proposal === undefined) {
        proposal = await this.options.workspace.proposeWrite(
          entry.path,
          entry.requestedContent,
          entry.beforeHash,
        );
        if (proposal.bindingId !== entry.bindingId) {
          throw new DesktopError(
            'WORKSPACE_CHANGED',
            '工作区已在文件变更创建后发生切换，未执行任何写盘操作',
          );
        }
        entry.proposalId = proposal.id;
        await this.persist();
      }

      const hookEnvelope = {
        schemaVersion: 1 as const,
        requestId: entry.changeId,
        actor,
        operation: 'workspace.file-save' as const,
        file: {
          relativePath: entry.path.replaceAll('\\', '/'),
          byteLength: Buffer.byteLength(entry.requestedContent, 'utf8'),
          sha256: entry.afterHash,
          changeId: entry.changeId,
        },
      };
      await this.runHook('file:before-save', {
        ...hookEnvelope,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
      });

      const startedAt = performance.now();
      try {
        const result = await this.options.workspace.applyProposal(proposal.id);
        if (result.hash !== entry.afterHash) {
          throw new DesktopError(
            'FILE_WRITE_VERIFY_FAILED',
            '文件写入后的哈希与待审批内容不一致，数据库状态未更新',
          );
        }
        await this.runHook('file:after-save', {
          ...hookEnvelope,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          outcome: {
            success: true,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            errorCode: null,
          },
        });
        return result;
      } catch (error) {
        await this.runHook('file:after-save', {
          ...hookEnvelope,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          outcome: {
            success: false,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            errorCode: error instanceof DesktopError ? error.code : 'FILE_SAVE_FAILED',
          },
        });
        throw error;
      }
    });
  }

  /**
   * 拒绝仍在内存中的提案；重启后无内存提案时只保留“未写盘”语义。
   */
  public prepareReject(changeId: string, conversationId: string): Promise<void> {
    return this.exclusive(async () => {
      const entry = await this.requireEntry(changeId, conversationId, false);
      const proposal = this.options.workspace
        .listProposals()
        .find((candidate) => candidate.id === entry.proposalId);
      if (proposal?.status === 'pending') {
        this.options.workspace.rejectProposal(proposal.id);
      }
    });
  }

  /**
   * 数据库状态提交成功后清理恢复映射。
   */
  public complete(changeId: string, conversationId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireEntry(changeId, conversationId, false);
      this.entries.delete(changeId);
      await this.persist();
    });
  }

  private async requireEntry(
    changeId: string,
    conversationId: string,
    requireCurrentBinding = true,
  ): Promise<PersistedEntry> {
    await this.load();
    const entry = this.entries.get(changeId);
    if (entry === undefined || entry.conversationId !== conversationId) {
      throw new DesktopError(
        'FILE_CHANGE_MAPPING_MISSING',
        '文件变更缺少可信写入映射，已拒绝修改磁盘',
      );
    }
    if (requireCurrentBinding) {
      this.options.workspace.assertBinding(entry.bindingId);
    }
    return entry;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const stored = await this.options.secrets.readJson<unknown>('file-change-proposals');
    if (stored !== undefined) {
      const parsed = persistedStateSchema.safeParse(stored);
      if (parsed.success) {
        for (const entry of parsed.data.entries) {
          this.entries.set(entry.changeId, entry);
        }
      } else if (legacyPersistedStateSchema.safeParse(stored).success) {
        // v1 映射没有工作区身份，无法证明它仍属于当前绑定；迁移时必须 fail closed。
        await this.persist();
      } else {
        throw new DesktopError('FILE_CHANGE_STATE_INVALID', '文件变更恢复状态无效，已拒绝修改磁盘');
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.options.secrets.writeJson('file-change-proposals', {
      version: 2,
      entries: [...this.entries.values()],
    });
  }

  private async runHook<Name extends DesktopFileHookName>(
    name: Name,
    payload: DesktopFileHookPayloadMap[Name],
  ): Promise<void> {
    try {
      await this.options.fileHookRunner?.run(name, payload);
    } catch {
      // Hook 运行器自身异常也不能改变用户已经批准的文件写入语义。
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
