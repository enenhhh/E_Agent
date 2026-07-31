import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Skill } from '../../types';

import { createWorkflowDefinition, WorkflowDesignerModal } from './WorkflowDesignerModal';

afterEach(() => cleanup());

function skill(command: string, variable: string): Skill {
  return {
    id: `com.eagent.${command.slice(1)}`,
    name: command,
    description: `${command} description`,
    version: '1.0.0',
    source: 'builtin',
    enabled: true,
    command,
    permissions: [],
    variables: [
      {
        name: variable,
        description: '主输入',
        required: true,
        maximumLength: 1_000_000,
      },
    ],
  };
}

describe('createWorkflowDefinition', () => {
  it('把首步映射到共享输入并声明后续步骤依赖', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    const workflow = createWorkflowDefinition('交付流水线', [
      skill('@code-review', 'code'),
      skill('@test-gen', 'code'),
      skill('@deploy', 'projectContext'),
    ]);

    expect(workflow).toEqual({
      schemaVersion: 1,
      id: 'com.eagent.workflow.11111111-1111-4111-8111-111111111111',
      name: '交付流水线',
      steps: [
        {
          id: 'code-review-1',
          skillId: 'com.eagent.code-review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
        {
          id: 'test-gen-1',
          skillId: 'com.eagent.test-gen',
          dependsOn: ['code-review-1'],
          input: { code: '{{steps.code-review-1}}' },
        },
        {
          id: 'deploy-1',
          skillId: 'com.eagent.deploy',
          dependsOn: ['test-gen-1'],
          input: { projectContext: '{{steps.test-gen-1}}' },
        },
      ],
    });
  });

  it('为重复 Skill 生成唯一且正确串联的步骤标识', () => {
    const repeated = skill('@explain', 'code');
    const workflow = createWorkflowDefinition('重复解释', [repeated, repeated, repeated]);
    expect(workflow.steps.map((step) => step.id)).toEqual(['explain-1', 'explain-2', 'explain-3']);
    expect(workflow.steps[2]?.dependsOn).toEqual(['explain-2']);
    expect(workflow.steps[2]?.input).toEqual({ code: '{{steps.explain-2}}' });
  });

  it('按优先变量、必填变量、首变量与兜底变量生成输入映射', () => {
    const custom = (variables: Skill['variables']): Skill => ({
      ...skill('@custom', 'unused'),
      variables,
    });
    const workflow = createWorkflowDefinition('变量映射', [
      custom([
        {
          name: 'optional',
          description: 'optional',
          required: false,
          maximumLength: 100,
        },
        {
          name: 'request',
          description: 'preferred',
          required: true,
          maximumLength: 100,
        },
        {
          name: 'requiredExtra',
          description: 'required',
          required: true,
          maximumLength: 100,
        },
      ]),
      { ...custom([]), id: 'empty', command: '@empty' },
    ]);

    expect(workflow.steps[0]?.input).toEqual({
      request: '{{input.source}}',
      requiredExtra: '{{input.source}}',
    });
    expect(workflow.steps[1]?.input).toEqual({ input: '{{steps.custom-1}}' });
  });
});

describe('WorkflowDesignerModal', () => {
  it('关闭时不渲染，打开无可用 Skill 时显示提示并支持多种关闭方式', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkflowDesignerModal onClose={onClose} onSave={vi.fn()} open={false} skills={[]} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <WorkflowDesignerModal
        onClose={onClose}
        onSave={vi.fn()}
        open
        skills={[{ ...skill('@disabled', 'code'), enabled: false }]}
      />,
    );
    expect(screen.getByText('请先启用至少一个 Skill。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('添加、排序、删除并成功保存线性 Workflow', async () => {
    const codeReview = skill('@code-review', 'code');
    const deploy = skill('@deploy', 'projectContext');
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkflowDesignerModal
        onClose={onClose}
        onSave={onSave}
        open
        skills={[codeReview, deploy, { ...skill('@disabled', 'code'), enabled: false }]}
      />,
    );

    const save = screen.getByRole('button', { name: '保存 Workflow' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  发布流水线  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: deploy.id } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '上移步骤' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '下移步骤' })[1]).toBeDisabled();

    fireEvent.click(screen.getAllByRole('button', { name: '上移步骤' })[1]!);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('@deploy');
    fireEvent.click(screen.getAllByRole('button', { name: '下移步骤' })[0]!);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('@code-review');
    fireEvent.click(screen.getAllByRole('button', { name: '删除步骤' })[1]!);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: '发布流水线',
        steps: [expect.objectContaining({ skillId: codeReview.id })],
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('展示 Error 与非 Error 保存失败，并在重新打开时清空表单', async () => {
    const enabled = skill('@explain', 'code');
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('保存服务不可用'))
      .mockRejectedValueOnce('unknown failure');
    const { rerender } = render(
      <WorkflowDesignerModal onClose={vi.fn()} onSave={onSave} open skills={[enabled]} />,
    );

    const fillAndSubmit = async (name: string) => {
      fireEvent.change(screen.getByLabelText('名称'), { target: { value: name } });
      fireEvent.click(screen.getByRole('button', { name: '添加' }));
      fireEvent.click(screen.getByRole('button', { name: '保存 Workflow' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    };
    await fillAndSubmit('失败一');
    expect(screen.getByRole('alert')).toHaveTextContent('保存服务不可用');
    fireEvent.click(screen.getByRole('button', { name: '删除步骤' }));
    await fillAndSubmit('失败二');
    expect(screen.getByRole('alert')).toHaveTextContent('Workflow 保存失败。');

    rerender(
      <WorkflowDesignerModal onClose={vi.fn()} onSave={onSave} open={false} skills={[enabled]} />,
    );
    rerender(<WorkflowDesignerModal onClose={vi.fn()} onSave={onSave} open skills={[enabled]} />);
    expect(screen.getByLabelText('名称')).toHaveValue('');
    expect(screen.getByText('添加 Skill 后可调整执行顺序。')).toBeInTheDocument();
  });

  it('保存期间禁用提交，并限制最多二十个步骤', async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    render(
      <WorkflowDesignerModal
        onClose={vi.fn()}
        onSave={onSave}
        open
        skills={[skill('@repeat', 'query')]}
      />,
    );
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '二十步' } });
    const add = screen.getByRole('button', { name: '添加' });
    for (let index = 0; index < 20; index += 1) fireEvent.click(add);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存 Workflow' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '保存 Workflow' })).toBeDisabled();
    finishSave?.();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存 Workflow' })).not.toBeDisabled(),
    );
  }, 10_000);
});
