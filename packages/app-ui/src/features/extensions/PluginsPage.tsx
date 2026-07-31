import { PackagePlus, Puzzle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
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

import { InstallExtensionModal } from './InstallExtensionModal';

export function PluginsPage(): React.JSX.Element {
  const { transport } = useTransport();
  const plugins = useExtensionStore((state) => state.plugins);
  const loading = useExtensionStore((state) => state.loading);
  const error = useExtensionStore((state) => state.error);
  const load = useExtensionStore((state) => state.loadPlugins);
  const approve = useExtensionStore((state) => state.approvePlugin);
  const toggle = useExtensionStore((state) => state.togglePlugin);
  const install = useExtensionStore((state) => state.installPlugin);
  const uninstall = useExtensionStore((state) => state.uninstallPlugin);
  const role = useAuthStore((state) => state.session?.user.role);
  const pushToast = useToastStore((state) => state.push);
  const [installOpen, setInstallOpen] = useState(false);
  const canManage = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  const remove = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`卸载“${name}”？插件数据会保留用于审计。`)) {
      return;
    }
    try {
      await uninstall(transport, id);
      pushToast({ kind: 'success', title: '插件已卸载' });
    } catch (uninstallError) {
      pushToast({
        kind: 'error',
        title: '插件卸载失败',
        description: uninstallError instanceof Error ? uninstallError.message : undefined,
      });
    }
  };

  return (
    <div className="page page--extensions">
      <header className="page-header">
        <span>
          <h2>插件管理</h2>
          <p>插件在独立宿主中运行，所有文件、网络与环境变量访问均需显式授权。</p>
        </span>
        <Button disabled={!isOwner} onClick={() => setInstallOpen(true)} variant="primary">
          <PackagePlus size={15} />
          安装插件
        </Button>
      </header>
      <div className="security-note">
        <ShieldCheck size={17} />
        <span>
          <strong>默认拒绝权限</strong>
          <small>插件升级、内容哈希变化或工作区变化时会要求重新授权。</small>
        </span>
      </div>
      {loading ? <LoadingState label="正在与插件宿主通信…" /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load(transport)} /> : null}
      {!loading && !error && plugins.length === 0 ? (
        <EmptyState
          action={
            <Button disabled={!isOwner} onClick={() => setInstallOpen(true)} variant="primary">
              安装插件
            </Button>
          }
          description="可以从 Git URL 或本地目录安装 Provider、Tool、Hook 与声明式 UI 扩展。"
          icon={<Puzzle size={28} />}
          title="没有安装插件"
        />
      ) : null}
      <div className="extension-list">
        {plugins.map((plugin) => (
          <article className="extension-row extension-row--plugin" key={plugin.id}>
            <span className="extension-row__icon">
              <Puzzle size={20} />
            </span>
            <span className="extension-row__copy">
              <span>
                <strong>{plugin.name}</strong>
                <code>v{plugin.version}</code>
                {plugin.updateAvailable ? (
                  <button
                    className="extension-update"
                    disabled={!isOwner}
                    onClick={() => {
                      setInstallOpen(true);
                      pushToast({
                        kind: 'info',
                        title: `更新 ${plugin.name}`,
                        description: '请重新选择原本地目录或粘贴 Git URL；替换后需重新授权。',
                      });
                    }}
                    type="button"
                  >
                    <RefreshCw size={12} /> 更新至 {plugin.updateAvailable}
                  </button>
                ) : null}
              </span>
              <p>{plugin.description}</p>
              <small>
                {plugin.types.join(' / ')} · 权限：
                {plugin.permissions.length ? plugin.permissions.join('、') : '无'}
              </small>
              <code className="extension-source">{plugin.source}</code>
            </span>
            <span className="extension-row__controls">
              <Button
                disabled={plugin.approved ? !canManage : !isOwner}
                onClick={() => {
                  const action = plugin.approved ? '撤销' : '授权';
                  if (
                    !plugin.approved &&
                    !window.confirm(
                      `确认授权“${plugin.name}”？\n\n${
                        plugin.permissions
                          .filter((permission) => permission !== '待授权')
                          .join('\n') || '该插件未申请额外宿主权限。'
                      }`,
                    )
                  ) {
                    return;
                  }
                  void approve(transport, plugin.id, !plugin.approved)
                    .then(() =>
                      pushToast({
                        kind: 'success',
                        title: `插件权限已${action}`,
                      }),
                    )
                    .catch((approvalError: unknown) =>
                      pushToast({
                        kind: 'error',
                        title: `插件${action}失败`,
                        description:
                          approvalError instanceof Error ? approvalError.message : undefined,
                      }),
                    );
                }}
                size="small"
                variant={plugin.approved ? 'ghost' : 'primary'}
              >
                <ShieldCheck size={14} />
                {plugin.approved ? '撤销授权' : '审查并授权'}
              </Button>
              <Switch
                checked={plugin.enabled}
                disabled={!plugin.approved || !canManage}
                label={plugin.enabled ? '已启用' : '已停用'}
                onChange={(enabled) => {
                  void toggle(transport, plugin.id, enabled).catch((toggleError: unknown) => {
                    pushToast({
                      kind: 'error',
                      title: '插件状态更新失败',
                      description: toggleError instanceof Error ? toggleError.message : undefined,
                    });
                  });
                }}
              />
              <Button
                disabled={!isOwner}
                onClick={() => void remove(plugin.id, plugin.name)}
                size="small"
                variant="ghost"
              >
                <Trash2 size={14} />
                卸载
              </Button>
            </span>
          </article>
        ))}
      </div>
      <InstallExtensionModal
        kind="plugin"
        onClose={() => setInstallOpen(false)}
        onInstall={async (source) => {
          await install(transport, source);
          pushToast({ kind: 'success', title: '插件已安装，等待权限确认' });
        }}
        open={installOpen && isOwner}
      />
    </div>
  );
}
