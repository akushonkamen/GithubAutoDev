/**
 * Merge module public surface — T-M9-001..006, spec §12.10.
 *
 * Re-exports the merge-module pieces consumed by the orchestrator and
 * by the security/concurrency regression suites.
 */

export { GateAggregator } from './gate-aggregator.js';
export {
  GateResultsReader,
  type AiReviewLookup,
  type AiReviewRecord,
  type HumanApprovalLookup,
  type HumanApprovalRecord,
  type RiskClassificationLookup,
  type RiskClassificationRecord,
  type TestGateLookup,
  type TestGateRecord,
} from './gate-results-reader.js';
export {
  GitHubStateHydrator,
  type BranchProtectionSnapshot,
  type LivePrSnapshot,
  type TrustedGitHubPrPort,
} from './github-state-hydrator.js';
export {
  IssueCloseService,
  DEFAULT_CGAO_LABELS,
  type IssueClosePort,
  type IssueCloseResult,
} from './issue-close-service.js';
export { BranchProtectionChecker } from './branch-protection-checker.js';
export {
  MergeFinalEvaluator,
  type BaseAdvancedPolicy,
  type EvaluateInput,
  type EvaluateResult,
  type MergeFinalEvaluatorDeps,
} from './merge-final-evaluator.js';
export {
  MERGE_TOKEN_FORBIDDEN_SCOPES,
  MERGE_TOKEN_REQUIRED_SCOPES,
  validateMergeTokenProfile,
  type MergeTokenProfile,
} from './merge-credential-profile.js';
export { renderMergeReadyBody, type RenderMergeReadyInput } from './merge-ready-renderer.js';
export {
  MergeService,
  type MergeExecutionPort,
  type MergeResult,
} from './merge-service.js';
export {
  PolicyDecisionWriter,
  type PolicyDecisionRecord,
  type PolicyDecisionRepository,
} from './policy-decision-writer.js';
export {
  StatusCommentUpdater,
  type PrComment,
  type StatusCommentBroker,
} from './status-comment-updater.js';
export {
  DEFAULT_QUEUE_DECLARATIONS,
  MergeQueueAdapter,
  type MergeQueueEvent,
  type MergeQueuePort,
  type MergeQueueRunResult,
  type RequiredCheckDeclaration,
} from './merge-queue-adapter.js';
export {
  MergeGroupHandler,
  type MergeGroupHandlerDeps,
  type MergeGroupHandleResult,
} from './merge-group-handler.js';
export type {
  AggregateInput,
} from './gate-aggregator.js';
export type {
  AggregatedGates,
  GateEvaluation,
  GateKind,
  MergeDecision,
  MergeDecisionKind,
  Sha,
} from './types.js';
