/**
 * GateResultsReader — T-M9-001, spec §12.10 / §15.
 *
 * Port-driven reader that pulls the five gate signals (test, AI review,
 * human review, risk policy, security findings) from their respective
 * stores and SHA-binds them to the requested (head, base). Any signal
 * whose head_sha does not match `currentHeadSha` is dropped and surfaced
 * in `excludedStale` so the GateAggregator can log + audit it.
 *
 * The reader never reaches into a foreign module's internals — it
 * talks to the public repository interfaces exposed by @cgao/db and
 * the orchestrator's review module. Tests inject in-memory stubs.
 *
 * Security notes (spec §12.10, §21):
 *
 *   - SHA binding is enforced HERE as the first line of defense. Even
 *     if a downstream caller forgets to re-check, a stale signal never
 *     reaches the GateEvaluation output.
 *   - Findings marked blocking+open MUST be reported red regardless of
 *     severity (the security runner refuses to downgrade blocking).
 */

import type { ReviewFindingRepo } from '../review/review-finding-repo.js';
import type {
  GateKind,
  GateEvaluation,
  Sha,
} from './types.js';

/**
 * Per-PR approval signal recorded by the human-review path.
 * `headSha` is the sha the approval was recorded against; an approval
 * against an older sha is stale and is treated as a missing gate.
 */
export interface HumanApprovalRecord {
  actor: string;
  /** sha the maintainer approved. MUST equal current head to count. */
  headSha: Sha;
  /** ISO timestamp the approval was recorded at. */
  approvedAt: string;
  /** Optional source comment / approval id reference. */
  sourceRef?: string;
}

export interface HumanApprovalLookup {
  findLatest(args: { prNumber: number }): Promise<HumanApprovalRecord | null>;
}

/** Risk classification for the PR — produced by the deterministic classifier. */
export interface RiskClassificationRecord {
  runId: string;
  headSha: Sha;
  /** Severity bucket, mirrors cgao_v3 §12.11. */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** True iff the policy requires human review at this severity. */
  requiresHumanReview: boolean;
}

export interface RiskClassificationLookup {
  find(args: { runId: string }): Promise<RiskClassificationRecord | null>;
}

/** Test-gate (fast-gate) summary — the persisted GateResult's rolled-up form. */
export interface TestGateRecord {
  runId: string;
  headSha: Sha;
  baseSha: Sha;
  passed: boolean;
  /** `sha256:...` artifact ref backing the gate log. */
  logArtifactRef: string;
}

export interface TestGateLookup {
  findLatest(args: { runId: string }): Promise<TestGateRecord | null>;
}

/** AI-review (code + security) summary. */
export interface AiReviewRecord {
  runId: string;
  headSha: Sha;
  /** Reviewer class — 'code' | 'security'. */
  reviewer: 'code' | 'security';
  /** True iff the review was performed (findings may be present). */
  completed: boolean;
  /** Ref to the persisted review_result artifact. */
  reviewArtifactRef: string;
}

export interface AiReviewLookup {
  list(args: { runId: string }): Promise<readonly AiReviewRecord[]>;
}

/** Injectable bundle of all the lookups the reader needs. */
export interface GateResultsReaderDeps {
  testGates: TestGateLookup;
  aiReviews: AiReviewLookup;
  humanApprovals: HumanApprovalLookup;
  risk: RiskClassificationLookup;
  findings: Pick<ReviewFindingRepo, 'findBlocking'>;
}

export interface ReadGateResultsInput {
  runId: string;
  prNumber: number;
  currentHeadSha: Sha;
  currentBaseSha: Sha;
}

export interface ReadGateResultsOutput {
  /** Evaluations, keyed by kind. SHA-mismatched signals are EXCLUDED here. */
  evaluations: Partial<Record<GateKind, GateEvaluation>>;
  /** Signals dropped because their headSha ≠ currentHeadSha. */
  excludedStale: { kind: GateKind; reason: string }[];
}

/**
 * Pull every gate signal, SHA-bind, and report stale signals.
 *
 * Note on `baseSha`: the fast-gate log carries a base sha and we honor
 * it (mismatched base → stale for test gate). Human approval does not
 * carry a meaningful base sha today; we accept any base there.
 */
export class GateResultsReader {
  constructor(private readonly deps: GateResultsReaderDeps) {}

  async read(input: ReadGateResultsInput): Promise<ReadGateResultsOutput> {
    const excludedStale: { kind: GateKind; reason: string }[] = [];
    const evaluations: Partial<Record<GateKind, GateEvaluation>> = {};

    // 1. Test gate.
    const test = await this.deps.testGates.findLatest({ runId: input.runId });
    if (!test) {
      evaluations.test = {
        kind: 'test',
        passed: false,
        reason: 'no test-gate result recorded for this run',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else if (test.headSha !== input.currentHeadSha || test.baseSha !== input.currentBaseSha) {
      excludedStale.push({
        kind: 'test',
        reason: `test gate head/base mismatch: recorded=${test.headSha.slice(
          0,
          10,
        )}/${test.baseSha.slice(0, 10)} current=${input.currentHeadSha.slice(0, 10)}/${input.currentBaseSha.slice(0, 10)}`,
      });
      evaluations.test = {
        kind: 'test',
        passed: false,
        reason: 'test gate signal is stale (head/base mismatch)',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else {
      evaluations.test = {
        kind: 'test',
        passed: test.passed,
        reason: test.passed ? 'lint + typecheck + unit passed' : 'one or more test gates failed',
        evidenceRefs: [test.logArtifactRef],
        headSha: test.headSha,
        baseSha: test.baseSha,
      };
    }

    // 2. AI review — require BOTH code and security reviewer to have run
    //    at the current head sha.
    const reviews = await this.deps.aiReviews.list({ runId: input.runId });
    const atHead = reviews.filter((r) => r.headSha === input.currentHeadSha);
    const staleReviews = reviews.filter((r) => r.headSha !== input.currentHeadSha);
    for (const s of staleReviews) {
      excludedStale.push({
        kind: 'ai_review',
        reason: `${s.reviewer} review at stale head ${s.headSha.slice(0, 10)}`,
      });
    }
    const codeReview = atHead.find((r) => r.reviewer === 'code');
    const secReview = atHead.find((r) => r.reviewer === 'security');
    const codeOk = codeReview?.completed ?? false;
    const secOk = secReview?.completed ?? false;
    evaluations.ai_review = {
      kind: 'ai_review',
      passed: codeOk && secOk,
      reason: codeOk && secOk
        ? 'code + security reviewers passed at current head'
        : `ai review incomplete (code=${codeOk}, security=${secOk})`,
      evidenceRefs: [codeReview?.reviewArtifactRef, secReview?.reviewArtifactRef].filter(
        (x): x is string => typeof x === 'string',
      ),
      headSha: input.currentHeadSha,
      baseSha: input.currentBaseSha,
    };

    // 3. Human review (maintainer approval) — bound to headSha.
    const approval = await this.deps.humanApprovals.findLatest({ prNumber: input.prNumber });
    if (!approval) {
      evaluations.human_review = {
        kind: 'human_review',
        passed: false,
        reason: 'no maintainer approval recorded',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else if (approval.headSha !== input.currentHeadSha) {
      excludedStale.push({
        kind: 'human_review',
        reason: `approval at stale head ${approval.headSha.slice(0, 10)}`,
      });
      evaluations.human_review = {
        kind: 'human_review',
        passed: false,
        reason: 'maintainer approval is stale (force-push since)',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else {
      evaluations.human_review = {
        kind: 'human_review',
        passed: true,
        reason: `approved by ${approval.actor} at current head`,
        evidenceRefs: approval.sourceRef ? [approval.sourceRef] : [],
        headSha: approval.headSha,
      };
    }

    // 4. Risk policy — required for human-review-required classification.
    const risk = await this.deps.risk.find({ runId: input.runId });
    if (!risk) {
      evaluations.risk_policy = {
        kind: 'risk_policy',
        passed: false,
        reason: 'no risk classification recorded for this run',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else if (risk.headSha !== input.currentHeadSha) {
      excludedStale.push({
        kind: 'risk_policy',
        reason: `risk classification at stale head ${risk.headSha.slice(0, 10)}`,
      });
      evaluations.risk_policy = {
        kind: 'risk_policy',
        passed: false,
        reason: 'risk classification is stale (head mismatch)',
        evidenceRefs: [],
        headSha: input.currentHeadSha,
      };
    } else {
      const humanOk = !risk.requiresHumanReview || evaluations.human_review?.passed === true;
      evaluations.risk_policy = {
        kind: 'risk_policy',
        passed: humanOk,
        reason: humanOk
          ? `risk=${risk.severity} (human-review requirement satisfied)`
          : `risk=${risk.severity} requires human review at current head`,
        evidenceRefs: [],
        headSha: risk.headSha,
      };
    }

    // 5. Security findings — blocking, OPEN findings at the current head
    //    are red. Findings bound to an old head sha are stale and dropped.
    const blocking = await this.deps.findings.findBlocking(input.prNumber);
    const atHeadBlocking = blocking.filter((b) => b.headSha === input.currentHeadSha);
    const staleBlocking = blocking.filter((b) => b.headSha !== input.currentHeadSha);
    for (const s of staleBlocking) {
      excludedStale.push({
        kind: 'security_findings',
        reason: `blocking finding ${s.id} at stale head ${s.headSha.slice(0, 10)}`,
      });
    }
    evaluations.security_findings = {
      kind: 'security_findings',
      passed: atHeadBlocking.length === 0,
      reason:
        atHeadBlocking.length === 0
          ? 'no blocking security findings open at current head'
          : `${atHeadBlocking.length} blocking finding(s) unresolved at current head`,
      evidenceRefs: atHeadBlocking.map((b) => b.id),
      headSha: input.currentHeadSha,
    };

    return { evaluations, excludedStale };
  }
}
