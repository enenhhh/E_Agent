import {
  FileClock,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { Select } from '../../components/ui/Select';
import { useTransport } from '../../context/TransportContext';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../stores/auth-store';
import { useToastStore } from '../../stores/toast-store';
import type { AuditEntry, User } from '../../types';

import { AddMemberModal } from './AddMemberModal';

const roleMatrix = [
  ['Owner', '全部权限、密钥与团队所有权'],
  ['Admin', '成员、配置、Skill 与审计管理'],
  ['Member', '会话、模型与授权工作区操作'],
  ['Viewer', '只读访问共享会话和报表'],
] as const;

export function AdminPage(): React.JSX.Element {
  const { transport } = useTransport();
  const session = useAuthStore((state) => state.session);
  const pushToast = useToastStore((state) => state.push);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const canManage =
    transport.kind === 'http' && (session?.user.role === 'owner' || session?.user.role === 'admin');

  useEffect(() => {
    const load = async (): Promise<void> => {
      setLoading(true);
      try {
        const [nextEntries, nextMembers] = await Promise.all([
          transport.listAuditEntries(),
          transport.listUsers(),
        ]);
        setEntries(nextEntries);
        setMembers(nextMembers);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '审计日志加载失败。');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [transport]);

  const updateMember = async (
    id: string,
    input: Partial<Pick<User, 'name' | 'role' | 'active'>>,
  ): Promise<void> => {
    try {
      const updated = await transport.updateUser(id, input);
      setMembers((current) => current.map((member) => (member.id === id ? updated : member)));
      pushToast({ kind: 'success', title: '成员已更新' });
    } catch (updateError) {
      pushToast({
        kind: 'error',
        title: '成员更新失败',
        description: updateError instanceof Error ? updateError.message : undefined,
      });
    }
  };

  const deleteMember = async (member: User): Promise<void> => {
    if (!window.confirm(`确认删除成员 ${member.name}（${member.email}）？`)) {
      return;
    }
    try {
      await transport.deleteUser(member.id);
      setMembers((current) => current.filter((candidate) => candidate.id !== member.id));
      pushToast({ kind: 'success', title: '成员已删除' });
    } catch (deleteError) {
      pushToast({
        kind: 'error',
        title: '成员删除失败',
        description: deleteError instanceof Error ? deleteError.message : undefined,
      });
    }
  };

  return (
    <div className="page page--admin">
      <header className="page-header">
        <span>
          <h2>团队与审计</h2>
          <p>协作模式权限在服务端逐对象校验；界面隐藏不是权限边界。</p>
        </span>
        {canManage ? (
          <Button onClick={() => setMemberModalOpen(true)} variant="primary">
            <UserPlus size={16} />
            添加成员
          </Button>
        ) : null}
      </header>
      <div className="admin-overview">
        <section>
          <Users size={20} />
          <span>
            <small>当前成员</small>
            <strong>{members.filter((member) => member.active).length}</strong>
            <code>{members.length} 个账户</code>
          </span>
        </section>
        <section>
          <ShieldCheck size={20} />
          <span>
            <small>当前角色</small>
            <strong>{session?.user.role ?? '—'}</strong>
            <code>服务端强制 RBAC</code>
          </span>
        </section>
        <section>
          <FileClock size={20} />
          <span>
            <small>审计事件</small>
            <strong>{entries.length}</strong>
            <code>UTC 时间与关联 ID</code>
          </span>
        </section>
      </div>
      <div className="admin-grid">
        <section className="team-members">
          <header>
            <Users size={17} />
            <h3>团队成员</h3>
            <span>{transport.kind === 'desktop' ? '单机模式' : '协作模式'}</span>
          </header>
          {loading ? <LoadingState label="正在读取成员…" /> : null}
          {!loading && !error ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const isSelf = member.id === session?.user.id;
                    const protectedFromAdmin =
                      session?.user.role === 'admin' &&
                      (member.role === 'owner' || member.role === 'admin');
                    const mutable = canManage && !protectedFromAdmin && member.role !== 'owner';
                    return (
                      <tr key={member.id}>
                        <td>
                          <strong>{member.name}</strong>
                          <br />
                          <code>{member.email}</code>
                        </td>
                        <td>
                          <Select
                            aria-label={`修改 ${member.name} 的角色`}
                            disabled={!mutable || isSelf}
                            onChange={(event) =>
                              void updateMember(member.id, {
                                role: event.target.value as Exclude<User['role'], 'owner'>,
                              })
                            }
                            value={member.role}
                          >
                            {member.role === 'owner' ? <option value="owner">Owner</option> : null}
                            {session?.user.role === 'owner' ? (
                              <option value="admin">Admin</option>
                            ) : null}
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </Select>
                        </td>
                        <td>
                          <span
                            className={
                              member.active
                                ? 'member-status member-status--active'
                                : 'member-status'
                            }
                          >
                            {member.active ? '启用' : '停用'}
                          </span>
                        </td>
                        <td>
                          <span className="table-actions">
                            <Button
                              disabled={!mutable || isSelf}
                              onClick={() =>
                                void updateMember(member.id, {
                                  active: !member.active,
                                })
                              }
                              size="small"
                              variant="ghost"
                            >
                              {member.active ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                              {member.active ? '停用' : '启用'}
                            </Button>
                            <Button
                              disabled={!mutable || isSelf}
                              onClick={() => void deleteMember(member)}
                              size="small"
                              variant="danger"
                            >
                              <Trash2 size={14} />
                              删除
                            </Button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
        <section className="role-matrix">
          <header>
            <UserCog size={17} />
            <h3>角色权限</h3>
          </header>
          {roleMatrix.map(([role, description]) => (
            <div key={role}>
              <strong>{role}</strong>
              <span>{description}</span>
            </div>
          ))}
        </section>
        <section className="audit-log">
          <header>
            <FileClock size={17} />
            <h3>审计日志</h3>
          </header>
          {loading ? <LoadingState label="正在验证审计链…" /> : null}
          {error ? <ErrorState message={error} /> : null}
          {!loading && !error ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作人</th>
                    <th>操作</th>
                    <th>目标</th>
                    <th>结果</th>
                    <th>关联 ID</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDateTime(entry.createdAt)}</td>
                      <td>{entry.actorName}</td>
                      <td>{entry.action}</td>
                      <td>{entry.target}</td>
                      <td
                        className={entry.result === 'success' ? 'audit-success' : 'audit-failure'}
                      >
                        {entry.result === 'success' ? '成功' : '失败'}
                      </td>
                      <td>
                        <code>{entry.correlationId}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!entries.length ? <p className="table-empty">还没有审计事件。</p> : null}
            </div>
          ) : null}
        </section>
      </div>
      <AddMemberModal
        allowAdmin={session?.user.role === 'owner'}
        onClose={() => setMemberModalOpen(false)}
        onSubmit={async (input) => {
          const member = await transport.createUser(input);
          setMembers((current) => [...current, member]);
          pushToast({ kind: 'success', title: '成员已创建' });
        }}
        open={memberModalOpen}
      />
    </div>
  );
}
