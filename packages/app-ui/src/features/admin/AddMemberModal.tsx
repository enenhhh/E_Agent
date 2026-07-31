import { useState, type FormEvent } from 'react';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import type { TeamMemberInput } from '../../lib/transport';

export function AddMemberModal({
  allowAdmin,
  onClose,
  onSubmit,
  open,
}: {
  allowAdmin: boolean;
  onClose: () => void;
  onSubmit: (input: TeamMemberInput) => Promise<void>;
  open: boolean;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<TeamMemberInput['role']>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      });
      setName('');
      setEmail('');
      setPassword('');
      setRole('member');
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '成员创建失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      description="初始密码仅用于首次登录；请通过受信任渠道单独发送给成员。"
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button form="add-member-form" loading={submitting} type="submit" variant="primary">
            创建成员
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="添加团队成员"
    >
      <form className="form-grid" id="add-member-form" onSubmit={(event) => void submit(event)}>
        <Field
          autoComplete="name"
          label="显示名称"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <Field
          autoComplete="email"
          label="邮箱"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
        <Field
          autoComplete="new-password"
          className="form-grid__wide"
          description="至少 8 个字符；服务端只保存 scrypt 哈希。"
          label="初始密码"
          minLength={8}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <label className="field form-grid__wide">
          <span className="field__label">角色</span>
          <Select
            onChange={(event) => setRole(event.target.value as TeamMemberInput['role'])}
            value={role}
          >
            {allowAdmin ? <option value="admin">Admin</option> : null}
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
          </Select>
        </label>
        {error ? (
          <p className="field__error form-grid__wide" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
