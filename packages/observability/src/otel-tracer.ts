/**
 * OpenTelemetry tracer stub — T-M10-003, spec §19.
 *
 * Provides a minimal `Tracer` interface so call sites can wrap spans
 * today without binding to a real OTel collector. Production wires this
 * to `@opentelemetry/api`'s `trace.getTracer(...)`; the interface stays
 * stable so the swap is a one-line change.
 */

export interface Span {
  /** Mark the span as ended. MUST be idempotent. */
  end(): void;
  /** Attach a key/value attribute to the span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on the span. */
  recordError(error: Error): void;
}

export interface Tracer {
  startSpan(name: string, opts?: { attributes?: Record<string, string | number | boolean> }): Span;
}

class StubSpan implements Span {
  ended = false;
  readonly attributes = new Map<string, string | number | boolean>();
  readonly errors: Error[] = [];
  constructor(
    public readonly name: string,
    attrs: Record<string, string | number | boolean> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attributes.set(k, v);
  }
  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes.set(key, value);
  }
  recordError(error: Error): void {
    this.errors.push(error);
  }
  end(): void {
    this.ended = true;
  }
}

export class StubTracer implements Tracer {
  readonly spans: StubSpan[] = [];
  startSpan(name: string, opts?: { attributes?: Record<string, string | number | boolean> }): Span {
    const span = new StubSpan(name, opts?.attributes ?? {});
    this.spans.push(span);
    return span;
  }
}

/** Convenience: run fn inside a span that auto-ends on return/throw. */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    return await fn(span);
  } catch (err) {
    span.recordError(err as Error);
    throw err;
  } finally {
    span.end();
  }
}
