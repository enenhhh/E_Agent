import { GitBranch, Radio, Rows3, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useTransport } from '../../context/TransportContext';
import { useConversationStore } from '../../stores/conversation-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useToastStore } from '../../stores/toast-store';

export function StatusBar(): React.JSX.Element {
  const { mode, transport } = useTransport();
  const queue = useConversationStore((state) => state.queue);
  const threshold = useSettingsStore((state) => state.settings.costAlertThreshold);
  const pushToast = useToastStore((state) => state.push);
  const [dailyCost, setDailyCost] = useState(0);
  const notifiedRef = useRef(false);
  const overBudget = threshold > 0 && dailyCost >= threshold;

  useEffect(() => {
    let disposed = false;
    const refreshCost = async (): Promise<void> => {
      try {
        const summary = await transport.getUsageSummary('day');
        if (disposed) return;
        setDailyCost(summary.totalCost);
        if (summary.totalCost >= threshold && threshold > 0 && !notifiedRef.current) {
          notifiedRef.current = true;
          pushToast({
            kind: 'warning',
            title: '今日成本已达到预警阈值',
            description: `$${summary.totalCost.toFixed(2)} / $${threshold.toFixed(2)}`,
          });
        } else if (summary.totalCost < threshold) {
          notifiedRef.current = false;
        }
      } catch {
        // 成本提示是辅助状态；刷新失败不影响聊天主流程。
      }
    };
    void refreshCost();
    const timer = window.setInterval(() => void refreshCost(), 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pushToast, threshold, transport]);

  return (
    <footer className={`status-bar${overBudget ? ' status-bar--cost-alert' : ''}`}>
      <span className="status-bar__group">
        <span className="status-bar__connected">
          <Radio size={12} />
          已连接
        </span>
        <span>
          <GitBranch size={13} />
          main
        </span>
        <span>
          <Rows3 size={13} />
          请求队列 {queue.position ? `第 ${queue.position} 位` : queue.queued}
        </span>
        <span className={overBudget ? 'status-bar__cost-alert' : undefined}>
          {overBudget ? <TriangleAlert size={13} /> : null}
          今日 ${dailyCost.toFixed(2)} / ${threshold.toFixed(2)}
        </span>
      </span>
      <span className="status-bar__group">
        <span>{mode === 'desktop' ? 'Desktop' : 'Web'}</span>
        <span>UTF-8</span>
        <span>Ln 1, Col 1</span>
        <span>TypeScript</span>
      </span>
    </footer>
  );
}
