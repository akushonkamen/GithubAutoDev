/**
 * VerifierRunner — T-M6-005, spec §12.7 / §12.9.
 *
 * Walks a plan's `AcceptanceCriterion[]` list and pairs each one with
 * an `AcceptanceCriterionEvidence` record sourced from gate results
 * and review findings. PR body checkboxes are deliberately NOT
 * counted as evidence — see the explicit guard test.
 *
 * The runner is port-driven so tests can stub out the gate and review
 * sources; production wires the FastGateRunner + review module.
 */

import { createHash } from 'node:crypto';
import type { Artifact, ArtifactStore } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import type {
  AcceptanceCriterion,
  AcceptanceCriterionEvidence,
  AcceptanceEvidenceKind,
} from './acceptance-evidence.js';

/** Plan-side gate result (re-used from types.js). */
export interface VerifierGateSnapshot {
  passed: boolean;
  logArtifactRef: string;
}

export interface VerifierReviewSnapshot {
  /** Review artifact ref (`sha256:...`). */
  findingRef: string;
  /** Criterion ids the review explicitly marked satisfied. */
  satisfiedCriteria: readonly string[];
}

export interface VerifierEvidenceSources {
  gate?: VerifierGateSnapshot;
  review?: VerifierReviewSnapshot;
  /** Manual notes keyed by criterion id (only for kind='manual'). */
  manualNotes?: Readonly<Record<string, string>>;
}

export interface VerifierRunInput {
  planId: string;
  headSha: string;
  baseSha: string;
  repo: string;
  runId?: string;
  criteria: readonly AcceptanceCriterion[];
  sources: VerifierEvidenceSources;
  store: ArtifactStore;
}

export interface VerifierRunResult {
  planId: string;
  /** One record per criterion, in plan order. */
  evidence: readonly AcceptanceCriterionEvidence[];
  /** True iff every criterion has evidence of its expected kind. */
  complete: boolean;
  /**
   * `sha256:<hex>` over canonical({ planId, headSha, baseSha, evidence }).
   * Persisted alongside the evidence bundle so auditors can verify
   * the chain.
   */
  bindingHash: string;
  /** Persisted evidence-bundle artifact key (`sha256:...`). */
  evidenceArtifactRef: string;
}

/**
 * VerifierRunner is intentionally pure: it never reads PR body, never
 * shells out, and never trusts any source it isn't handed. The caller
 * is responsible for only passing trustworthy `sources` (gate log +
 * review-finding artifacts).
 */
export class VerifierRunner {
  run(input: VerifierRunInput): Promise<VerifierRunResult> {
    const evidence: AcceptanceCriterionEvidence[] = input.criteria.map((criterion) =>
      this.collectForCriterion(criterion, input.sources),
    );

    const complete = evidence.every(
      (e) =>
        e.evidence.logRef !== undefined ||
        e.evidence.findingRef !== undefined ||
        e.evidence.note !== undefined,
    );

    const bindingHash = this.computeBindingHash({
      planId: input.planId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      evidence,
    });

    return this.persist({
      input,
      evidence,
      complete,
      bindingHash,
    });
  }

  private collectForCriterion(
    criterion: AcceptanceCriterion,
    sources: VerifierEvidenceSources,
  ): AcceptanceCriterionEvidence {
    const evidence = this.gather(criterion.kind, criterion.id, sources);
    const bindingHash = this.evidenceBindingHash(criterion.id, criterion.kind, evidence);
    return { criterionId: criterion.id, kind: criterion.kind, evidence, bindingHash };
  }

  private gather(
    kind: AcceptanceEvidenceKind,
    criterionId: string,
    sources: VerifierEvidenceSources,
  ): AcceptanceCriterionEvidence['evidence'] {
    if (kind === 'test') {
      // Test evidence MUST come from the gate log artifact; PR body
      // checkboxes are explicitly rejected as evidence.
      if (sources.gate === undefined) {
        return { note: 'no gate result available' };
      }
      return { logRef: sources.gate.logArtifactRef };
    }
    if (kind === 'review') {
      if (sources.review === undefined) {
        return { note: 'no review available' };
      }
      const satisfies = sources.review.satisfiedCriteria.includes(criterionId);
      if (!satisfies) {
        return { note: 'review did not mark criterion satisfied' };
      }
      return { findingRef: sources.review.findingRef };
    }
    // manual
    const note = sources.manualNotes?.[criterionId];
    return note !== undefined ? { note } : { note: 'no manual note provided' };
  }

  private evidenceBindingHash(
    criterionId: string,
    kind: AcceptanceEvidenceKind,
    evidence: AcceptanceCriterionEvidence['evidence'],
  ): string {
    const canonical = stableJsonStringify({ criterionId, kind, evidence });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  private computeBindingHash(input: {
    planId: string;
    headSha: string;
    baseSha: string;
    evidence: readonly AcceptanceCriterionEvidence[];
  }): string {
    const canonical = stableJsonStringify({
      planId: input.planId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      evidence: input.evidence,
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  private async persist(args: {
    input: VerifierRunInput;
    evidence: readonly AcceptanceCriterionEvidence[];
    complete: boolean;
    bindingHash: string;
  }): Promise<VerifierRunResult> {
    const body = stableJsonStringify({
      kind: 'verifier_evidence_bundle',
      planId: args.input.planId,
      headSha: args.input.headSha,
      baseSha: args.input.baseSha,
      repo: args.input.repo,
      evidence: args.evidence,
      complete: args.complete,
      bindingHash: args.bindingHash,
    });
    const key = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const artifact: Artifact = {
      kind: 'raw_payload',
      key,
      content: body,
      repo: args.input.repo,
      runId: args.input.runId ?? null,
      createdAt: new Date().toISOString(),
    };
    await args.input.store.write(artifact);
    return {
      planId: args.input.planId,
      evidence: args.evidence,
      complete: args.complete,
      bindingHash: args.bindingHash,
      evidenceArtifactRef: key,
    };
  }
}
