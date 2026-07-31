import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';

import { useTransport } from '../../context/TransportContext';
import { useConversationStore } from '../../stores/conversation-store';
import { useModelStore } from '../../stores/model-store';
import { useSettingsStore } from '../../stores/settings-store';
import { ToastViewport } from '../ui/ToastViewport';

import { NavigationRail } from './NavigationRail';
import { SessionSidebar } from './SessionSidebar';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

function isCompactViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 980px)').matches;
}

export function AppShell(): React.JSX.Element {
  const { transport } = useTransport();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isCompactViewport);
  const loadModels = useModelStore((state) => state.load);
  const loadSettings = useSettingsStore((state) => state.load);
  const loadConversations = useConversationStore((state) => state.loadConversations);
  const refreshQueue = useConversationStore((state) => state.refreshQueue);

  useEffect(() => {
    void Promise.all([
      loadModels(transport),
      loadSettings(transport),
      loadConversations(transport),
      refreshQueue(transport),
    ]);
    const timer = window.setInterval(() => void refreshQueue(transport), 10_000);
    return () => window.clearInterval(timer);
  }, [loadConversations, loadModels, loadSettings, refreshQueue, transport]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      }
      if (commandKey && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        const conversationState = useConversationStore.getState();
        if (conversationState.messageMutationId === null) {
          void conversationState.createConversation(transport);
        }
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [transport]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const compactViewport = window.matchMedia('(max-width: 980px)');
    const collapseWhenCompact = (event: MediaQueryListEvent): void => {
      if (event.matches) setSidebarCollapsed(true);
    };
    compactViewport.addEventListener('change', collapseWhenCompact);
    return () => compactViewport.removeEventListener('change', collapseWhenCompact);
  }, []);

  return (
    <div className={`app-shell${sidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`}>
      <NavigationRail />
      <SessionSidebar collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed(true)} />
      <TopBar
        onOpenSidebar={() => setSidebarCollapsed(false)}
        sidebarCollapsed={sidebarCollapsed}
      />
      <main className="app-content">
        <Outlet />
      </main>
      <StatusBar />
      <ToastViewport />
    </div>
  );
}
