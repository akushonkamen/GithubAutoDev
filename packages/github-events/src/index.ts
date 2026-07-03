/**
 * @cgao/github-events — GitHub webhook → CloudEvents mapper (T-M1-003).
 *
 * Spec §10. Translates raw GitHub webhook payloads into CGAO's
 * CloudEvents-style envelope. Each mapper accepts the raw payload
 * (already signature-verified) and the original webhook headers
 * (for trace id / delivery id) and returns a typed envelope.
 *
 * Mapping is pure — no I/O. Side effects (publish, audit) live at
 * the orchestrator layer.
 */

export {
  type CloudEventEnvelope,
  type GithubWebhookHeaders,
  mapGithubEvent,
  UnsupportedEventTypeError,
} from './mapper.js';
export {
  issueOpenedSchema,
  issueCommentCreatedSchema,
  pullRequestSynchronizeSchema,
  workflowRunCompletedSchema,
  issuesLabeledSchema,
} from './schemas.js';
export {
  type IssueSnapshot,
  type IssueSnapshotInput,
  type MaterialChangeResult,
  canonicalIssueBody,
  detectMaterialChange,
  isStale,
  snapshotIssue,
} from './snapshot.js';
