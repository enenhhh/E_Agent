import { create } from 'zustand';

import type { EAgentTransport } from '../lib/transport';
import type { UsageRecord, UsageSummary } from '../types';

interface UsageState {
  range: UsageSummary['range'];
  summary: UsageSummary | null;
  records: UsageRecord[];
  loading: boolean;
  error: string | null;
  load: (transport: EAgentTransport, range?: UsageSummary['range']) => Promise<void>;
  setRange: (range: UsageSummary['range']) => void;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  range: 'week',
  summary: null,
  records: [],
  loading: false,
  error: null,

  load: async (transport, requestedRange) => {
    const range = requestedRange ?? get().range;
    set({ range, loading: true, error: null });
    try {
      const [summary, records] = await Promise.all([
        transport.getUsageSummary(range),
        transport.listUsageRecords(range),
      ]);
      set({ summary, records, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '用量数据加载失败。',
      });
    }
  },

  setRange: (range) => set({ range }),
}));
