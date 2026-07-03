/**
 * Runner hooks — T-M11-001, spec §13 / §16 / §17.
 *
 * Orchestrator-controlled integration seam that wires the Agent SDK
 * Runner into the same security envelope as the CCA runner:
 *
 *   - CredentialProfile enforcement (untrusted profile only)
 *   - Sandbox path policy (PathWritePolicy)
 *   - Artifact store (WorkerResult + log artifacts)
 *   - Log scrubber (redact secret-shaped strings before persist)
 *   - Audit chain (every dispatch appends a record)
 *
 * The hook bundle is a plain object so tests can swap individual
 * collaborators. Production wires real impls; tests wire fakes.
 */

import type { ArtifactStore } from '@cgao/artifacts';
import type { CredentialProfile } from '../profiles/credential-profile.js';
import type { PathWritePolicy, PolicyCheck } from '../sandbox/path-write-policy.js';
import type { WriteOverlay } from '../sandbox/write-overlay.js';

/** Minimal audit sink the runner hooks call. */
export interface RunnerAuditSink {
  append(input: {
    runId: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Redacts secret-shaped substrings from a log/string before persist. */
export type ScrubFn = (text: string) => string;

export interface RunnerHooks {
  /** Resolved credential profile the run executes under. */
  profile: CredentialProfile;
  /** Workspace path policy the agent writes against. */
  pathPolicy: PathWritePolicy;
  /** Overlay capturing every accepted write. */
  overlay: WriteOverlay;
  /** Artifact store for worker_result + log artifacts. */
  store: ArtifactStore;
  /** Audit chain sink. */
  audit: RunnerAuditSink;
  /** Log scrubber. */
  scrub: ScrubFn;
  /** Repo the run belongs to (forwarded to artifact metadata). */
  repo: string;
  /** Optional run id; null for raw payloads before run is known. */
  runId: string | null;
}

/**
 * Run a write through the hook bundle: enforce the path policy, record
 * the entry in the overlay, and audit the decision. Returns the policy
 * check so the runner can short-circuit on denial.
 *
 * Spec §13.3: every write MUST go through this gate — a denial is NOT
 * recorded in the overlay, but IS recorded in the audit chain so the
 * orchestrator can detect drift.
 */
export async function enforceWrite(
  hooks: RunnerHooks,
  absolutePath: string,
  contents: string,
): Promise<PolicyCheck> {
  const check = hooks.pathPolicy.isAllowed(absolutePath);
  if (check.decision === 'POLICY_DENIED') {
    await hooks.audit.append({
      runId: hooks.runId,
      kind: 'runner.write.denied',
      payload: {
        repo: hooks.repo,
        path: absolutePath,
        reasons: check.reasons,
        profile: hooks.profile,
      },
    });
    return check;
  }
  hooks.overlay.write(absolutePath, contents);
  await hooks.audit.append({
    runId: hooks.runId,
    kind: 'runner.write.allowed',
    payload: {
      repo: hooks.repo,
      path: absolutePath,
      profile: hooks.profile,
    },
  });
  return check;
}

/**
 * Persist a (scrubbed) log artifact and return its content-addressed
 * key. The scrubber runs BEFORE hashing so the persisted body never
 * contains a secret-shaped substring.
 */
export async function persistScrubbedLog(
  hooks: RunnerHooks,
  raw: string,
  kindPrefix: string,
): Promise<string> {
  const { computeArtifactKey } = await import('@cgao/artifacts');
  const scrubbed = hooks.scrub(raw);
  const key = computeArtifactKey(scrubbed);
  await hooks.store.write({
    kind: 'raw_payload',
    key,
    content: scrubbed,
    repo: hooks.repo,
    runId: hooks.runId,
    createdAt: new Date().toISOString(),
  });
  void kindPrefix;
  return key;
}
