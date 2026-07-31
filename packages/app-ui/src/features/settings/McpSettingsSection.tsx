import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';
import { useToastStore } from '../../stores/toast-store';
import type { McpServerInput, McpServerState, McpServerSummary } from '../../types';

const stateCopy: Record<McpServerState, string> = {
  disabled: '已停用',
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '连接失败',
};

function StateIcon({ state }: { state: McpServerState }): React.JSX.Element {
  if (state === 'connected') return <CircleCheck aria-hidden size={14} />;
  if (state === 'error') return <CircleAlert aria-hidden size={14} />;
  return <CircleDashed aria-hidden size={14} />;
}

function parseArguments(value: string): string[] {
  if (!value.trim()) return [];
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.length > 64 ||
    !decoded.every((item) => typeof item === 'string' && item.length <= 4_096)
  ) {
    throw new Error('stdio 参数必须是最多 64 项的字符串 JSON 数组。');
  }
  return decoded;
}

function parseSecretMap(value: string, label: string): Record<string, string> {
  if (!value.trim()) return {};
  const decoded: unknown = JSON.parse(value);
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    Object.keys(decoded).length > 64 ||
    !Object.values(decoded).every((item) => typeof item === 'string' && item.length <= 32_768)
  ) {
    throw new Error(`${label}必须是最多 64 项、值均为字符串的 JSON 对象。`);
  }
  return decoded as Record<string, string>;
}

export function McpSettingsSection(): React.JSX.Element {
  const { mode, transport } = useTransport();
  const role = useAuthStore((state) => state.session?.user.role);
  const pushToast = useToastStore((state) => state.push);
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [loading, setLoading] = useState(mode === 'desktop');
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [transportType, setTransportType] = useState<McpServerInput['transport']>('stdio');
  const [displayName, setDisplayName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [environmentJson, setEnvironmentJson] = useState('');
  const [url, setUrl] = useState('');
  const [headersJson, setHeadersJson] = useState('');
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const canManage = role === 'owner' || role === 'admin';

  const reload = useCallback(
    async (silent = false): Promise<void> => {
      if (mode !== 'desktop') return;
      if (!silent) setLoading(true);
      try {
        setServers(await transport.listMcpServers());
      } catch (error) {
        pushToast({
          kind: 'error',
          title: 'MCP Server 读取失败',
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    },
    [mode, pushToast, transport],
  );

  useEffect(() => {
    void reload();
    if (mode !== 'desktop') return undefined;
    const timer = window.setInterval(() => void reload(true), 15_000);
    return () => window.clearInterval(timer);
  }, [mode, reload]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      const input: McpServerInput =
        transportType === 'stdio'
          ? {
              displayName,
              transport: 'stdio',
              command,
              args: parseArguments(args),
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(environmentJson.trim()
                ? { env: parseSecretMap(environmentJson, '环境变量') }
                : {}),
              inheritEnv: false,
            }
          : {
              displayName,
              transport: 'streamable-http',
              url,
              ...(headersJson.trim()
                ? { headers: parseSecretMap(headersJson, 'HTTP Headers') }
                : {}),
            };
      await transport.saveMcpServer(input);
      setDisplayName('');
      setCommand('');
      setArgs('');
      setCwd('');
      setEnvironmentJson('');
      setUrl('');
      setHeadersJson('');
      setRiskAcknowledged(false);
      setShowForm(false);
      await reload();
      pushToast({ kind: 'success', title: 'MCP Server 已保存' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'MCP Server 保存失败',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (server: McpServerSummary, enabled: boolean): Promise<void> => {
    try {
      const updated = await transport.setMcpServerEnabled(server.id, enabled);
      setServers((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (error) {
      pushToast({
        kind: 'error',
        title: enabled ? 'MCP Server 启用失败' : 'MCP Server 停用失败',
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const refresh = async (server: McpServerSummary): Promise<void> => {
    try {
      const updated = await transport.refreshMcpServer(server.id);
      setServers((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      pushToast({
        kind: 'success',
        title: 'MCP 工具已刷新',
        description: `发现 ${updated.toolCount} 个工具。`,
      });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'MCP 工具刷新失败',
        description: error instanceof Error ? error.message : undefined,
      });
      await reload();
    }
  };

  const remove = async (server: McpServerSummary): Promise<void> => {
    if (!window.confirm(`移除 MCP Server「${server.displayName}」？`)) return;
    try {
      await transport.removeMcpServer(server.id);
      setServers((current) => current.filter((candidate) => candidate.id !== server.id));
      pushToast({ kind: 'success', title: 'MCP Server 已移除' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'MCP Server 移除失败',
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <section className="settings-section settings-section--wide mcp-settings">
      <header>
        <Server aria-hidden size={18} />
        <span>
          <h3>MCP Server</h3>
          <p>连接标准 MCP 服务，自动发现工具并纳入统一审批、日志和结果卡片。</p>
        </span>
        {mode === 'desktop' ? (
          <Button
            disabled={!canManage}
            onClick={() => setShowForm((value) => !value)}
            size="small"
            title={canManage ? undefined : '仅 Owner/Admin 可管理 MCP Server'}
          >
            <Plus aria-hidden size={14} />
            添加 Server
          </Button>
        ) : null}
      </header>

      {mode !== 'desktop' ? (
        <p className="settings-safety-note">
          <Server aria-hidden size={15} />
          MCP 进程与本地工具仅在桌面端运行；Web 协作端不会代替你的设备连接 Server。
        </p>
      ) : (
        <>
          {!canManage ? (
            <p className="settings-safety-note">
              <ShieldAlert aria-hidden size={15} />
              当前角色只能查看 MCP 状态；仅 Owner/Admin 可添加、启用、刷新或移除 Server。
            </p>
          ) : null}
          {showForm ? (
            <form className="mcp-settings__form" onSubmit={(event) => void submit(event)}>
              <Field
                autoComplete="off"
                label="显示名称"
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如：项目知识库"
                required
                value={displayName}
              />
              <label className="mcp-settings__select">
                <span>连接方式</span>
                <Select
                  onChange={(event) =>
                    setTransportType(event.target.value as McpServerInput['transport'])
                  }
                  value={transportType}
                >
                  <option value="stdio">本地进程（stdio）</option>
                  <option value="streamable-http">远程服务（Streamable HTTP）</option>
                </Select>
              </label>
              {transportType === 'stdio' ? (
                <>
                  <Field
                    autoComplete="off"
                    description="直接启动可执行文件，不通过 shell；Windows 下 npm/npx/pnpm/yarn 会解析到 Node CLI。"
                    label="启动命令"
                    maxLength={2_048}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="npx"
                    required
                    value={command}
                  />
                  <Field
                    autoComplete="off"
                    description="字符串 JSON 数组；参数不会作为 shell 字符串拼接。"
                    label="参数（JSON 数组）"
                    onChange={(event) => setArgs(event.target.value)}
                    placeholder={'["-y","@modelcontextprotocol/server-filesystem","D:\\\\project"]'}
                    value={args}
                  />
                  <Field
                    autoComplete="off"
                    description="留空时使用 E Agent 的安全运行目录。"
                    label="工作目录（可选）"
                    maxLength={2_048}
                    onChange={(event) => setCwd(event.target.value)}
                    value={cwd}
                  />
                  <Field
                    autoComplete="off"
                    description='例如 {"API_TOKEN":"…"}。整份 MCP 配置使用系统密钥环与 AES-256-GCM 加密，保存后不回显。'
                    label="环境变量（加密，可选）"
                    onChange={(event) => setEnvironmentJson(event.target.value)}
                    type="password"
                    value={environmentJson}
                  />
                </>
              ) : (
                <>
                  <Field
                    autoComplete="off"
                    description="远程地址必须使用 HTTPS；仅 localhost 可使用 HTTP。不要把 Token 放入 URL。"
                    label="Server URL"
                    maxLength={2_048}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    required
                    type="url"
                    value={url}
                  />
                  <Field
                    autoComplete="off"
                    description='例如 {"Authorization":"Bearer …"}。配置会加密存储且不会显示在列表或日志中。'
                    label="HTTP Headers（加密，可选）"
                    onChange={(event) => setHeadersJson(event.target.value)}
                    type="password"
                    value={headersJson}
                  />
                </>
              )}
              {transportType === 'stdio' ? (
                <label className="mcp-settings__risk">
                  <input
                    checked={riskAcknowledged}
                    onChange={(event) => setRiskAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    我了解：保存会立即启动上述程序。MCP Server 不在 OS 沙箱中，会继承当前用户权限，
                    即使尚未批准某个工具，也可能自行读取文件或联网。
                  </span>
                </label>
              ) : (
                <p className="mcp-settings__risk">
                  远程 MCP Server 属于不可信外部服务；所有工具仍需逐次审批，请勿发送无关敏感数据。
                </p>
              )}
              <div className="mcp-settings__form-actions">
                <p>命令参数会保存在加密配置中；环境变量默认不继承。</p>
                <Button disabled={saving} onClick={() => setShowForm(false)} variant="ghost">
                  取消
                </Button>
                <Button
                  disabled={!canManage || (transportType === 'stdio' && !riskAcknowledged)}
                  loading={saving}
                  type="submit"
                  variant="primary"
                >
                  保存并连接
                </Button>
              </div>
            </form>
          ) : null}

          {loading ? (
            <p className="mcp-settings__empty">正在读取 MCP Server…</p>
          ) : servers.length === 0 ? (
            <p className="mcp-settings__empty">
              尚未配置 MCP Server。你仍可使用内置工作区、电脑与浏览器工具。
            </p>
          ) : (
            <div className="mcp-settings__list">
              {servers.map((server) => (
                <article className="mcp-server" key={server.id}>
                  <span className={`mcp-server__state mcp-server__state--${server.state}`}>
                    <StateIcon state={server.state} />
                  </span>
                  <span className="mcp-server__copy">
                    <span>
                      <strong>{server.displayName}</strong>
                      <code>{server.transport}</code>
                      <small>{stateCopy[server.state]}</small>
                    </span>
                    <span title={server.endpoint}>{server.endpoint}</span>
                    <small>
                      {server.toolCount === 0
                        ? '尚未发现工具'
                        : `${server.toolCount} 个工具 · ${server.tools.slice(0, 4).join(' · ')}${
                            server.tools.length > 4 ? ' …' : ''
                          }`}
                      {server.hasCredentials ? ' · 凭据已加密' : ''}
                    </small>
                    {server.lastError ? <em>{server.lastError}</em> : null}
                  </span>
                  <span className="mcp-server__actions">
                    <Button
                      aria-label={`刷新 ${server.displayName}`}
                      disabled={!canManage}
                      onClick={() => void refresh(server)}
                      size="small"
                      variant="ghost"
                    >
                      <RefreshCw aria-hidden size={13} />
                    </Button>
                    <Switch
                      checked={server.enabled}
                      disabled={!canManage}
                      label={`${server.displayName} · ${server.enabled ? '已启用' : '已停用'}`}
                      onChange={(enabled) => void setEnabled(server, enabled)}
                    />
                    <Button
                      aria-label={`移除 ${server.displayName}`}
                      disabled={!canManage}
                      onClick={() => void remove(server)}
                      size="small"
                      variant="danger"
                    >
                      <Trash2 aria-hidden size={13} />
                    </Button>
                  </span>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
