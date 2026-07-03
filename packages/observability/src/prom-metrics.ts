/**
 * Prometheus metrics registry — T-M10-003, spec §19.
 *
 * Minimal, allocation-friendly registry that emits Prometheus exposition
 * format from `format()`. Counters and histograms share a namespace;
 * a metric is identified by name + label set.
 *
 * Required metrics (spec §19):
 *   - cgao_runs_total{state}              (counter)
 *   - cgao_webhook_total{event}           (counter)
 *   - cgao_gate_results{decision}         (counter)
 *   - cgao_run_duration_seconds           (histogram)
 *
 * The registry deliberately avoids third-party `prom-client` so the
 * orchestrator can stay zero-runtime-dep on this surface; M11 may swap
 * to prom-client without changing the public methods here.
 */

export interface MetricLabels {
  [key: string]: string;
}

export class Counter {
  readonly kind = 'counter' as const;
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: MetricLabels = {}, by = 1): void {
    const key = this.keyFor(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  value(labels: MetricLabels = {}): number {
    return this.values.get(this.keyFor(labels)) ?? 0;
  }

  private keyFor(labels: MetricLabels): string {
    const parts: string[] = [];
    for (const k of this.labelNames) {
      parts.push(`${k}=${String(labels[k] ?? '')}`);
    }
    return parts.join('|');
  }

  toProm(): string {
    const head = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    if (this.values.size === 0) return `${head}${this.name} 0\n`;
    const lines: string[] = [];
    for (const [k, v] of this.values.entries()) {
      const labelStr = this.labelStr(k);
      lines.push(`${this.name}${labelStr} ${v}`);
    }
    return `${head + lines.join('\n')}\n`;
  }

  private labelStr(key: string): string {
    if (this.labelNames.length === 0) return '';
    const labels: Record<string, string> = {};
    const parts = key.length === 0 ? [] : key.split('|');
    for (let i = 0; i < this.labelNames.length; i++) {
      const ln = this.labelNames[i];
      const raw = parts[i] ?? '';
      const value = raw.slice(raw.indexOf('=') + 1);
      if (ln) labels[ln] = value;
    }
    const pairs = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return pairs ? `{${pairs}}` : '';
  }
}

export interface HistogramBucketConfig {
  /** Bucket upper bounds, sorted ascending. +Inf is implied. */
  buckets: readonly number[];
}

export const DEFAULT_DURATION_BUCKETS = [0.5, 1, 5, 10, 30, 60, 120, 300, 600];

export class Histogram {
  readonly kind = 'histogram' as const;
  private readonly counts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: readonly number[] = DEFAULT_DURATION_BUCKETS,
    private readonly labelNames: readonly string[] = [],
  ) {}

  observe(value: number, labels: MetricLabels = {}): void {
    const key = this.labelKey(labels);
    const counts = this.counts.get(key) ?? new Array(this.buckets.length + 1).fill(0);
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      const bound = this.buckets[i];
      if (bound !== undefined && value <= bound) {
        counts[i] = (counts[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const last = counts.length - 1;
      counts[last] = (counts[last] ?? 0) + 1;
    }
    this.counts.set(key, counts);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }

  private labelKey(labels: MetricLabels): string {
    const parts: string[] = [];
    for (const k of this.labelNames) {
      parts.push(`${k}=${String(labels[k] ?? '')}`);
    }
    return parts.join('|');
  }

  toProm(): string {
    const head = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    if (this.counts.size === 0) return head;
    const lines: string[] = [];
    for (const [key, counts] of this.counts.entries()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        const bound = this.buckets[i];
        const c = counts[i] ?? 0;
        cumulative += c;
        const labelStr = this.renderLabels(key, `le="${bound}"`);
        lines.push(`${this.name}_bucket${labelStr} ${cumulative}`);
      }
      cumulative += counts[counts.length - 1] ?? 0;
      const infLabel = this.renderLabels(key, 'le="+Inf"');
      lines.push(`${this.name}_bucket${infLabel} ${cumulative}`);
      const baseLabel = this.renderLabels(key, '');
      lines.push(`${this.name}_sum${baseLabel} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${baseLabel} ${cumulative}`);
    }
    return `${head + lines.join('\n')}\n`;
  }

  private renderLabels(key: string, extra: string): string {
    const pairs: string[] = [];
    const parts = key.length === 0 ? [] : key.split('|');
    for (let i = 0; i < this.labelNames.length; i++) {
      const ln = this.labelNames[i];
      const raw = parts[i] ?? '';
      const value = raw.slice(raw.indexOf('=') + 1);
      if (ln) pairs.push(`${ln}="${value}"`);
    }
    if (extra) pairs.push(extra);
    return pairs.length ? `{${pairs.join(',')}}` : '';
  }
}

export class PrometheusRegistry {
  readonly runsTotal = new Counter('cgao_runs_total', 'Workflow runs started.', ['state']);
  readonly webhookTotal = new Counter('cgao_webhook_total', 'Webhooks received.', ['event']);
  readonly gateResults = new Counter('cgao_gate_results', 'Gate decisions.', ['decision']);
  readonly runDurationSeconds = new Histogram(
    'cgao_run_duration_seconds',
    'Workflow run duration in seconds.',
    DEFAULT_DURATION_BUCKETS,
  );

  private get all(): Array<Counter | Histogram> {
    return [this.runsTotal, this.webhookTotal, this.gateResults, this.runDurationSeconds];
  }

  /** Render the full registry in Prometheus exposition format. */
  format(): string {
    return this.all.map((m) => m.toProm()).join('');
  }
}
