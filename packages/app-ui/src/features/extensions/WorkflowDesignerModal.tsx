import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import type { Skill, WorkflowDefinition, WorkflowStep } from '../../types';

interface WorkflowDesignerModalProps {
  open: boolean;
  skills: Skill[];
  onClose: () => void;
  onSave: (workflow: WorkflowDefinition) => Promise<void>;
}

/**
 * 创建线性 Skill Workflow。首步读取运行输入，后续步骤读取前一步输出。
 */
export function WorkflowDesignerModal({
  onClose,
  onSave,
  open,
  skills,
}: WorkflowDesignerModalProps): React.JSX.Element {
  const availableSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills]);
  const [name, setName] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSelectedSkills([]);
    setSelectedSkillId(availableSkills[0]?.id ?? '');
    setError(null);
  }, [availableSkills, open]);

  const addStep = (): void => {
    const skill = availableSkills.find((candidate) => candidate.id === selectedSkillId);
    if (skill === undefined || selectedSkills.length >= 20) return;
    setSelectedSkills((current) => [...current, skill]);
  };

  const moveStep = (index: number, direction: -1 | 1): void => {
    setSelectedSkills((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [step] = next.splice(index, 1);
      if (step === undefined) return current;
      next.splice(target, 0, step);
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || selectedSkills.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(createWorkflowDefinition(trimmedName, selectedSkills));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Workflow 保存失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      description="按顺序串联 1–20 个 Skill。第一步接收运行输入，之后每一步接收前一步的完整输出。"
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button
            disabled={name.trim().length === 0 || selectedSkills.length === 0}
            form="workflow-designer-form"
            loading={saving}
            type="submit"
            variant="primary"
          >
            保存 Workflow
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="新建 Workflow"
    >
      <form
        className="workflow-designer"
        id="workflow-designer-form"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="名称"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：审查、测试与部署"
          required
          value={name}
        />
        <div className="workflow-designer__add">
          <label>
            <span>添加 Skill</span>
            <Select
              disabled={availableSkills.length === 0}
              onChange={(event) => setSelectedSkillId(event.target.value)}
              value={selectedSkillId}
            >
              {availableSkills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.command} · {skill.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            disabled={selectedSkillId.length === 0 || selectedSkills.length >= 20}
            onClick={addStep}
            size="small"
          >
            <Plus size={14} />
            添加
          </Button>
        </div>
        {availableSkills.length === 0 ? (
          <p className="workflow-designer__notice">请先启用至少一个 Skill。</p>
        ) : null}
        <ol className="workflow-step-list">
          {selectedSkills.map((skill, index) => (
            <li key={`${skill.id}-${index}`}>
              <span className="workflow-step-list__number">{index + 1}</span>
              <span className="workflow-step-list__copy">
                <strong>{skill.name}</strong>
                <small>
                  {skill.command} · {index === 0 ? '读取运行输入' : `读取步骤 ${index} 的输出`} →{' '}
                  {primaryVariable(skill)}
                </small>
              </span>
              <span className="workflow-step-list__actions">
                <Button
                  aria-label="上移步骤"
                  disabled={index === 0}
                  onClick={() => moveStep(index, -1)}
                  size="small"
                  variant="ghost"
                >
                  <ArrowUp size={13} />
                </Button>
                <Button
                  aria-label="下移步骤"
                  disabled={index === selectedSkills.length - 1}
                  onClick={() => moveStep(index, 1)}
                  size="small"
                  variant="ghost"
                >
                  <ArrowDown size={13} />
                </Button>
                <Button
                  aria-label="删除步骤"
                  onClick={() =>
                    setSelectedSkills((current) =>
                      current.filter((_candidate, candidateIndex) => candidateIndex !== index),
                    )
                  }
                  size="small"
                  variant="ghost"
                >
                  <Trash2 size={13} />
                </Button>
              </span>
            </li>
          ))}
        </ol>
        {selectedSkills.length === 0 ? (
          <p className="workflow-designer__notice">添加 Skill 后可调整执行顺序。</p>
        ) : null}
        {error ? (
          <p className="workflow-designer__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function createWorkflowDefinition(
  name: string,
  skills: readonly Skill[],
): WorkflowDefinition {
  const occurrence = new Map<string, number>();
  const steps: WorkflowStep[] = skills.map((skill, index) => {
    const baseId = skill.command.slice(1);
    const count = (occurrence.get(baseId) ?? 0) + 1;
    occurrence.set(baseId, count);
    const id = `${baseId}-${count}`;
    const previous = stepsAt(skills, occurrence, index - 1);
    const input: Record<string, string> = {
      [primaryVariable(skill)]: index === 0 ? '{{input.source}}' : `{{steps.${previous}}}`,
    };
    for (const variable of skill.variables) {
      if (variable.required && input[variable.name] === undefined) {
        input[variable.name] = index === 0 ? '{{input.source}}' : `{{steps.${previous}}}`;
      }
    }
    return {
      id,
      skillId: skill.id,
      dependsOn: previous === undefined ? [] : [previous],
      input,
    };
  });
  return {
    schemaVersion: 1,
    id: `com.eagent.workflow.${crypto.randomUUID().toLowerCase()}`,
    name,
    steps,
  };
}

function stepsAt(
  skills: readonly Skill[],
  currentOccurrence: ReadonlyMap<string, number>,
  index: number,
): string | undefined {
  const skill = skills[index];
  if (skill === undefined) return undefined;
  const baseId = skill.command.slice(1);
  const currentCount = currentOccurrence.get(baseId) ?? 1;
  const count =
    skills[index + 1]?.command === skill.command ? Math.max(1, currentCount - 1) : currentCount;
  return `${baseId}-${count}`;
}

function primaryVariable(skill: Skill): string {
  const preferred = ['code', 'request', 'projectContext', 'content', 'input', 'prompt', 'query'];
  return (
    preferred.find((name) => skill.variables.some((variable) => variable.name === name)) ??
    skill.variables.find((variable) => variable.required)?.name ??
    skill.variables[0]?.name ??
    'input'
  );
}
