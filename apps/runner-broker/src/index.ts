/**
 * @cgao/runner-broker — public surface.
 *
 * Re-exports the M5 modules used by the security regression suite
 * (T-M5-009) and by the orchestrator when it wires the broker into
 * the dispatch path. Internal helpers stay under their submodules.
 */

export { PromptLoader, ArtifactResolutionError, ARTIFACT_URI_RE } from './cca/prompt-loader.js';
export type { ResolvedArtifact } from './cca/prompt-loader.js';

export {
  JOB_LABELS,
  CCA_COMMANDS,
  isJobLabel,
  ccaCommandFor,
} from './profiles/job-label.js';
export type { JobLabel, CcaCommand } from './profiles/job-label.js';

export {
  CredentialProfile,
  CredentialProfileService,
  TRUSTED_REQUIRED_ENV,
  UNTRUSTED_ALLOWED_ENV,
  isTrusted,
  isForbiddenKey,
} from './profiles/credential-profile.js';
export type { ResolvedProfile } from './profiles/credential-profile.js';

export { FORBIDDEN_RUNNER_ENV_KEYS, scrubRunnerEnv } from './profiles/env-scrubber.js';
export {
  NoSecretExecutionProfile,
  runTokenPresenceTest,
  serializeEnv,
} from './profiles/token-presence-test.js';
export type {
  TokenPresenceResult,
  TokenPresenceViolation,
} from './profiles/token-presence-test.js';

export {
  PathWritePolicy,
  normalizePath,
  hasTraversal,
  matchesGlob,
} from './sandbox/path-write-policy.js';
export type {
  PolicyCheck,
  PolicyDecision,
  PathWritePolicyOptions,
} from './sandbox/path-write-policy.js';
export { WriteOverlay } from './sandbox/write-overlay.js';
export type { OverlayEntry, DeniedWrite } from './sandbox/write-overlay.js';
export { defineReadOnlyBase } from './sandbox/read-only-base.js';
export type { ReadOnlyBase } from './sandbox/read-only-base.js';

export { exportPatch } from './sandbox/patch-exporter.js';
export type { ExportedPatch } from './sandbox/patch-exporter.js';
export { validatePatch } from './sandbox/patch-validator.js';
export type {
  PatchValidationInput,
  PatchValidationResult,
} from './sandbox/patch-validator.js';
export {
  applyToCleanCheckout,
  detectDirtyWorkspace,
} from './sandbox/clean-checkout-applier.js';
export type { ApplyInput, ApplyResult } from './sandbox/clean-checkout-applier.js';

export {
  ProtectedFileDetector,
  DEFAULT_PROTECTED_FILE_PATTERNS,
} from './policy/protected-file-detector.js';
export {
  RiskEscalationHook,
  maxSeverity as maxRiskSeverity,
} from './policy/risk-escalation-hook.js';
export type {
  RiskSeverity,
  ClassifierOutput,
  RiskClassifierLike,
  EscalationResult,
} from './policy/risk-escalation-hook.js';

export { runDevTask, InMemoryPatchAggregator } from './dev/development-module.js';
export type {
  DevPlan,
  DevHandoff,
  ExecutorTaskResult,
  PatchAggregator,
  WorkerResultArtifact,
  RunDevTaskInput,
  RunDevTaskOutput,
} from './dev/development-module.js';

// M6 — fast gate + test/fix loop (T-M6-001..005)
export { FastGateRunner, DEFAULT_GATE_ADAPTERS } from './gate/fast-gate-runner.js';
export type {
  FastGateRunInput,
  GateAdapterSpec,
  GateCommandExecutor,
} from './gate/fast-gate-runner.js';
export { scrubGateLog } from './gate/log-scrubber.js';
export type { ScrubbedLog } from './gate/log-scrubber.js';
export type {
  AdapterRunResult,
  GateAdapter,
  GateLogArtifact,
  GateLogArtifactBody,
  GateName,
  GateResult,
  PerAdapterResults,
  Sha,
} from './gate/types.js';

// T-M6-002 failure fingerprint
export { FingerprintService, normalizeFilePath } from './gate/fingerprint.js';
export type { Fingerprint, FingerprintInput } from './gate/fingerprint.js';
export { normalizeMessage, parseFailures } from './gate/failure-parser.js';
export type { FailureSpan } from './gate/failure-parser.js';
