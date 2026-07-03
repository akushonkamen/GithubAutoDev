/**
 * @cgao/observability — Structured logging, OTel tracer stub, Prometheus
 * metrics. T-M10-003, spec §19.
 */

export {
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerSink,
  CaptureSink,
  JsonConsoleLogger,
  defaultSink,
} from './logger.js';
export {
  type Span,
  type Tracer,
  StubTracer,
  withSpan,
} from './otel-tracer.js';
export {
  type MetricLabels,
  type HistogramBucketConfig,
  Counter,
  DEFAULT_DURATION_BUCKETS,
  Histogram,
  PrometheusRegistry,
} from './prom-metrics.js';
export {
  type RunContextValue,
  bindRunContext,
  runContext,
  withRunContext,
} from './run-context.js';
