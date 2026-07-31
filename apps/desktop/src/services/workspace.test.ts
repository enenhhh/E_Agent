import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceService } from './workspace.js';

async function createFixture(options: { cleanupFile?: (path: string) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e-agent-workspace-'));
  const stateDirectory = await mkdtemp(join(tmpdir(), 'e-agent-state-'));
  const onChanged = vi.fn();
  const service = new WorkspaceService({
    stateFile: join(stateDirectory, 'workspace.json'),
    onChanged,
    ...options,
  });
  await service.bind(root);
  return { root, service, onChanged, stateDirectory };
}

describe('WorkspaceService', () => {
  it('拒绝路径逃逸和指向外部的符号链接', async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), 'e-agent-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(fixture.root, 'link'), 'junction');
    await expect(fixture.service.read('../outside.txt')).rejects.toThrow(/工作区/);
    await expect(fixture.service.read('link/secret.txt')).rejects.toThrow(/工作区/);
  });

  it('审批前不写入并在全部批准后原子更新', async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, 'file.ts');
    await writeFile(path, 'const value = 1;\n');
    const proposal = await fixture.service.proposeWrite('file.ts', 'const value = 2;\n');
    expect(await readFile(path, 'utf8')).toBe('const value = 1;\n');
    const result = await fixture.service.applyProposal(proposal.id);
    expect(result.content).toBe('const value = 2;\n');
    expect(fixture.onChanged).toHaveBeenCalledWith('file.ts');
  });

  it('允许逐行接受或拒绝变更', async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, 'file.txt');
    await writeFile(path, 'keep\nold\n');
    const proposal = await fixture.service.proposeWrite('file.txt', 'keep\nnew\nextra\n');
    const addition = proposal.changes.find(
      (change) => change.type === 'add' && change.content === 'extra',
    );
    expect(addition).toBeDefined();
    await fixture.service.applyProposal(proposal.id, addition === undefined ? [] : [addition.id]);
    expect(await readFile(path, 'utf8')).toBe('keep\nold\nextra\n');
  });

  it('原文件在审批期间变化时拒绝覆盖', async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, 'file.ts');
    await writeFile(path, 'before\n');
    const proposal = await fixture.service.proposeWrite('file.ts', 'after\n');
    await writeFile(path, 'external\n');
    await expect(fixture.service.applyProposal(proposal.id)).rejects.toThrow(/发生变化/);
    expect(await readFile(path, 'utf8')).toBe('external\n');
  });

  it('支持创建新目录中的文件', async () => {
    const fixture = await createFixture();
    const proposal = await fixture.service.proposeWrite('new/file.txt', 'created\n');
    await fixture.service.applyProposal(proposal.id);
    await access(join(fixture.root, 'new', 'file.txt'));
  });

  it('修改 Windows 文本时保留 CRLF 并显式展示 EOF 换行变化', async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, 'windows.txt');
    await writeFile(path, 'first\r\nsecond\r\n');
    const proposal = await fixture.service.proposeWrite('windows.txt', 'first\nupdated');
    expect(proposal.diff).toContain('\\ No newline at end of file');
    expect(proposal.changes).toContainEqual(
      expect.objectContaining({ type: 'delete', content: '<EOF newline>' }),
    );
    const result = await fixture.service.applyProposal(proposal.id);
    expect(result.content).toBe('first\r\nupdated');
    expect(result.hash).toBe(proposal.afterHash);
  });

  it('提交点之后的备份清理失败不把成功写盘误报为失败', async () => {
    const cleanupFile = vi.fn(async () => {
      throw new Error('simulated cleanup failure');
    });
    const fixture = await createFixture({ cleanupFile });
    const path = join(fixture.root, 'commit.txt');
    await writeFile(path, 'before\n');
    const proposal = await fixture.service.proposeWrite('commit.txt', 'after\n');
    await expect(fixture.service.applyProposal(proposal.id)).resolves.toMatchObject({
      content: 'after\n',
      hash: proposal.afterHash,
    });
    expect(await readFile(path, 'utf8')).toBe('after\n');
    expect(cleanupFile).toHaveBeenCalled();
  });

  it('工作区重新绑定后拒绝应用旧提案，且不会写入任一工作区', async () => {
    const fixture = await createFixture();
    const originalPath = join(fixture.root, 'shared.txt');
    await writeFile(originalPath, 'original\n');
    const proposal = await fixture.service.proposeWrite('shared.txt', 'proposed\n');

    const replacementRoot = await mkdtemp(join(tmpdir(), 'e-agent-replacement-workspace-'));
    const replacementPath = join(replacementRoot, 'shared.txt');
    await writeFile(replacementPath, 'replacement\n');
    const originalBindingId = proposal.bindingId;
    const replacementBinding = await fixture.service.bind(replacementRoot);

    expect(replacementBinding.bindingId).not.toBe(originalBindingId);
    await expect(fixture.service.applyProposal(proposal.id)).rejects.toMatchObject({
      code: 'PROPOSAL_INVALID',
    });
    expect(await readFile(originalPath, 'utf8')).toBe('original\n');
    expect(await readFile(replacementPath, 'utf8')).toBe('replacement\n');
  });

  it('在遍历层忽略 node_modules，避免其消耗条目上限且保留普通源码', async () => {
    const fixture = await createFixture();
    try {
      const dependencyDirectory = join(fixture.root, 'node_modules', 'large-package');
      const sourceDirectory = join(fixture.root, 'src');
      await mkdir(dependencyDirectory, { recursive: true });
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, 'index.ts'), 'export const visible = true;\n');

      // 数量超过 WorkspaceService 的 5,000 条上限；若先遍历后过滤，src 将不可见。
      for (let offset = 0; offset < 5_010; offset += 250) {
        await Promise.all(
          Array.from({ length: Math.min(250, 5_010 - offset) }, (_, index) =>
            writeFile(
              join(dependencyDirectory, `dependency-${offset + index}.js`),
              'module.exports = {};\n',
            ),
          ),
        );
      }

      const tree = await fixture.service.list('', 3, {
        ignoreDirectories: ['node_modules'],
      });
      const serialized = JSON.stringify(tree);
      expect(serialized).not.toContain('node_modules');
      expect(serialized).not.toContain('dependency-');
      expect(tree).toContainEqual(
        expect.objectContaining({
          path: 'src',
          type: 'directory',
          children: [
            expect.objectContaining({
              path: 'src/index.ts',
              type: 'file',
            }),
          ],
        }),
      );
    } finally {
      await Promise.all([
        rm(fixture.root, { recursive: true, force: true }),
        rm(fixture.stateDirectory, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);
});
