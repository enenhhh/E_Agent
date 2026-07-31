import {
  Boxes,
  Braces,
  Code2,
  Database,
  FileText,
  GitPullRequest,
  PackagePlus,
  Play,
  Rocket,
  TestTube2,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { Switch } from '../../components/ui/Switch';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';
import { useExtensionStore } from '../../stores/extension-store';
import { useToastStore } from '../../stores/toast-store';
import type { WorkflowDefinition } from '../../types';

import { InstallExtensionModal } from './InstallExtensionModal';
import { WorkflowDesignerModal } from './WorkflowDesignerModal';
import { WorkflowRunnerModal } from './WorkflowRunnerModal';

const iconByCommand: Record<string, React.JSX.Element> = {
  '@code-review': <GitPullRequest size={20} />,
  '@doc-gen': <FileText size={20} />,
  '@test-gen': <TestTube2 size={20} />,
  '@db-helper': <Database size={20} />,
  '@deploy': <Rocket size={20} />,
  '@explain': <Code2 size={20} />,
};

export function SkillsPage(): React.JSX.Element {
  const { transport } = useTransport();
  const skills = useExtensionStore((state) => state.skills);
  const workflows = useExtensionStore((state) => state.workflows);
  const loading = useExtensionStore((state) => state.loading);
  const error = useExtensionStore((state) => state.error);
  const load = useExtensionStore((state) => state.loadSkillWorkspace);
  const toggle = useExtensionStore((state) => state.toggleSkill);
  const install = useExtensionStore((state) => state.installSkill);
  const saveWorkflow = useExtensionStore((state) => state.saveWorkflow);
  const deleteWorkflow = useExtensionStore((state) => state.deleteWorkflow);
  const runWorkflow = useExtensionStore((state) => state.runWorkflow);
  const role = useAuthStore((state) => state.session?.user.role);
  const pushToast = useToastStore((state) => state.push);
  const [installOpen, setInstallOpen] = useState(false);
  const [designerOpen, setDesignerOpen] = useState(false);
  const [runningWorkflow, setRunningWorkflow] = useState<WorkflowDefinition | null>(null);
  const canManage = role === 'owner' || role === 'admin';
  const canRun = canManage || role === 'member';

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  return (
    <div className="page page--extensions">
      <header className="page-header">
        <span>
          <h2>Skill 技能</h2>
          <p>声明式 Prompt、受限脚本与 Workflow 组合，共享同一套权限与审计机制。</p>
        </span>
        <span className="page-header__actions">
          <Button disabled={!canManage} onClick={() => setDesignerOpen(true)}>
            <Workflow size={15} />
            新建 Workflow
          </Button>
          <Button
            disabled={role !== 'owner'}
            onClick={() => setInstallOpen(true)}
            variant="primary"
          >
            <PackagePlus size={15} />
            安装 Skill
          </Button>
        </span>
      </header>
      {loading ? <LoadingState label="正在读取 Skill 清单…" /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load(transport)} /> : null}
      {!loading && !error && skills.length === 0 ? (
        <EmptyState
          action={
            <Button
              disabled={role !== 'owner'}
              onClick={() => setInstallOpen(true)}
              variant="primary"
            >
              安装 Skill
            </Button>
          }
          description="内置 Skill 会在首次初始化后注册，也可以从受信任的 Git 仓库安装。"
          icon={<Boxes size={28} />}
          title="没有可用 Skill"
        />
      ) : null}
      <div className="extension-list">
        {skills.map((skill) => (
          <article className="extension-row" key={skill.id}>
            <span className="extension-row__icon">
              {iconByCommand[skill.command] ?? <Braces size={20} />}
            </span>
            <span className="extension-row__copy">
              <span>
                <strong>{skill.name}</strong>
                <code>{skill.command}</code>
              </span>
              <p>{skill.description}</p>
              <small>
                v{skill.version} · {skill.source === 'builtin' ? '内置' : skill.source} ·{' '}
                {skill.permissions.length ? skill.permissions.join('、') : '无需脚本权限'}
              </small>
            </span>
            <Switch
              checked={skill.enabled}
              disabled={!canManage}
              label={skill.enabled ? '已启用' : '已停用'}
              onChange={(enabled) => {
                void toggle(transport, skill.id, enabled).catch((toggleError: unknown) => {
                  pushToast({
                    kind: 'error',
                    title: 'Skill 状态更新失败',
                    description: toggleError instanceof Error ? toggleError.message : undefined,
                  });
                });
              }}
            />
          </article>
        ))}
      </div>
      <section className="workflow-section">
        <header>
          <span>
            <h3>Workflow</h3>
            <p>串联多个 Skill，前一步输出会成为后一步输入。</p>
          </span>
          <small>{workflows.length} 个已保存</small>
        </header>
        {workflows.length === 0 && !loading ? (
          <div className="workflow-empty">
            <Workflow size={22} />
            <span>
              <strong>还没有 Workflow</strong>
              <small>可创建“代码审查 → 测试生成 → 部署”等自动化流程。</small>
            </span>
          </div>
        ) : null}
        <div className="workflow-grid">
          {workflows.map((workflow) => (
            <article className="workflow-card" key={workflow.id}>
              <header>
                <span className="workflow-card__icon">
                  <Workflow size={17} />
                </span>
                <span>
                  <strong>{workflow.name}</strong>
                  <small>{workflow.steps.length} 个步骤</small>
                </span>
              </header>
              <ol>
                {workflow.steps.map((step, index) => {
                  const skill = skills.find((candidate) => candidate.id === step.skillId);
                  return (
                    <li key={step.id}>
                      <span>{index + 1}</span>
                      <code>{skill?.command ?? step.skillId}</code>
                    </li>
                  );
                })}
              </ol>
              <footer>
                <Button
                  disabled={!canRun}
                  onClick={() => setRunningWorkflow(workflow)}
                  size="small"
                  variant="primary"
                >
                  <Play size={13} />
                  运行
                </Button>
                <Button
                  aria-label={`删除 ${workflow.name}`}
                  disabled={!canManage}
                  onClick={() => {
                    if (!window.confirm(`确定删除 Workflow“${workflow.name}”吗？`)) return;
                    void deleteWorkflow(transport, workflow.id)
                      .then(() => {
                        pushToast({ kind: 'success', title: 'Workflow 已删除' });
                      })
                      .catch((deleteError: unknown) => {
                        pushToast({
                          kind: 'error',
                          title: 'Workflow 删除失败',
                          description:
                            deleteError instanceof Error ? deleteError.message : undefined,
                        });
                      });
                  }}
                  size="small"
                  variant="ghost"
                >
                  <Trash2 size={13} />
                </Button>
              </footer>
            </article>
          ))}
        </div>
      </section>
      <InstallExtensionModal
        kind="skill"
        onClose={() => setInstallOpen(false)}
        onInstall={async (source) => {
          await install(transport, source);
          pushToast({ kind: 'success', title: 'Skill 已安装' });
        }}
        open={installOpen}
      />
      <WorkflowDesignerModal
        onClose={() => setDesignerOpen(false)}
        onSave={async (workflow) => {
          await saveWorkflow(transport, workflow);
          pushToast({ kind: 'success', title: 'Workflow 已保存' });
        }}
        open={designerOpen}
        skills={skills}
      />
      <WorkflowRunnerModal
        onClose={() => setRunningWorkflow(null)}
        onRun={(id, variables) => runWorkflow(transport, id, variables)}
        open={runningWorkflow !== null}
        skills={skills}
        workflow={runningWorkflow}
      />
    </div>
  );
}
