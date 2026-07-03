/**
 * Deterministic JSON serialization — T-M0-005, spec §11 / §19.
 *
 * `stableJsonStringify` produces a canonical JSON form: object keys
 * sorted ascending at every level, arrays preserved in source order,
 * no insignificant whitespace. Used everywhere CGAO hashes structured
 * content (artifact bodies, audit records, gate results, fingerprints)
 * so identical logical content always produces the same sha256.
 *
 * Implementation mirrors the local copies that previously lived in
 * orchestrator/specs and audit/chain — centralized here so new
 * modules (gate, verifier, fingerprint) don't reinvent it.
 */

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(stableJsonStringify);
    return `[${items.join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableJsonStringify(v)}`;
  });
  return `{${pairs.join(',')}}`;
}
