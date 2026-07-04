export { default as app } from './server.js';
export { parseConfig } from './config/loader.js';

// Re-export modules used by cross-app test suites (security/concurrency).
export * from './modules/branches/branch-service.js';
export * from './modules/branches/naming-policy.js';
export * from './modules/commits/commit-builder.js';
export * from './modules/commits/commit-message-renderer.js';
export * from './modules/prs/pull-request-service.js';
export * from './modules/prs/pr-marker.js';
export * from './modules/prs/pr-body-renderer.js';
export * from './modules/prs/traceability-block.js';
export * from './modules/policy/dependency-change-detector.js';
export * from './modules/policy/sca-hook.js';
export * from './modules/merge/index.js';
// Re-export spec + intake + review modules so cross-app e2e/security
// tests can construct artifacts (RequirementSpec, ImplementationPlan,
// Handoff) and drive reviewers without reaching into deep paths.
export * from './modules/specs/requirement-spec.js';
export * from './modules/specs/implementation-plan.js';
export * from './modules/specs/handoff.js';
export * from './modules/specs/plan-comment.js';
export * from './modules/specs/risk-classifier.js';
export * from './modules/intake/classifier.js';
export * from './modules/intake/clarifier.js';
export * from './modules/intake/issuer.js';
export * from './modules/intake/envelope.js';
export * from './modules/review/review-runner.js';
export * from './modules/review/security-review-runner.js';
export * from './modules/review/review-result.js';
export * from './modules/review/review-finding-repo.js';
export * from './modules/review/reviewer-context-builder.js';
