import { ArrowRight, KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { useTransport } from '../../context/TransportContext';
import { useAuthStore } from '../../stores/auth-store';

interface LocationState {
  from?: {
    pathname?: string;
  };
}

export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, transport } = useTransport();
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const login = useAuthStore((state) => state.login);
  const clearError = useAuthStore((state) => state.clearError);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (status === 'authenticated') {
    return <Navigate replace to="/workspace" />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    clearError();
    try {
      await login(transport, { email: email.trim(), password });
      const target = (location.state as LocationState | null)?.from?.pathname ?? '/workspace';
      navigate(target, { replace: true });
    } catch {
      // Store 已保存可展示的错误信息。
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <span className="auth-brand">
          <span className="brand-mark">E</span>
          <strong>E Agent</strong>
        </span>
        <div className="auth-intro__copy">
          <h1>让模型、上下文与代码，在一个工作台里协同。</h1>
          <p>多模型路由、安全密钥池、项目记忆与可审阅的文件变更，为日常开发保持清晰边界。</p>
        </div>
        <ul className="auth-features">
          <li>
            <ShieldCheck size={18} />
            密钥端到端加密，明文不进入界面与日志
          </li>
          <li>
            <KeyRound size={18} />多 Key 轮询、限额与自动健康检查
          </li>
          <li>
            <Laptop size={18} />
            桌面与 Web 共享一致工作流
          </li>
        </ul>
      </section>
      <section className="auth-panel">
        <div className="auth-panel__inner">
          <span className="auth-panel__mode">{mode === 'desktop' ? '桌面模式' : '协作模式'}</span>
          <h2>登录 E Agent</h2>
          <p>{mode === 'desktop' ? '解锁本机工作区。' : '登录到您的团队工作区。'}</p>
          <form onSubmit={(event) => void submit(event)}>
            <Field
              autoComplete="email"
              label="邮箱"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              required
              type="email"
              value={email}
            />
            <Field
              autoComplete="current-password"
              label="密码"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入密码"
              required
              type="password"
              value={password}
            />
            {error ? <div className="auth-panel__error">{error}</div> : null}
            <Button
              disabled={!email || password.length < 8}
              loading={status === 'loading'}
              size="large"
              type="submit"
              variant="primary"
            >
              登录
              <ArrowRight size={17} />
            </Button>
          </form>
          <Link className="auth-panel__setup-link" to="/setup">
            首次使用？初始化工作区
          </Link>
          <small>登录即表示您同意工作区管理员配置的安全与审计策略。</small>
        </div>
      </section>
    </main>
  );
}
