/**
 * Structured logger — T-M10-003, spec §19.
 *
 * Emits one JSON line per log call with the required structured fields
 * so the operator can correlate logs with run / event ids:
 *
 *   - run_id        — workflow run id (if in a run context)
 *   - event_id      — bus message id (if logged from a consumer)
 *   - module        — module name (e.g. 'merge', 'intake', 'reconcile')
 *   - state_from    — prior workflow state (on transitions)
 *   - state_to      — new workflow state (on transitions)
 *   - reason        — short reason code for the log line
 *
 * The logger is a thin wrapper over console.stdout; production wiring
 * can swap in pino/winston behind the same interface.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  runId?: string;
  eventId?: string;
  module?: string;
  stateFrom?: string;
  stateTo?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Bind default fields (e.g. module name) so every call carries them. */
  child(defaults: LogFields): Logger;
}

export interface LoggerSink {
  write(level: LogLevel, msg: string, fields: LogFields): void;
}

export class JsonConsoleLogger implements Logger {
  constructor(
    private readonly defaults: LogFields = {},
    private readonly sink: LoggerSink = defaultSink,
  ) {}

  debug(msg: string, fields: LogFields = {}): void {
    this.sink.write('debug', msg, { ...this.defaults, ...fields });
  }

  info(msg: string, fields: LogFields = {}): void {
    this.sink.write('info', msg, { ...this.defaults, ...fields });
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.sink.write('warn', msg, { ...this.defaults, ...fields });
  }

  error(msg: string, fields: LogFields = {}): void {
    this.sink.write('error', msg, { ...this.defaults, ...fields });
  }

  child(defaults: LogFields): Logger {
    return new JsonConsoleLogger({ ...this.defaults, ...defaults }, this.sink);
  }
}

/** Default sink: one JSON line to stdout. */
export const defaultSink: LoggerSink = {
  write(level, msg, fields) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    });
    // eslint-disable-next-line no-console
    console.log(line);
  },
};

/** Capture sink used by tests to assert fields without touching stdout. */
export class CaptureSink implements LoggerSink {
  readonly lines: Array<{ level: LogLevel; msg: string; fields: LogFields }> = [];

  write(level: LogLevel, msg: string, fields: LogFields): void {
    this.lines.push({ level, msg, fields });
  }

  reset(): void {
    this.lines.length = 0;
  }
}
