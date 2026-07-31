interface HistogramState {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',');
}

function withLabels(labels: string): string {
  return labels === '' ? '' : `{${labels}}`;
}

/** 无外部服务依赖的轻量指标注册表，可直接暴露 Prometheus 文本格式。 */
export class MetricsRegistry {
  readonly #counters = new Map<string, Map<string, number>>();
  readonly #gauges = new Map<string, Map<string, number>>();
  readonly #histograms = new Map<string, Map<string, HistogramState>>();

  public increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    const series = this.#counters.get(name) ?? new Map<string, number>();
    const key = labelsKey(labels);
    series.set(key, (series.get(key) ?? 0) + amount);
    this.#counters.set(name, series);
  }

  public gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    const series = this.#gauges.get(name) ?? new Map<string, number>();
    series.set(labelsKey(labels), value);
    this.#gauges.set(name, series);
  }

  public observe(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): void {
    const series = this.#histograms.get(name) ?? new Map<string, HistogramState>();
    const key = labelsKey(labels);
    const state =
      series.get(key) ??
      ({
        count: 0,
        sum: 0,
        buckets: new Map(buckets.map((bucket) => [bucket, 0])),
      } satisfies HistogramState);
    state.count += 1;
    state.sum += value;
    for (const bucket of buckets) {
      if (value <= bucket) state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
    }
    series.set(key, state);
    this.#histograms.set(name, series);
  }

  public renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, series] of this.#counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of series) lines.push(`${name}${withLabels(labels)} ${value}`);
    }
    for (const [name, series] of this.#gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [labels, value] of series) lines.push(`${name}${withLabels(labels)} ${value}`);
    }
    for (const [name, series] of this.#histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labels, state] of series) {
        for (const [upperBound, count] of state.buckets) {
          const separator = labels === '' ? '' : `${labels},`;
          lines.push(`${name}_bucket{${separator}le="${upperBound}"} ${count}`);
        }
        const separator = labels === '' ? '' : `${labels},`;
        lines.push(`${name}_bucket{${separator}le="+Inf"} ${state.count}`);
        lines.push(`${name}_sum${withLabels(labels)} ${state.sum}`);
        lines.push(`${name}_count${withLabels(labels)} ${state.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  public reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#histograms.clear();
  }
}

export const metrics = new MetricsRegistry();

export interface RequestMetric {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export function recordHttpRequest(metric: RequestMetric, registry = metrics): void {
  const labels = {
    method: metric.method,
    route: metric.route,
    status: String(metric.statusCode),
  };
  registry.increment('e_agent_http_requests_total', labels);
  registry.observe('e_agent_http_request_duration_ms', metric.durationMs, {
    method: metric.method,
    route: metric.route,
  });
}
