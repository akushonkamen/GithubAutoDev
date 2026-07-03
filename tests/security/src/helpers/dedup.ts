/**
 * Dedup key builder — spec §4.4 / §15, control C-IM-06.
 *
 * Triple: `source_type | external_id | content_hash`. The content hash
 * pins the *payload* so an attacker cannot replay with the same
 * delivery id while mutating the body. Returned key is suitable as
 * the dedup_key column on `intake_messages` / `github_deliveries`.
 */

import { createHash } from 'node:crypto';

export interface DedupSubject {
  source: 'github' | 'lark' | 'wecom' | 'slack';
  type: string;
  externalId: string;
  body: string;
}

export function buildDedupKey(s: DedupSubject): string {
  const contentHash = createHash('sha256').update(s.body).digest('hex').slice(0, 16);
  return `${s.source}|${s.type}|${s.externalId}|${contentHash}`;
}
