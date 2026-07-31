import { ArrowRight, Database, LockKeyhole, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';

export function SetupPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { mode, transport } = useTransport();
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const bootstrapTokenRequired = useAuthStore((state) => state.bootstrapTokenRequired);
  const setup = useAuthStore((state) => state.setup);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');

  if (status === 'authenticated') {
    return <Navigate replace to="/workspace" />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password !== confirmPassword) {
      return;
    }
    try {
      await setup(transport, {
        name: name.trim(),
        email: email.trim(),
        password,
        ...(mode === 'web' && bootstrapTokenRequired ? { bootstrapToken } : {}),
      });
      navigate('/workspace', { replace: true });
    } catch {
      // Store 已保存可展示的错误信息。
    } finally {
      if (mode === 'web') setBootstrapToken('');
    }
  };

  return (
    <main className="setup-page">
      <section className="setup-card">
        <header>
          <span className="brand-mark">E</span>
          <span>
            <h1>初始化 E Agent</h1>
            <p>
              {mode === 'desktop' ? '创建本机 Owner 并加密数据仓库。' : '创建团队工作区 Owner。'}
            </p>
          </span>
        </header>
        <ol className="setup-steps">
          <li className="is-active">
            <UserRound size={16} />
            Owner
          </li>
          <li>
            <LockKeyhole size={16} />
            密钥库
          </li>
          <li>
            <Database size={16} />
            工作区
          </li>
        </ol>
        <form onSubmit={(event) => void submit(event)}>
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
            description="至少 12 位，建议使用密码管理器生成。"
            label="主密码"
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <Field
            autoComplete="new-password"
            error={
              confirmPassword && password !== confirmPassword ? '两次输入的密码不一致。' : undefined
            }
            label="确认主密码"
            minLength={12}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            type="password"
            value={confirmPassword}
          />
          {mode === 'web' && bootstrapTokenRequired ? (
            <Field
              autoComplete="off"
              description="服务端要求部署管理员提供；仅随本次首个 Owner 注册请求发送，不会保存。"
              label="部署初始化令牌"
              minLength={32}
              onChange={(event) => setBootstrapToken(event.target.value)}
              required
              type="password"
              value={bootstrapToken}
            />
          ) : null}
          {error ? <div className="auth-panel__error">{error}</div> : null}
          <Button
            disabled={
              !name ||
              !email ||
              password.length < 12 ||
              password !== confirmPassword ||
              (mode === 'web' && bootstrapTokenRequired && bootstrapToken.length < 32)
            }
            loading={status === 'loading'}
            size="large"
            type="submit"
            variant="primary"
          >
            创建并继续
            <ArrowRight size={17} />
          </Button>
        </form>
      </section>
    </main>
  );
}
