import {
  Bot,
  BookOpenCheck,
  Boxes,
  Coins,
  KeyRound,
  LayoutGrid,
  LogOut,
  Puzzle,
  Settings,
  Users,
} from 'lucide-react';
import { NavLink } from 'react-router';

import { useI18n } from '../../context/I18nContext';
import { useTransport } from '../../context/TransportContext';
import { classNames } from '../../lib/class-names';
import { useAuthStore } from '../../stores/auth-store';
import { IconButton } from '../ui/IconButton';

const navigationItems = [
  { key: 'workspace', to: '/workspace', icon: LayoutGrid },
  { key: 'models', to: '/models', icon: Bot },
  { key: 'credentials', to: '/credentials', icon: KeyRound },
  { key: 'costs', to: '/costs', icon: Coins },
  { key: 'skills', to: '/skills', icon: Boxes },
  { key: 'plugins', to: '/plugins', icon: Puzzle },
] as const;

export function NavigationRail(): React.JSX.Element {
  const { t } = useI18n();
  const { transport } = useTransport();
  const logout = useAuthStore((state) => state.logout);
  const role = useAuthStore((state) => state.session?.user.role);

  return (
    <aside className="navigation-rail" aria-label="主导航">
      <NavLink aria-label="E Agent 工作台" className="brand-mark" to="/workspace">
        E
      </NavLink>
      <nav className="navigation-rail__main">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              className={({ isActive }) => classNames('rail-link', isActive && 'is-active')}
              key={item.key}
              to={item.to}
            >
              <Icon aria-hidden size={20} strokeWidth={1.8} />
              <span>{t(item.key)}</span>
            </NavLink>
          );
        })}
      </nav>
      <nav className="navigation-rail__footer">
        <NavLink
          className={({ isActive }) => classNames('rail-link', isActive && 'is-active')}
          to="/tutorial"
        >
          <BookOpenCheck aria-hidden size={20} strokeWidth={1.8} />
          <span>{t('tutorial')}</span>
        </NavLink>
        {role === 'owner' || role === 'admin' ? (
          <NavLink
            className={({ isActive }) => classNames('rail-link', isActive && 'is-active')}
            to="/admin"
          >
            <Users aria-hidden size={20} strokeWidth={1.8} />
            <span>{t('admin')}</span>
          </NavLink>
        ) : null}
        <NavLink
          className={({ isActive }) => classNames('rail-link', isActive && 'is-active')}
          to="/settings"
        >
          <Settings aria-hidden size={20} strokeWidth={1.8} />
          <span>{t('settings')}</span>
        </NavLink>
        <IconButton className="rail-logout" label="退出登录" onClick={() => void logout(transport)}>
          <LogOut size={18} />
        </IconButton>
      </nav>
    </aside>
  );
}
