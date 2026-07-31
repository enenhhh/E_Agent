import {
  Bell,
  Bot,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  Gauge,
  Keyboard,
  Languages,
  Palette,
  RefreshCw,
  Shield,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { keyboardShortcuts, themes } from '../../config';
import { useI18n } from '../../context/I18nContext';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';
import { modelProviderId, modelProviderName, useModelStore } from '../../stores/model-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';
import type { AppSettings, Locale } from '../../types';

import { McpSettingsSection } from './McpSettingsSection';

type DefaultModelScene = 'code' | 'chat' | 'summarize';

const shortcutLabels: Record<keyof typeof keyboardShortcuts, string> = {
  send: '发送消息',
  inputHistory: '输入历史',
  stop: '停止生成',
  newConversation: '新建会话',
  search: '快速搜索',
  toggleSidebar: '切换侧栏',
};

function DefaultModelControl({
  disabled,
  models,
  onSave,
  scene,
  value,
}: {
  disabled: boolean;
  models: ReturnType<typeof useModelStore.getState>['models'];
  onSave: (modelId: string) => void;
  scene: DefaultModelScene;
  value: string;
}): React.JSX.Element {
  const selectedModel = models.find((model) => model.id === value);
  const providers = useMemo(
    () =>
      Array.from(
        new Map(
          models.map((model) => [
            modelProviderId(model),
            { id: modelProviderId(model), name: modelProviderName(model) },
          ]),
        ).values(),
      ).sort((left, right) => left.name.localeCompare(right.name)),
    [models],
  );
  const [providerId, setProviderId] = useState(
    selectedModel ? modelProviderId(selectedModel) : (providers[0]?.id ?? ''),
  );

  useEffect(() => {
    setProviderId((currentProviderId) => {
      if (selectedModel) {
        return modelProviderId(selectedModel);
      }
      return providers.some((provider) => provider.id === currentProviderId)
        ? currentProviderId
        : (providers[0]?.id ?? '');
    });
  }, [providers, selectedModel]);

  const providerModels = models.filter((model) => modelProviderId(model) === providerId);
  const modelValue = providerModels.some((model) => model.id === value) ? value : '';
  const label = scene === 'code' ? '@code' : scene === 'chat' ? '@chat' : '上下文压缩';

  return (
    <div className="setting-control setting-control--model-route">
      <span>
        <strong>{label}</strong>
        <small>{scene === 'summarize' ? '建议使用低成本模型' : '默认对话模型'}</small>
      </span>
      <span className="setting-control__cascade">
        <Select
          aria-label={`${label} 服务商`}
          disabled={disabled || providers.length === 0}
          onChange={(event) => {
            const nextProviderId = event.target.value;
            setProviderId(nextProviderId);
            const firstAvailableModel = models.find(
              (model) => modelProviderId(model) === nextProviderId && model.available,
            );
            if (firstAvailableModel) {
              onSave(firstAvailableModel.id);
            }
          }}
          value={providerId}
        >
          {providers.length === 0 ? <option value="">暂无服务商</option> : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label={`${label} 模型`}
          disabled={disabled || !providerModels.some((model) => model.available)}
          onChange={(event) => onSave(event.target.value)}
          value={modelValue}
        >
          <option value="">未设置</option>
          {providerModels.map((model) => (
            <option disabled={!model.available} key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </Select>
      </span>
    </div>
  );
}

export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { mode, transport } = useTransport();
  const { locale, setLocale } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const role = useAuthStore((state) => state.session?.user.role);
  const update = useSettingsStore((state) => state.update);
  const models = useModelStore((state) => state.models);
  const pushToast = useToastStore((state) => state.push);
  const [checks, setChecks] = useState<Array<{ name: string; ok: boolean; message: string }>>([]);
  const [checking, setChecking] = useState(false);
  const canManageSettings = role === 'owner' || role === 'admin';

  const currentTheme = useMemo(
    () => themes.find((theme) => theme.id === settings.theme),
    [settings.theme],
  );

  const save = async (input: Partial<AppSettings>): Promise<void> => {
    try {
      await update(transport, input);
      if (input.locale) {
        setLocale(input.locale);
      }
      pushToast({ kind: 'success', title: '设置已保存' });
    } catch (saveError) {
      pushToast({
        kind: 'error',
        title: '设置保存失败',
        description: saveError instanceof Error ? saveError.message : undefined,
      });
    }
  };

  const startupCheck = async (): Promise<void> => {
    setChecking(true);
    try {
      setChecks(await transport.runStartupCheck());
    } catch (checkError) {
      pushToast({
        kind: 'error',
        title: '启动自检失败',
        description: checkError instanceof Error ? checkError.message : undefined,
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page page--settings">
      <header className="page-header">
        <span>
          <h2>设置</h2>
          <p>跨端同步可共享设置；密钥、代理与本地工作区仍保持设备隔离。</p>
        </span>
      </header>
      <div className="settings-layout">
        <section className="settings-section">
          <header>
            <Palette size={18} />
            <span>
              <h3>外观与语言</h3>
              <p>当前主题：{locale === 'zh-CN' ? currentTheme?.labelZh : currentTheme?.labelEn}</p>
            </span>
          </header>
          <div className="theme-grid">
            {themes.map((theme) => (
              <button
                className={settings.theme === theme.id ? 'is-selected' : ''}
                disabled={!canManageSettings}
                key={theme.id}
                onClick={() => {
                  void save({ theme: theme.id });
                }}
                type="button"
              >
                <span className={`theme-preview theme-preview--${theme.id}`}>
                  <i />
                  <i />
                  <i />
                </span>
                <span>{locale === 'zh-CN' ? theme.labelZh : theme.labelEn}</span>
                {settings.theme === theme.id ? <CheckCircle2 size={14} /> : null}
              </button>
            ))}
          </div>
          <label className="setting-control">
            <span>
              <Languages size={16} />
              <strong>界面语言</strong>
            </span>
            <Select
              disabled={!canManageSettings}
              onChange={(event) => void save({ locale: event.target.value as Locale })}
              value={settings.locale}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
          </label>
        </section>
        <McpSettingsSection />
        <section className="settings-section">
          <header>
            <Bot size={18} />
            <span>
              <h3>默认模型组</h3>
              <p>按场景路由到不同模型；不可用时由 Key 池策略回退。</p>
            </span>
          </header>
          {(['code', 'chat', 'summarize'] as const).map((scene) => (
            <DefaultModelControl
              disabled={!canManageSettings}
              key={scene}
              models={models}
              onSave={(modelId) => {
                const latestSettings = useSettingsStore.getState().settings;
                void save({
                  defaultModels: { ...latestSettings.defaultModels, [scene]: modelId },
                });
              }}
              scene={scene}
              value={settings.defaultModels[scene] ?? ''}
            />
          ))}
        </section>
        <section className="settings-section">
          <header>
            <Gauge size={18} />
            <span>
              <h3>性能与成本</h3>
              <p>限制并发请求，并在到达预算前发出本地通知。</p>
            </span>
          </header>
          <div className="setting-fields">
            <Field
              label="最大并发请求"
              max={20}
              min={1}
              disabled={!canManageSettings}
              onBlur={(event) => void save({ maxConcurrency: Number(event.target.value) })}
              type="number"
              defaultValue={settings.maxConcurrency}
            />
            <Field
              label="今日成本预警（USD）"
              min={0.01}
              disabled={!canManageSettings}
              onBlur={(event) => void save({ costAlertThreshold: Number(event.target.value) })}
              step="0.01"
              type="number"
              defaultValue={settings.costAlertThreshold}
            />
          </div>
          <Switch
            checked={settings.autoCompressContext}
            description="达到上下文窗口 70% 时，用默认摘要模型压缩旧消息。"
            disabled={!canManageSettings}
            label="自动压缩上下文"
            onChange={(autoCompressContext) => void save({ autoCompressContext })}
          />
          <Switch
            checked={false}
            description="即将开放：云端 API 不可用时切换到本地模型。当前版本不会保存此选项。"
            disabled
            label="Ollama 离线兜底（即将开放）"
            onChange={() => undefined}
          />
        </section>
        <section className="settings-section settings-section--wide">
          <header>
            <BrainCircuit size={18} />
            <span>
              <h3>推理与工具执行</h3>
              <p>控制思考过程的展示方式，以及工具何时可以在当前工作区运行。</p>
            </span>
          </header>
          <div className="settings-tool-grid">
            <label className="setting-control">
              <span>
                <strong>推理过程</strong>
                <small>折叠模式在生成时展开，完成后保留“已思考…”摘要；隐藏模式全程不显示。</small>
              </span>
              <Select
                aria-label="推理过程显示方式"
                disabled={!canManageSettings}
                onChange={(event) =>
                  void save({
                    reasoningDisplay: event.target.value as AppSettings['reasoningDisplay'],
                  })
                }
                value={settings.reasoningDisplay}
              >
                <option value="collapsed">完成后折叠</option>
                <option value="expanded">始终展开</option>
                <option value="hidden">始终隐藏</option>
              </Select>
            </label>
            <label className="setting-control">
              <span>
                <strong>本地工具（桌面端）</strong>
                <small>
                  {mode === 'desktop'
                    ? '只读工具可自动运行；文件写入和本机命令始终需要你的确认。'
                    : 'Web 端不能访问本机工作区或执行命令，请在桌面端配置和使用。'}
                </small>
              </span>
              <Select
                aria-label="本地工具"
                disabled={mode !== 'desktop' || !canManageSettings}
                onChange={(event) =>
                  void save({
                    toolExecutionPolicy: event.target.value as AppSettings['toolExecutionPolicy'],
                  })
                }
                value={settings.toolExecutionPolicy}
              >
                <option value="always-ask">谨慎（外部与敏感工具先确认）</option>
                <option value="allow-safe">平衡（明确只读工具可自动执行）</option>
                <option value="disabled">禁用工具</option>
              </Select>
            </label>
          </div>
          <div className="setting-fields settings-tool-limits">
            <Field
              defaultValue={Math.round(settings.toolCommandTimeoutMs / 1_000)}
              disabled={mode !== 'desktop' || !canManageSettings}
              key={`tool-timeout-${settings.toolCommandTimeoutMs}`}
              label="命令超时（秒）"
              max={300}
              min={1}
              onBlur={(event) =>
                void save({
                  toolCommandTimeoutMs:
                    Math.max(1, Math.min(300, Number(event.target.value) || 1)) * 1_000,
                })
              }
              type="number"
            />
            <Field
              defaultValue={Math.round(settings.toolOutputLimitBytes / 1_024)}
              disabled={mode !== 'desktop' || !canManageSettings}
              key={`tool-output-${settings.toolOutputLimitBytes}`}
              label="单次输出上限（KiB）"
              max={1_024}
              min={4}
              onBlur={(event) =>
                void save({
                  toolOutputLimitBytes:
                    Math.max(4, Math.min(1_024, Number(event.target.value) || 4)) * 1_024,
                })
              }
              type="number"
            />
          </div>
          <Switch
            checked={settings.autoExpandRunningTools}
            description="控制运行中卡片；等待审批与失败卡片为安全提示，会始终自动展开。"
            disabled={!canManageSettings}
            label="自动展开活跃工具"
            onChange={(autoExpandRunningTools) => void save({ autoExpandRunningTools })}
          />
          {mode !== 'desktop' ? (
            <p className="settings-safety-note">
              <TerminalSquare aria-hidden size={15} />
              本地文件读取、修改和命令执行仅在桌面端可用；Web 端不会执行这些操作。
            </p>
          ) : !canManageSettings ? (
            <p className="settings-safety-note">
              <Shield aria-hidden size={15} />
              工具安全策略由 Owner 或 Admin 管理；你仍可按当前策略使用已配置的工具。
            </p>
          ) : settings.toolExecutionPolicy !== 'disabled' ? (
            <p className="settings-safety-note">
              <TerminalSquare aria-hidden size={15} />
              命令确认不是 OS 沙箱；进程拥有当前系统用户权限，可能访问网络或工作区外资源。
            </p>
          ) : null}
        </section>
        <section className="settings-section">
          <header>
            <Bell size={18} />
            <span>
              <h3>更新与隐私</h3>
              <p>遥测默认关闭，且永不包含 Prompt、代码或密钥。</p>
            </span>
          </header>
          <Switch
            checked={settings.autoUpdate}
            description="只安装已验证签名且版本不降级的稳定频道更新。"
            disabled={!canManageSettings}
            label="自动检查更新"
            onChange={(autoUpdate) => void save({ autoUpdate })}
          />
          <Switch
            checked={false}
            description="即将开放：匿名崩溃和性能指标上报。当前版本不会收集或保存此选项。"
            disabled
            label="匿名性能遥测（即将开放）"
            onChange={() => undefined}
          />
        </section>
        <section className="settings-section settings-section--wide">
          <header>
            <Keyboard size={18} />
            <span>
              <h3>快捷键</h3>
              <p>快捷键重绑即将开放；当前版本仅展示默认映射。</p>
            </span>
          </header>
          <div className="shortcut-list">
            {Object.entries(keyboardShortcuts).map(([key, shortcut]) => (
              <div key={key}>
                <span>{shortcutLabels[key as keyof typeof keyboardShortcuts]}</span>
                <kbd>{shortcut}</kbd>
              </div>
            ))}
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <header>
            <Shield size={18} />
            <span>
              <h3>启动自检</h3>
              <p>检查运行时版本、数据库、配置可写性、插件宿主与系统密钥环。</p>
            </span>
            <Button loading={checking} onClick={() => void startupCheck()}>
              <RefreshCw size={14} />
              立即检查
            </Button>
          </header>
          {checks.length ? (
            <div className="startup-checks">
              {checks.map((check) => (
                <div className={check.ok ? 'is-ok' : 'is-warning'} key={check.name}>
                  {check.ok ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
                  <span>
                    <strong>{check.name}</strong>
                    <small>{check.message}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="setting-muted">尚未运行本次自检。</p>
          )}
          <div className="settings-tutorial-entry">
            <BookOpenCheck aria-hidden size={18} />
            <span>
              <strong>快速上手教程</strong>
              <small>
                {settings.tutorialCompletedVersion > 0
                  ? `已完成第 ${settings.tutorialCompletedVersion} 版教程。`
                  : '尚未完成首次使用教程。'}
              </small>
            </span>
            <Button onClick={() => navigate('/tutorial')} size="small" variant="secondary">
              重新打开教程
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
