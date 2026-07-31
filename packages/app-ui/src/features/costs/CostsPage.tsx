import type { EChartsCoreOption } from 'echarts/core';
import { Download, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { EChart } from '../../components/ui/EChart';
import { ErrorState } from '../../components/ui/ErrorState';
import { LoadingState } from '../../components/ui/LoadingState';
import { Progress } from '../../components/ui/Progress';
import { useTransport } from '../../context/TransportContext';
import {
  downloadBlob,
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDuration,
} from '../../lib/format';
import { useToastStore } from '../../stores/toast-store';
import { useUsageStore } from '../../stores/usage-store';
import type { UsageSummary } from '../../types';

const chartText = '#8fa1ad';
const chartGrid = '#26343e';
const mint = '#4adeaa';
const amber = '#f3ad43';
const blue = '#5b92ff';
const violet = '#9d7bea';

function createTrendOption(summary: UsageSummary): EChartsCoreOption {
  return {
    animationDuration: 350,
    color: [mint, amber],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#101c24',
      borderColor: chartGrid,
      textStyle: { color: '#dce7ed' },
    },
    legend: { data: ['Token', '成本'], textStyle: { color: chartText }, top: 0 },
    grid: { left: 52, right: 54, top: 44, bottom: 30 },
    xAxis: {
      type: 'category',
      data: summary.trend.map((item) => item.date),
      axisLine: { lineStyle: { color: chartGrid } },
      axisLabel: { color: chartText },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { color: chartText, formatter: (value: number) => formatCompactNumber(value) },
        splitLine: { lineStyle: { color: chartGrid, type: 'dashed' } },
      },
      {
        type: 'value',
        axisLabel: { color: chartText, formatter: '${value}' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Token',
        type: 'line',
        smooth: 0.25,
        symbolSize: 7,
        data: summary.trend.map((item) => item.tokens),
        lineStyle: { width: 2 },
        areaStyle: { color: 'rgba(74,222,170,.06)' },
      },
      {
        name: '成本',
        type: 'line',
        smooth: 0.25,
        symbolSize: 7,
        yAxisIndex: 1,
        data: summary.trend.map((item) => item.cost),
        lineStyle: { width: 2 },
      },
    ],
  };
}

function createModelOption(summary: UsageSummary): EChartsCoreOption {
  return {
    animationDuration: 350,
    color: [mint, blue, violet, '#697986', amber],
    tooltip: {
      trigger: 'item',
      backgroundColor: '#101c24',
      borderColor: chartGrid,
      textStyle: { color: '#dce7ed' },
    },
    legend: {
      bottom: 0,
      left: 'center',
      textStyle: { color: chartText, fontSize: 10 },
      itemWidth: 8,
      itemHeight: 8,
    },
    series: [
      {
        name: '模型占比',
        type: 'pie',
        radius: ['45%', '67%'],
        center: ['50%', '42%'],
        label: { color: '#dce7ed', formatter: '{d}%', fontSize: 10 },
        itemStyle: { borderColor: '#101c24', borderWidth: 2 },
        data: summary.byModel.map((item) => ({ name: item.model, value: item.tokens })),
      },
    ],
  };
}

export function CostsPage(): React.JSX.Element {
  const { transport } = useTransport();
  const range = useUsageStore((state) => state.range);
  const summary = useUsageStore((state) => state.summary);
  const records = useUsageStore((state) => state.records);
  const loading = useUsageStore((state) => state.loading);
  const error = useUsageStore((state) => state.error);
  const load = useUsageStore((state) => state.load);
  const pushToast = useToastStore((state) => state.push);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  const trendOption = useMemo(() => (summary ? createTrendOption(summary) : {}), [summary]);
  const modelOption = useMemo(() => (summary ? createModelOption(summary) : {}), [summary]);
  const todayCost = summary?.alertCost ?? (range === 'day' ? (summary?.totalCost ?? 0) : 0);
  const budgetRatio = summary ? (todayCost / Math.max(summary.budget, 0.01)) * 100 : 0;

  const exportReport = async (format: 'csv' | 'json' | 'pdf'): Promise<void> => {
    setExporting(true);
    try {
      const blob = await transport.exportUsage(range, format);
      downloadBlob(blob, `e-agent-usage-${range}.${format}`);
      pushToast({ kind: 'success', title: '报表已导出' });
    } catch (exportError) {
      pushToast({
        kind: 'error',
        title: '报表导出失败',
        description: exportError instanceof Error ? exportError.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page page--costs">
      <header className="page-header">
        <span>
          <h2>成本中心</h2>
          <p>按请求记录 Token、成本、耗时与缓存命中，历史价格按版本冻结。</p>
        </span>
        <span className="page-header__actions export-actions">
          <Button loading={exporting} onClick={() => void exportReport('csv')}>
            <Download size={15} />
            导出 CSV
          </Button>
          <Button onClick={() => void exportReport('pdf')}>PDF</Button>
        </span>
      </header>
      <div className="period-tabs">
        {(['day', 'week', 'month'] as const).map((item) => (
          <button
            className={range === item ? 'is-active' : ''}
            key={item}
            onClick={() => void load(transport, item)}
            type="button"
          >
            {item === 'day' ? '今日' : item === 'week' ? '7 天' : '30 天'}
          </button>
        ))}
      </div>
      {summary && budgetRatio >= 70 ? (
        <div className={`budget-warning${budgetRatio >= 100 ? ' is-danger' : ''}`}>
          <TriangleAlert size={16} />
          {budgetRatio >= 100
            ? '今日成本已超过预警阈值，请检查模型路由与 Key 配额。'
            : `今日成本已达到预算的 ${budgetRatio.toFixed(0)}%。`}
        </div>
      ) : null}
      {loading ? <LoadingState label="正在聚合用量记录…" /> : null}
      {error ? <ErrorState message={error} onRetry={() => void load(transport)} /> : null}
      {summary ? (
        <>
          <div className="metrics-band metrics-band--costs">
            <div>
              <small>{range === 'day' ? '今日' : '周期'}成本</small>
              <strong>{formatCurrency(summary.totalCost)}</strong>
            </div>
            <div>
              <small>Token</small>
              <strong>{formatCompactNumber(summary.totalTokens)}</strong>
            </div>
            <div>
              <small>请求</small>
              <strong>{summary.requests.toLocaleString()}</strong>
            </div>
            <div>
              <small>缓存命中</small>
              <strong>{(summary.cacheHitRate * 100).toFixed(0)}%</strong>
            </div>
          </div>
          <div className="cost-grid">
            <section className="chart-panel chart-panel--trend">
              <h3>Token 与成本趋势</h3>
              <EChart
                ariaLabel="Token 与成本趋势折线图"
                className="trend-chart"
                option={trendOption}
              />
            </section>
            <section className="chart-panel">
              <h3>模型占比</h3>
              <EChart
                ariaLabel="模型 Token 占比饼图"
                className="model-chart"
                option={modelOption}
              />
            </section>
            <section className="budget-panel">
              <h3>今日预算</h3>
              <strong className={budgetRatio >= 100 ? 'is-danger' : ''}>
                {formatCurrency(todayCost)}
                <span>/ {formatCurrency(summary.budget)}</span>
              </strong>
              <Progress
                tone={budgetRatio >= 100 ? 'danger' : budgetRatio >= 70 ? 'warning' : 'default'}
                value={budgetRatio}
              />
              <dl>
                <div>
                  <dt>已用金额</dt>
                  <dd>{formatCurrency(todayCost)}</dd>
                </div>
                <div>
                  <dt>剩余金额</dt>
                  <dd>{formatCurrency(Math.max(summary.budget - todayCost, 0))}</dd>
                </div>
                <div>
                  <dt>预警阈值</dt>
                  <dd>70%</dd>
                </div>
              </dl>
            </section>
          </div>
          <section className="usage-detail">
            <header>
              <h3>用量明细</h3>
              <span>共 {records.length.toLocaleString()} 条</span>
            </header>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>模型</th>
                    <th>项目</th>
                    <th>输入</th>
                    <th>输出</th>
                    <th>成本</th>
                    <th>耗时</th>
                    <th>缓存</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id}>
                      <td>{formatDateTime(record.timestamp)}</td>
                      <td>
                        <code>{record.model}</code>
                      </td>
                      <td>{record.project}</td>
                      <td>{record.inputTokens.toLocaleString()}</td>
                      <td>{record.outputTokens.toLocaleString()}</td>
                      <td>{formatCurrency(record.cost)}</td>
                      <td>{formatDuration(record.latencyMs)}</td>
                      <td className={record.cacheHit ? 'cache-hit' : 'cache-miss'}>
                        {record.cacheHit ? '命中' : '未命中'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {records.length === 0 ? (
                <p className="table-empty">当前周期还没有用量记录。</p>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
