import { PauseCircle, Pencil, ShieldCheck, Trash2, X } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Progress } from '../../components/ui/Progress';
import { StatusDot } from '../../components/ui/StatusDot';
import { formatCurrency, formatDateTime } from '../../lib/format';
import type { Credential } from '../../types';

function quotaPercentage(used: number, limit?: number): number {
  return limit && limit > 0 ? (used / limit) * 100 : 0;
}

export function CredentialInspector({
  canManage,
  credential,
  onClose,
  onDelete,
  onEdit,
  onPause,
}: {
  canManage: boolean;
  credential: Credential;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onPause: () => void;
}): React.JSX.Element {
  const dailyRatio = quotaPercentage(credential.dailyUsed, credential.dailyLimit);
  const monthlyRatio = quotaPercentage(credential.monthlyUsed, credential.monthlyLimit);
  const formatQuota = (value: number): string =>
    credential.quotaUnit === 'usd' ? formatCurrency(value) : `${value.toLocaleString()} tokens`;

  return (
    <aside className="credential-inspector">
      <header>
        <span>
          <h2>{credential.name}</h2>
          <code>•••• {credential.lastFour}</code>
        </span>
        <IconButton label="关闭详情" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>
      <section>
        <h3>健康状态</h3>
        <dl className="inspector-list">
          <div>
            <dt>当前状态</dt>
            <dd>
              <StatusDot
                label={
                  credential.status === 'healthy'
                    ? '正常'
                    : credential.status === 'warning'
                      ? '接近额度'
                      : credential.status === 'error'
                        ? '不可用'
                        : '未知'
                }
                status={credential.status}
              />
            </dd>
          </div>
          <div>
            <dt>上次检查</dt>
            <dd>{credential.lastCheckedAt ? formatDateTime(credential.lastCheckedAt) : '从未'}</dd>
          </div>
          <div>
            <dt>厂商</dt>
            <dd>{credential.provider}</dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>额度设置</h3>
        <div className="quota-detail">
          <span>
            <strong>今日额度</strong>
            <code>
              {formatQuota(credential.dailyUsed)} /{' '}
              {credential.dailyLimit ? formatQuota(credential.dailyLimit) : '未设置'}
            </code>
          </span>
          <Progress
            tone={dailyRatio >= 100 ? 'danger' : dailyRatio >= 80 ? 'warning' : 'default'}
            value={dailyRatio}
          />
        </div>
        <div className="quota-detail">
          <span>
            <strong>月度额度</strong>
            <code>
              {formatQuota(credential.monthlyUsed)} /{' '}
              {credential.monthlyLimit ? formatQuota(credential.monthlyLimit) : '未设置'}
            </code>
          </span>
          <Progress
            tone={monthlyRatio >= 100 ? 'danger' : monthlyRatio >= 80 ? 'warning' : 'default'}
            value={monthlyRatio}
          />
        </div>
      </section>
      <section>
        <h3>路由策略</h3>
        <dl className="inspector-list">
          <div>
            <dt>策略类型</dt>
            <dd>
              {credential.strategy === 'round-robin'
                ? '轮询'
                : credential.strategy === 'priority'
                  ? `优先级 ${credential.priority}`
                  : '主备'}
            </dd>
          </div>
          <div>
            <dt>失败回退</dt>
            <dd>自动排除并冷却</dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>HTTP 代理</h3>
        <dl className="inspector-list">
          <div>
            <dt>代理类型</dt>
            <dd>
              {credential.proxyMode === 'direct'
                ? '直连'
                : credential.proxyMode === 'local'
                  ? '本地'
                  : 'HTTP 代理'}
            </dd>
          </div>
        </dl>
      </section>
      <section className="credential-inspector__audit">
        <ShieldCheck size={16} />
        <span>
          <strong>安全边界</strong>
          <small>密钥明文永不发送到渲染进程，也不会出现在日志中。</small>
        </span>
      </section>
      <footer>
        <Button disabled={!canManage} onClick={onEdit} variant="secondary">
          <Pencil size={15} />
          编辑
        </Button>
        <Button disabled={!canManage} onClick={onPause} variant="secondary">
          <PauseCircle size={15} />
          {credential.enabled ? '暂停密钥' : '恢复密钥'}
        </Button>
        <Button disabled={!canManage} onClick={onDelete} variant="danger">
          <Trash2 size={15} />
          删除
        </Button>
      </footer>
    </aside>
  );
}
