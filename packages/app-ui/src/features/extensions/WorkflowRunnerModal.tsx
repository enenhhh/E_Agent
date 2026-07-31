import { Play } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { Skill, WorkflowDefinition, WorkflowResult } from '../../types';

interface WorkflowRunnerModalProps {
  open: boolean;
  workflow: WorkflowDefinition | null;
  skills: Skill[];
  onClose: () => void;
  onRun: (workflowId: string, variables: Record<string, string>) => Promise<WorkflowResult>;
}

/**
 * 收集 Workflow 的共享输入并逐步骤展示结构化输出。
 */
export function WorkflowRunnerModal({
  onClose,
  onRun,
  open,
  skills,
  workflow,
}: WorkflowRunnerModalProps): React.JSX.Element {
  const [source, setSource] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource('');
    setResult(null);
    setError(null);
  }, [open, workflow?.id]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (workflow === null || source.trim().length === 0) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onRun(workflow.id, { source }));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Workflow 运行失败。');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      description={
        workflow === null
          ? undefined
          : `将依次运行 ${workflow.steps.length} 个 Skill；每一步完成后才会执行下一步。`
      }
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            关闭
          </Button>
          <Button
            disabled={workflow === null || source.trim().length === 0}
            form="workflow-runner-form"
            loading={running}
            type="submit"
            variant="primary"
          >
            <Play size={14} />
            运行
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={workflow?.name ?? '运行 Workflow'}
    >
      <form
        className="workflow-runner"
        id="workflow-runner-form"
        onSubmit={(event) => void submit(event)}
      >
        <label className="workflow-runner__input">
          <span>初始输入</span>
          <textarea
            maxLength={1_000_000}
            onChange={(event) => setSource(event.target.value)}
            placeholder="粘贴代码、需求、数据库描述或项目上下文…"
            required
            value={source}
          />
          <small>{source.length.toLocaleString()} / 1,000,000 字符</small>
        </label>
        {error ? (
          <p className="workflow-designer__error" role="alert">
            {error}
          </p>
        ) : null}
        {result ? (
          <div className="workflow-results" aria-live="polite">
            {workflow?.steps.map((step, index) => {
              const skill = skills.find((candidate) => candidate.id === step.skillId);
              return (
                <article key={step.id}>
                  <header>
                    <span>{index + 1}</span>
                    <strong>{skill?.name ?? step.skillId}</strong>
                    <code>{step.id}</code>
                  </header>
                  <pre>{formatOutput(result.outputs[step.id])}</pre>
                </article>
              );
            })}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function formatOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '该步骤没有返回输出。';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
