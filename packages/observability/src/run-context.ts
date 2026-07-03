/**
 * RunContext — T-M10-003, spec §19.
 *
 * AsyncLocalStorage-backed context so any call site (deep inside a
 * handler) can pull `run_id` / `event_id` without threading them
 * through every signature. Falls back gracefully outside an
 * established context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunContextValue {
  runId?: string;
  eventId?: string;
  module?: string;
}

const storage = new AsyncLocalStorage<RunContextValue>();

export function runContext(): RunContextValue {
  return storage.getStore() ?? {};
}

export function withRunContext<T>(value: RunContextValue, fn: () => T): T {
  return storage.run(value, fn);
}

export function bindRunContext(value: RunContextValue): {
  run<T>(fn: () => T): T;
} {
  return {
    run<T>(fn: () => T): T {
      return storage.run(value, fn);
    },
  };
}
