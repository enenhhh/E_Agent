import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Coins,
  ExternalLink,
  FolderTree,
  GitBranch,
  KeyRound,
  PlugZap,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../components/ui/Button';
import { useTransport } from '../../context/TransportContext';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';

export const TUTORIAL_VERSION = 3;

const tutorialSteps = [
  {
    actionLabel: '配置 API Key',
    actionPath: '/credentials',
    description: '先添加模型厂商的 API Key。密钥会加密保存在当前设备，E Agent 不会把明文写入日志。',
    eyebrow: '连接模型',
    icon: KeyRound,
    points: ['同一厂商可配置多个 Key', '可设置优先级、配额与独立代理', '健康状态会自动更新'],
    preview: {
      label: '密钥状态',
      primary: '已加密 · 本机保存',
      secondary: '健康检查会在后台运行',
    },
    title: '从一枚安全的密钥开始',
  },
  {
    actionLabel: '查看模型',
    actionPath: '/models',
    description:
      'E Agent 会自动发现可用模型并识别代码、视觉与工具调用能力。你可以为不同场景选择不同默认模型。',
    eyebrow: '选择模型',
    icon: Bot,
    points: ['按厂商与能力自动归类', '支持 2–4 个模型并排比较', '代码、聊天与摘要可独立设置'],
    preview: {
      label: '推荐路由',
      primary: '@code → 代码模型',
      secondary: '@chat → 通用对话模型',
    },
    title: '让每类任务使用合适的模型',
  },
  {
    actionLabel: '进入工作台',
    actionPath: '/workspace',
    description:
      '会话可以绑定一个本地工作区。通过 @file、@folder 或 @web 精确添加上下文，避免把整个项目无差别发送给模型。',
    eyebrow: '提供上下文',
    icon: FolderTree,
    points: [
      '项目记忆按工作区隔离',
      '随时查看每类上下文的 Token 占比',
      '文件修改先展示 Diff 再确认',
    ],
    preview: {
      label: '上下文预算',
      primary: '18,420 / 128,000 tokens',
      secondary: '文件 42% · 历史 35% · 系统 23%',
    },
    title: '只加载解决问题所需的上下文',
  },
  {
    actionLabel: '浏览 Skills',
    actionPath: '/skills',
    description:
      'Skill 是可复用的专业工作流。你可以直接运行内置 Skill，也可以把代码审查、测试生成和部署串成 Workflow。',
    eyebrow: '扩展能力',
    icon: WandSparkles,
    points: [
      '内置审查、文档、测试与部署能力',
      '可从本地或 Git 仓库安装',
      '插件权限在启用前清晰展示',
    ],
    preview: {
      label: '示例工作流',
      primary: 'code-review → test-gen',
      secondary: '每一步都有独立输入与结果',
    },
    title: '把重复工作沉淀为 Skill',
  },
  {
    actionLabel: '配置工具与 MCP',
    actionPath: '/settings',
    description:
      '桌面端可以读取工作区、运行受控命令、访问隔离浏览器，并连接本地或远程 MCP Server。所有结果都会以可折叠卡片保留在对话中。',
    eyebrow: '连接工具',
    icon: PlugZap,
    points: [
      '只读工具可按策略自动执行',
      '命令、电脑与外部 MCP 操作先确认',
      '浏览器默认阻断私网、下载与凭据会话',
    ],
    preview: {
      label: '工具目录',
      primary: 'Workspace · Browser · Computer',
      secondary: 'MCP Server 工具会自动发现',
    },
    title: '把模型连接到可审计的真实工具',
  },
  {
    actionLabel: '试用消息操作',
    actionPath: '/workspace',
    description:
      '将鼠标移到消息上，或用键盘聚焦消息，即可复制、重试、评价、编辑后重发，或从任意稳定位置开启新对话。',
    eyebrow: '驾驭对话',
    icon: GitBranch,
    points: [
      '重试会保留原回答，并可用箭头切换版本',
      '编辑与分支不覆盖原会话',
      '删除先建自动快照，文件和命令副作用不会回滚',
      '生成期间可继续输入并管理下一轮队列',
    ],
    preview: {
      label: '回答操作',
      primary: '复制 · 重试 · 2 / 3 · 更多',
      secondary: 'Ctrl R 输入历史 · Esc 停止生成',
    },
    title: '像使用 Codex 一样探索不同解法',
  },
  {
    actionLabel: '查看成本中心',
    actionPath: '/costs',
    description:
      '每次请求都会记录 Token、成本与耗时。涉及文件写入或本机命令的工具会单独展示，并按你的策略请求确认。',
    eyebrow: '保持可控',
    icon: ShieldCheck,
    points: ['推理过程可折叠或隐藏', '危险工具默认执行前询问', '成本阈值、超时与输出上限可配置'],
    preview: {
      label: '安全策略',
      primary: '工具执行：始终询问',
      secondary: '今日成本提醒：$5.00',
    },
    title: '看得见成本，也掌握每次执行',
  },
] as const;

export function TutorialPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { transport } = useTransport();
  const updateSettings = useSettingsStore((state) => state.update);
  const pushToast = useToastStore((state) => state.push);
  const [activeStep, setActiveStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = tutorialSteps[activeStep] ?? tutorialSteps[0];
  const StepIcon = step.icon;
  const isLastStep = activeStep === tutorialSteps.length - 1;
  const progress = ((activeStep + 1) / tutorialSteps.length) * 100;

  const completeTutorial = async (): Promise<void> => {
    setFinishing(true);
    setError(null);
    try {
      await updateSettings(transport, { tutorialCompletedVersion: TUTORIAL_VERSION });
      pushToast({
        kind: 'success',
        title: '准备完成',
        description: '欢迎使用 E Agent，你可以随时从左侧重新打开教程。',
      });
      navigate('/workspace', { replace: true });
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : '教程状态保存失败。');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="page tutorial-page">
      <header className="tutorial-page__header">
        <span className="tutorial-page__brand">
          <span>
            <Sparkles aria-hidden size={17} />
          </span>
          <span>
            <strong>E Agent 快速上手</strong>
            <small>约 3 分钟 · 随时可以回来查看</small>
          </span>
        </span>
        <Button
          disabled={finishing}
          onClick={() => void completeTutorial()}
          size="small"
          variant="ghost"
        >
          跳过教程
        </Button>
      </header>

      <div className="tutorial-page__progress" aria-label="教程进度">
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="tutorial-layout">
        <nav aria-label="教程步骤" className="tutorial-steps">
          {tutorialSteps.map((candidate, index) => {
            const Icon = candidate.icon;
            const completed = index < activeStep;
            return (
              <button
                aria-current={index === activeStep ? 'step' : undefined}
                className={index === activeStep ? 'is-active' : completed ? 'is-completed' : ''}
                key={candidate.eyebrow}
                onClick={() => setActiveStep(index)}
                type="button"
              >
                <span className="tutorial-steps__number">
                  {completed ? <Check aria-hidden size={13} /> : index + 1}
                </span>
                <span>
                  <strong>{candidate.eyebrow}</strong>
                  <small>{candidate.title}</small>
                </span>
                <Icon aria-hidden size={16} />
              </button>
            );
          })}
        </nav>

        <main className="tutorial-stage">
          <section className="tutorial-stage__copy">
            <span className="tutorial-stage__icon">
              <StepIcon aria-hidden size={25} />
            </span>
            <span className="tutorial-stage__eyebrow">
              第 {activeStep + 1} 步，共 {tutorialSteps.length} 步 · {step.eyebrow}
            </span>
            <h1>{step.title}</h1>
            <p>{step.description}</p>
            <ul>
              {step.points.map((point) => (
                <li key={point}>
                  <CheckCircle2 aria-hidden size={15} />
                  {point}
                </li>
              ))}
            </ul>
            <Button
              onClick={() =>
                navigate(step.actionPath, {
                  state: step.actionPath === '/workspace' ? { tutorialPreview: true } : undefined,
                })
              }
              size="small"
              variant="secondary"
            >
              {step.actionLabel}
              <ExternalLink aria-hidden size={13} />
            </Button>
          </section>

          <aside className="tutorial-preview" aria-label={`${step.eyebrow}示例`}>
            <span className="tutorial-preview__glow" />
            <header>
              <span>
                <i />
                <i />
                <i />
              </span>
              <small>E Agent / {step.eyebrow}</small>
            </header>
            <div className="tutorial-preview__canvas">
              <span className="tutorial-preview__icon">
                <StepIcon aria-hidden size={28} />
              </span>
              <small>{step.preview.label}</small>
              <strong>{step.preview.primary}</strong>
              <p>{step.preview.secondary}</p>
              {isLastStep ? (
                <div className="tutorial-preview__metrics">
                  <span>
                    <Coins aria-hidden size={14} />
                    成本可追踪
                  </span>
                  <span>
                    <ShieldCheck aria-hidden size={14} />
                    执行可确认
                  </span>
                </div>
              ) : (
                <div className="tutorial-preview__lines" aria-hidden>
                  <i />
                  <i />
                  <i />
                </div>
              )}
            </div>
          </aside>
        </main>
      </div>

      <footer className="tutorial-page__footer">
        <Button
          disabled={activeStep === 0 || finishing}
          onClick={() => setActiveStep((value) => Math.max(0, value - 1))}
          variant="ghost"
        >
          <ArrowLeft aria-hidden size={15} />
          上一步
        </Button>
        <span>
          {tutorialSteps.map((candidate, index) => (
            <button
              aria-label={`前往第 ${index + 1} 步：${candidate.eyebrow}`}
              className={index === activeStep ? 'is-active' : ''}
              key={candidate.eyebrow}
              onClick={() => setActiveStep(index)}
              type="button"
            />
          ))}
        </span>
        {isLastStep ? (
          <Button loading={finishing} onClick={() => void completeTutorial()} variant="primary">
            完成并进入工作台
            <ArrowRight aria-hidden size={15} />
          </Button>
        ) : (
          <Button
            disabled={finishing}
            onClick={() => setActiveStep((value) => Math.min(tutorialSteps.length - 1, value + 1))}
            variant="primary"
          >
            下一步
            <ArrowRight aria-hidden size={15} />
          </Button>
        )}
      </footer>

      {error ? (
        <p className="tutorial-page__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
