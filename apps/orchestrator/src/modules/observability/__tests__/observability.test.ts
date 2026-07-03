/**
 * T-M10-003 observability baseline — assert structured-log fields and
 * the /metrics Prometheus surface.
 */

import {
  CaptureSink,
  JsonConsoleLogger,
  PrometheusRegistry,
  StubTracer,
  runContext,
  withRunContext,
  withSpan,
} from '@cgao/observability';
import { describe, expect, it } from 'vitest';

describe('T-M10-003 structured logger', () => {
  it('emits required fields: run_id, event_id, module, state_from, state_to, reason', () => {
    const sink = new CaptureSink();
    const log = new JsonConsoleLogger({ module: 'merge' }, sink);
    log.info('transition', {
      runId: 'run_1',
      eventId: 'evt_1',
      stateFrom: 'GATE',
      stateTo: 'MERGE_QUEUED',
      reason: 'all-gates-green',
    });
    expect(sink.lines.length).toBe(1);
    const line = sink.lines[0];
    expect(line?.fields).toMatchObject({
      runId: 'run_1',
      eventId: 'evt_1',
      module: 'merge',
      stateFrom: 'GATE',
      stateTo: 'MERGE_QUEUED',
      reason: 'all-gates-green',
    });
  });

  it('child logger inherits defaults but overrides on call', () => {
    const sink = new CaptureSink();
    const log = new JsonConsoleLogger({ module: 'intake' }, sink).child({ runId: 'run_2' });
    log.info('classified', { reason: 'primary' });
    const line = sink.lines[0];
    expect(line?.fields).toMatchObject({ module: 'intake', runId: 'run_2', reason: 'primary' });
  });
});

describe('T-M10-003 OTel tracer stub', () => {
  it('records spans with attributes and end semantics', async () => {
    const tracer = new StubTracer();
    await withSpan(
      tracer,
      'merge.run',
      async (span) => {
        span.setAttribute('repo', 'cgao/test');
      },
      { kind: 'merge' },
    );
    expect(tracer.spans.length).toBe(1);
    const span = tracer.spans[0];
    expect(span?.name).toBe('merge.run');
    expect(span?.ended).toBe(true);
    expect(span?.attributes.get('kind')).toBe('merge');
    expect(span?.attributes.get('repo')).toBe('cgao/test');
  });

  it('records errors thrown inside the span', async () => {
    const tracer = new StubTracer();
    await expect(
      withSpan(tracer, 'boom', async (span) => {
        span.setAttribute('a', 1);
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    expect(tracer.spans[0]?.errors[0]?.message).toBe('kaboom');
  });
});

describe('T-M10-003 Prometheus metrics', () => {
  it('renders counters and histograms in exposition format', () => {
    const r = new PrometheusRegistry();
    r.runsTotal.inc({ state: 'EXECUTING' });
    r.runsTotal.inc({ state: 'EXECUTING' });
    r.runsTotal.inc({ state: 'MERGED' });
    r.webhookTotal.inc({ event: 'issue.opened' });
    r.gateResults.inc({ decision: 'merge' });
    r.gateResults.inc({ decision: 'refuse' });
    r.runDurationSeconds.observe(2.5);
    r.runDurationSeconds.observe(120);

    const text = r.format();
    expect(text).toContain('cgao_runs_total{state="EXECUTING"} 2');
    expect(text).toContain('cgao_runs_total{state="MERGED"} 1');
    expect(text).toContain('cgao_webhook_total{event="issue.opened"} 1');
    expect(text).toContain('cgao_gate_results{decision="merge"} 1');
    expect(text).toContain('cgao_run_duration_seconds_bucket{le="5"} 1');
    expect(text).toContain('cgao_run_duration_seconds_bucket{le="+Inf"} 2');
    expect(text).toContain('cgao_run_duration_seconds_count 2');
  });
});

describe('T-M10-003 RunContext', () => {
  it('exposes run_id/event_id inside a context and clears outside', () => {
    expect(runContext()).toEqual({});
    withRunContext({ runId: 'run_3', eventId: 'evt_3', module: 'reconcile' }, () => {
      expect(runContext()).toMatchObject({ runId: 'run_3', eventId: 'evt_3', module: 'reconcile' });
    });
    expect(runContext()).toEqual({});
  });
});
